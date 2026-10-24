# 时间建模

时间字段是出错率最高的一类建模：时区解释、夏令时切换、有效期区间，每一处都可能产生"差一小时""重复记录"这类难以追溯的 bug。本篇给出一套能在生产站住的约定：库里只存 `timestamptz`（绝对时刻，内部即 UTC），展示层做时区转换；有效期这类区间语义用 `tstzrange` 加 EXCLUDE 约束表达。

## timestamptz 与 UTC 原则

`timestamptz`（`timestamp with time zone`）并不存储时区，它存储的是**一个绝对时刻**：输入时把字符串按会话时区解释成 UTC 时间线上的一个点，输出时再按会话时区渲染。所以同一个值在不同会话里显示不同：

```sql
SET timezone = 'Asia/Shanghai';
SELECT '2026-03-01 12:00:00'::timestamptz;
-- 2026-03-01 12:00:00+08

SET timezone = 'UTC';
SELECT '2026-03-01 12:00:00'::timestamptz;
-- 2026-03-01 12:00:00+00    ← 同一字符串，但这已经是另一个时刻
```

由此得出原则：**列类型一律 `timestamptz`，库里存绝对时刻（内部即 UTC），时区转换放在展示层**。应用按用户时区渲染，或会话里 `SET timezone` 后由数据库渲染。不要为了让界面显示"北京时间"就把服务器时区、会话时区到处改——那是把展示逻辑混进存储层。

## timestamp without time zone 的坑

`timestamp`（without time zone）存的是"墙上时间"字面量，数据库不做任何时区解释。两个问题：

```sql
SELECT '2026-03-08 02:30:00'::timestamp;
-- 只是一个墙上时间，无法知道它对应哪个绝对时刻

SELECT '2026-03-08 02:30:00'::timestamp
       AT TIME ZONE 'America/New_York';   -- 显式给定时区后才能换算成绝对时刻
```

其一，多时区写入方会写出互相矛盾的值：上海写入的 `12:00` 和纽约写入的 `12:00` 是相差 12 小时的两个时刻，落在同一列里无法区分。其二，夏令时切换点的墙上时间本身有歧义——美国 2026 年 3 月 8 日 02:00 进入夏令时，当天纽约的 `02:30` 这个墙上时间**并不存在**；反过来秋季回拨时，`01:30` 会出现两次。只有把绝对时刻存下来（`timestamptz`），这类问题才有确定的答案。

## 时区与夏令时的处理

- **时区用 IANA 名称**（`'Asia/Shanghai'`、`'America/New_York'`），不要用固定偏移（`'+08:00'`）——偏移不随夏令时变化，用它转换跨 DST 的日期必错。
- `AT TIME ZONE` 是双向转换运算符，方向由操作数类型决定：

  ```sql
  SELECT now() AT TIME ZONE 'Asia/Shanghai';
  -- timestamptz → timestamp：得到上海的墙上时间

  SELECT '2026-03-01 08:00'::timestamp AT TIME ZONE 'America/New_York';
  -- timestamp → timestamptz：墙上时间 + 时区 = 绝对时刻
  ```

- **按天聚合统计时先转用户时区再截断**，否则"每天"的边界是 UTC 零点而不是用户感知的零点：

  ```sql
  SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai') AS day,
         count(*)
  FROM orders
  GROUP BY 1 ORDER BY 1;
  ```

