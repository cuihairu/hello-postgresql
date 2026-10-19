# 常见踩坑

这一页收集的是**语义层面**最常踩的坑：它们大多不会报错，而是默默返回"看似合理"的错误结果，等业务数据已经脏了才被发现。每一条都给出可复现的最小示例与修复方法。与语法/权限相关的报错排查见 [常见报错与排障](../appendix/common-errors-and-troubleshooting)。

## 大小写折叠：建出 `"Name"` 表后裸名访问报错

未加引号的标识符会折叠为小写，加了双引号则原样保留。用双引号建表是坑的起点：

```sql
CREATE TABLE "Users" ("Id" int);       -- 目录里就是 Users / Id

SELECT * FROM Users;                   -- ERROR: relation "users" does not exist
SELECT * FROM "Users";                 -- OK，之后每处都得带引号
```

修复方式是重建为小写表并迁移数据：

```sql
BEGIN;
CREATE TABLE users (id int);
INSERT INTO users (id) SELECT "Id" FROM "Users";
DROP TABLE "Users";
COMMIT;
```

规范上避免方法只有一条：标识符一律小写 snake_case，从不加引号，详见 [命名与书写规范](./naming-and-style-conventions)。

## `NULL` 比较：`= NULL` 永远为 UNKNOWN，`NOT IN` 遇 NULL 全空

`NULL` 表示"未知"，与任何值（包括它自己）用 `=` 或 `<>` 比较结果都是 `UNKNOWN`，`WHERE` 只保留 `TRUE` 的行：

```sql
CREATE TABLE t (id int, v int);
INSERT INTO t VALUES (1, 10), (2, NULL), (3, 20);

SELECT * FROM t WHERE v <> 10;      -- 只返回 id=3，id=2 被静默过滤
SELECT * FROM t WHERE v = NULL;     -- 永远空集，不是语法错误
SELECT * FROM t WHERE v IS NULL;    -- 正确写法
SELECT * FROM t WHERE v IS DISTINCT FROM 10;  -- 把 NULL 视为"不等于"的安全写法
```

更隐蔽的是 `NOT IN` 只要子查询返回任意一个 `NULL`，整个结果就是空集：

```sql
CREATE TABLE blacklist (user_id int);
INSERT INTO blacklist VALUES (999), (NULL);

-- 本意"找不在黑名单里的用户"，实际一条都不返回
SELECT id FROM users
WHERE  id NOT IN (SELECT user_id FROM blacklist);

-- 两种正确写法
SELECT id FROM users
WHERE  id NOT IN (SELECT user_id FROM blacklist WHERE user_id IS NOT NULL);

SELECT id FROM users u
WHERE  NOT EXISTS (SELECT 1 FROM blacklist b WHERE b.user_id = u.id);  -- 推荐
```

`NOT EXISTS` 不受 `NULL` 影响，也是优化器最容易走 anti join 的写法，见 [子查询家族](../advanced-sql/subquery-family)。

## 隐式类型转换与索引失效：`varchar` 列与数字比较

列类型与比较值类型不一致时，PostgreSQL 会对**列**做隐式转换，导致 B-tree 索引无法直接使用：

```sql
CREATE TABLE accounts (phone varchar(20));
CREATE INDEX accounts_phone_idx ON accounts (phone);

-- 反面示例：phone 是 varchar，与数字比较，列被转成 numeric
EXPLAIN SELECT * FROM accounts WHERE phone = 13800138000;
--  Planner: Filter: ((phone)::numeric = 13800138000)   -> Seq Scan

-- 正确：比较值写成字符串
EXPLAIN SELECT * FROM accounts WHERE phone = '13800138000';
--  Index Cond: (phone = '13800138000'::text)           -> Index Scan
```

两个方向都会转（`varchar`→`numeric` 或 `int`→`text`），但**总是转换列侧**就会放弃索引。修复办法是把字面量写成与列一致的类型，或建表达式索引 `(col::numeric)` 来匹配。类似问题也出现在 `timestamp` 列与 `date` 字符串比较上，读计划的方法见 [EXPLAIN 读法](../performance/explain-basics)。

## `timestamp without time zone` 的时区坑

`timestamp`（即 `timestamp without time zone`）不存时区，写入什么就是什么，读取也是什么；`timestamptz` 存的是 UTC 时间点，显示时按会话 `TimeZone` 转换。混用最容易产生"时间差 8 小时"的错觉：

```sql
CREATE TABLE ev (ts timestamp, tstz timestamptz);

SET timezone = 'Asia/Shanghai';
INSERT INTO ev VALUES ('2026-10-12 08:00:00', '2026-10-12 08:00:00');

SET timezone = 'UTC';
SELECT ts, tstz FROM ev;
-- ts   : 2026-10-12 08:00:00   （不变，无时区概念）
-- tstz : 2026-10-12 00:00:00+00（换算成 UTC 显示）
```

推荐**业务表一律用 `timestamptz`**，让时区转换交给数据库与驱动，而不是散落在应用代码里；只有"日历意义上的本地时间"（如门店营业时间、生日）才适合 `timestamp` + 独立的时区/偏移列。`AT TIME ZONE` 的展开规则见 [数据类型概览](./data-types-overview)。

## `count(*)` 慢：MVCC 下的可见性代价