更多日期函数与时区细节见官方文档[日期/时间类型](https://www.postgresql.org/docs/current/datatype-datetime.html)与[函数参考](https://www.postgresql.org/docs/current/functions-datetime.html)。

## 有效期用 tstzrange 表达

价格生效期、会员有效期、预订时段这类"从某刻到某刻"的业务，不要用 `valid_from`/`valid_to` 两列加一堆边界比较，直接用区间类型：

```sql
CREATE TABLE price_rules (
  id     bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku    text          NOT NULL,
  price  numeric(10,2) NOT NULL CHECK (price >= 0),
  during tstzrange     NOT NULL DEFAULT tstzrange(now(), NULL)  -- NULL 上界=不限期
);
```

关键在**边界约定**：区间类型默认 `'[)'` 左闭右开——起点有效、终点无效。这样相邻两段 `['03-01','04-01')` 和 `['04-01','05-01')` 正好衔接又不重叠；若用全闭 `'[]'`，端点 `04-01 00:00` 会同时属于两段。开放/闭区间的完整语义见官方[范围类型](https://www.postgresql.org/docs/current/rangetypes.html)文档，操作符细节见 [范围类型与 EXCLUDE](/zh/advanced-sql/range-types-and-exclude)。

防重叠靠 EXCLUDE 约束（数据库强制的"广义唯一"）：

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- 让 GiST 支持 text 等值

ALTER TABLE price_rules ADD CONSTRAINT price_rules_no_overlap
  EXCLUDE USING gist (sku WITH =, during WITH &&);

INSERT INTO price_rules (sku, price, during)
VALUES ('A1', 99.00, tstzrange('2026-03-01', '2026-04-01'));   -- OK

INSERT INTO price_rules (sku, price, during)
VALUES ('A1', 89.00, tstzrange('2026-03-15', '2026-05-01'));
-- ERROR: conflicting key value violates exclusion constraint "price_rules_no_overlap"
```

同一 SKU 的价格段一旦重叠即被拒绝，不再依赖应用层先查后插（并发下先查后插必漏）。

## 「当前有效」的查询与索引

```sql
-- 写法一：包含判断，配 GiST 索引
SELECT * FROM price_rules
WHERE sku = 'A1' AND during @> now();

-- 写法二：valid_from/valid_to 两列的等价写法，btree 友好
SELECT * FROM price_rules_v2
WHERE sku = 'A1'
  AND valid_from <= now()
  AND (valid_to IS NULL OR valid_to > now());
```

写法一在 `(sku, during)` 上建 GiST 索引：`CREATE INDEX price_rules_sku_during_idx ON price_rules USING gist (sku, during);`。写法二用普通复合索引 `(sku, valid_from)` 即可。两种建模都可以，选一种全团队统一；区间写法的优势是与 EXCLUDE 约束、重叠运算符（`&&`）天然配套。

## 审计快照模式

需要保留历史版本的维度数据（价格、组织架构、会员等级），用 `valid_from`/`valid_to` 双列把每次变更记成一行区间（即 SCD2 模式），查询历史时用 `during @> 某时刻` 定位当时版本——索引、约束、查询写法与上文完全一致，只是区间由系统在变更时自动封口。实现细节与触发器维护方式见 [约束与数据质量](/zh/database-design/constraints-and-data-quality)。

## 参考资料

- [PostgreSQL 官方文档 · 5.5. Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
- [PostgreSQL 官方文档 · 5.12. Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [数据类型概览](/zh/basics/data-types-overview)
- [范围类型与 EXCLUDE](/zh/advanced-sql/range-types-and-exclude)
- [约束与数据质量](/zh/database-design/constraints-and-data-quality)
- [TimescaleDB](/zh/ecosystem/timescaledb)
- [range-types-and-exclude](/zh/advanced-sql/range-types-and-exclude)
- [data-types-overview](/zh/basics/data-types-overview)
- [naming-and-style-conventions](/zh/basics/naming-and-style-conventions)
- [anti-patterns](/zh/database-design/anti-patterns)
- [constraints-and-data-quality](/zh/database-design/constraints-and-data-quality)
- [index](/zh/database-design/index)
- [logical-to-physical-modeling](/zh/database-design/logical-to-physical-modeling)
- [money-and-numeric](/zh/database-design/money-and-numeric)
- [table-inheritance-and-partitioning-design](/zh/database-design/table-inheritance-and-partitioning-design)
- [timescaledb](/zh/ecosystem/timescaledb)