直觉上"数行数"是 O(1)，但 PostgreSQL 里 `count(*)` 必须逐行检查元组对当前事务是否可见（每行有 `xmin/xmax`），无法像 MySQL InnoDB 那样直接取索引行数估计值：

```sql
-- 大表上要全表或全索引扫描，秒级到分钟级
SELECT count(*) FROM orders;

-- count(col) 还要额外跳过 NULL，通常比 count(*) 更慢
SELECT count(col) FROM orders;
```

缓解手段：

- 用 `pg_class.reltuples` 取统计估计值（`ANALYZE` 后接近真实，精度足够时首选）。
- 需要精确值且调用频繁时，用触发器维护计数表，或走物化视图定时刷新。
- 想判断"有没有"时用 `EXISTS`，别 `count(*) > 0`。

原理细节见 [MVCC 与多版本](../internals/mvcc-and-multi-version)。

## 忘记 WHERE 的 UPDATE / DELETE

无 `WHERE` 的 `UPDATE`/`DELETE` 会作用于全表，且提交后无法靠数据库本身撤销。防御性做法是**先用事务包住，验证行数再提交**：

```sql
BEGIN;
UPDATE orders SET status = 'archived' WHERE created_at < '2024-01-01';
-- 看返回的 UPDATE n 行数是否符合预期
ROLLBACK;          -- 不对就撤销重来；符合就 COMMIT
```

配套习惯：

- 删除前先跑等价的 `SELECT count(*)` 确认影响范围。
- 写完 `DELETE FROM t` 先停在分号前补 `WHERE`，团队 code review 强制检查。
- 生产环境考虑对 `DELETE` 开触发器或用软删字段，见 [软删除与墓碑](../database-design/soft-delete-and-tombstone)。
- 误删后若已提交，只能靠延迟从库或备份恢复，见 [备份策略](../operations/backup-strategy)。

## 除零与整除：`1/2 = 0`

PostgreSQL 的 `/` 在两个整数之间是**整除**（截断），除以 0 会直接抛错：

```sql
SELECT 1 / 2          AS int_div,     -- 0，不是 0.5
       1.0 / 2        AS numeric_div, -- 0.5
       1::numeric / 2 AS cast_div,    -- 0.5
       7 / 2 * 2      AS trick;       -- 6，不是 7！

SELECT 10 / 0;        -- ERROR: division by zero
```

修比例、均摊金额时典型翻车：`sum(amount) / count(*)` 若两边都是 `integer`/`bigint`，得到的是截断后的均值。修复：把任一侧转成 `numeric`，或用 `avg()`。防御除零用 `NULLIF` 把分母归 `NULL`，让结果安静地变 `NULL` 而非报错：

```sql
SELECT sum(amount) / NULLIF(count(*), 0)::numeric AS avg_amount
FROM   orders
WHERE  user_id = 42;
```

## 序列耗尽 integer

`serial` 默认是 `integer`，上限 2147483647（约 21.4 亿）。高频写入的表（订单、日志、事件）几年就能耗尽，届时 `nextval` 报 `nextval: reached maximum value of sequence`，插入全部失败。检查与修复：

```sql
-- 查当前序列值与类型（PG 10+）
SELECT sequencename, data_type, last_value, max_value
FROM   pg_sequences
WHERE  schemaname = 'public'
ORDER  BY last_value DESC;

-- 修复：把列与序列一起升为 bigint（重写整表，锁较重，需低峰执行）
ALTER TABLE big_table ALTER COLUMN id TYPE bigint;
ALTER SEQUENCE big_table_id_seq AS bigint;
```

新表统一用 `bigint GENERATED ALWAYS AS IDENTITY`（PG 10 起），存储成本只多 4 字节，见 [主键设计](../database-design/primary-key-design)。UUID 主键则不存在此问题，但要注意索引膨胀与写入顺序，见 [UUID 与索引](../indexing/btree-structure)。

## 注意事项与常见坑

- `NULL` 相关错误几乎都不报错，只默默返回空集或错误统计，是静默 bug 的高发区；写 `WHERE` 时先问一遍"这列会不会是 NULL"。
- 类型不匹配的坑在 `JOIN` 条件上同样存在（`int` 列 join `varchar` 列），会导致隐式转换与计划劣化。
- `count(*)`、`1/2`、`NOT IN` 三类问题的共性：**语法完全合法**，所以测试环境跑不出问题、上线后才暴露。代码评审时值得单独核对。
- 大部分坑都能靠 `EXPLAIN` 与 `\d 表名` 提前发现：看列类型、看索引、看计划，比读代码更直接。

## 参考资料

- [PostgreSQL 官方文档 · Part I. Tutorial](https://www.postgresql.org/docs/current/tutorial.html)
- [PostgreSQL 官方文档 · The SQL Language](https://www.postgresql.org/docs/current/sql.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [命名与书写规范](./naming-and-style-conventions)
- [数据类型概览](./data-types-overview)
- [EXPLAIN 读法](../performance/explain-basics)
- [常见报错与排障](../appendix/common-errors-and-troubleshooting)
- [common-errors-and-troubleshooting](/appendix/common-errors-and-troubleshooting.md)
- [functions-and-operators](functions-and-operators.md)
- [index](index.md)
- [naming-and-style-conventions](naming-and-style-conventions.md)