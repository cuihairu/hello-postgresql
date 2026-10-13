# 范围类型与 EXCLUDE

范围类型把「从某值到某值」表达成一列（如一个时间段、一个价格区间），并配套包含、重叠、相邻等操作符；再配合 EXCLUDE 约束，能把「不允许重叠」这类业务规则下沉到数据库层。典型应用是会议室预订、有效期管理、IP 段分配。这一页覆盖内置类型、边界语义、操作符函数，以及防重叠约束的完整写法。

## 内置范围类型

| 类型 | 元素类型 | 典型用途 |
| ---- | -------- | -------- |
| int4range | int4 | 排名区间、端口段 |
| int8range | int8 | 订单号段、ID 区间 |
| numrange | numeric | 价格区间、配额 |
| tsrange | timestamp（无时区） | 本地时间区间 |
| tstzrange | timestamptz | 跨时区的日程、预订 |
| daterange | date | 有效期、营业日 |

跨时区应用一律用 tstzrange——tsrange 不带时区，两个不同时区的「同一时刻」会存成不同的字面值。PG 14 起每类范围还有对应的 multirange（多个范围的集合），见下文 range_agg。

## 边界与字面量：默认 [)

字面量里 `[`/`]` 表示含端点，`(`/`)` 表示不含。所有范围类型的默认边界是 `[)`（左闭右开）：

```sql
SELECT '[3,7)'::int4range;      -- [3,7)：含 3，不含 7
SELECT '(3,7]'::int4range;      -- (3,7]
SELECT '[3,7]'::int4range;      -- 显示为 [3,8)：离散类型规范化为 [)
SELECT int4range(3, 7);         -- 构造函数默认 [3,7)
SELECT int4range(3, 7, '[]');   -- 显式指定边界风格

SELECT 'empty'::int4range;                          -- 空范围
SELECT '[,)'::numrange;                             -- 无界范围
SELECT '[2026-10-12 09:00+08, 2026-10-12 10:00+08)'::tstzrange;
```

离散类型（整数、日期）会把任意边界风格规范化成 `[)`：`[3,7]` 存成 `[3,8)`。连续类型（numrange、tsrange/tstzrange）不改端点。无界边界一律视为开，即使写成 `]` 也会被当 `)` 处理。

## 操作符与函数

```sql
SELECT int4range(1,5) @> 3;                     -- true：包含元素
SELECT int4range(1,5) @> int4range(2,4);        -- true：包含整个范围
SELECT int4range(1,5) <@ int4range(1,9);        -- true：被包含
SELECT int4range(1,5) && int4range(4,9);        -- true：重叠（有公共点）
SELECT int4range(1,5) -|- int4range(5,9);       -- true：相邻（紧挨着）
SELECT int4range(1,5) << int4range(5,9);        -- true：严格在左侧

SELECT lower('[3,7)'::int4range),   upper('[3,7)'::int4range);    -- 3 | 7
SELECT lower_inc('[3,7)'::int4range), upper_inc('[3,7)'::int4range); -- t | f
SELECT isempty('empty'::int4range);             -- true
SELECT range_merge(int4range(1,3), int4range(5,7));  -- [1,7)：覆盖两段的最小范围

-- PG 14 起：范围聚合成 multirange，重叠部分自动合并
SELECT range_agg(r)
FROM (VALUES ('[1,3)'::int4range), ('[2,5)'::int4range)) AS t(r);
-- {[1,5)}
```

`-|-` 判断相邻很有用：「下一班是否紧跟上一班」不要手算边界加减，直接 `-|-`。

## EXCLUDE：用约束防止重叠

会议室预订的经典需求：同一房间、时间不得重叠。EXCLUDE USING gist 用一条约束表达：

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- int 上的 GiST 等值需要它

CREATE TABLE room_bookings (
    id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    room_id   int NOT NULL,
    during    tstzrange NOT NULL,
    booked_by text NOT NULL,
    EXCLUDE USING gist (room_id WITH =, during WITH &&)
);

INSERT INTO room_bookings (room_id, during, booked_by)
VALUES (1, '[2026-10-12 09:00+08, 2026-10-12 10:00+08)', '张三');

-- 同一会议室、时间重叠 → 被拒绝
INSERT INTO room_bookings (room_id, during, booked_by)
VALUES (1, '[2026-10-12 09:30+08, 2026-10-12 11:00+08)', '李四');
-- ERROR: conflicting key value violates exclusion constraint
--        "room_bookings_room_id_during_excl"

-- 换一个会议室 → 正常
INSERT INTO room_bookings (room_id, during, booked_by)
VALUES (2, '[2026-10-12 09:30+08, 2026-10-12 11:00+08)', '李四');
```

约束含义：不存在两行满足「room_id 相等且 during 重叠」。几个要点：

- `room_id WITH =` 依赖 btree_gist 扩展提供的标量等值 GiST 操作符，缺扩展会报 `data type integer has no default operator class for access method "gist"`。
- EXCLUDE 会自动创建同名 GiST 索引，约束检查与普通查询共用它。
- 空范围与任何范围都「不重叠」（`empty && x` 恒为 false），所以空预订不会被拦截——这是特性也是坑，别让业务写入空范围。
- 约束只在单表内生效；跨表、跨分区的排他要靠应用层或分区策略另行保证。

## GiST 索引与范围查询

范围列上的 GiST 索引服务 `@>`/`<@`/`&&`/`-|-` 等全部范围操作符。上例 EXCLUDE 建出的复合索引（room_id, during）可直接服务「查某房间与某时段冲突的预订」：

```sql
-- 走 EXCLUDE 自动创建的 GiST 索引
SELECT id, booked_by
FROM room_bookings
WHERE room_id = 1
  AND during && tstzrange('2026-10-12 10:30+08', '2026-10-12 12:00+08');
```

没有 EXCLUDE 约束的表，手动建 GiST 即可：

```sql
CREATE INDEX room_bookings_during_idx ON room_bookings USING gist (during);
```

GiST 的结构与适用场景见 [GiST 索引](../indexing/gist)。

## 注意事项与常见坑

- tstzrange 与 tsrange 混用会导致「同一时刻」两种表示，业务表统一用 tstzrange。
- 离散类型的 `upper()` 返回排他值：`'[3,7]'` 规范化后是 `[3,8)`，`upper()` 得 8 不是 7；要拿 7 得 `upper(...) - 1`。
- EXCLUDE 不检查 NULL：`during` 为 NULL 的行完全不受约束，范围列加 NOT NULL。
- 相邻判断写 `-|-`，不要自己比较 `upper(a) = lower(b)`——边界开闭会让这个等式对不上。
- 范围字面量里的时间要带时区偏移（tstzrange），不带时区的字面量会按服务器时区解释，容器与本机时区不同时容易埋雷。
- 排他约束冲突报错发生在写入时，应用侧要准备把 23P01（exclusion_violation）转成友好的提示。

## 参考资料

- [PostgreSQL 官方文档 · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL 官方文档 · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [GiST 索引](../indexing/gist)
- [数组操作](./array-operations)
- [时间建模](../database-design/time-modeling)
- [CHECK 与域](../database-design/check-and-domains)
- [array-operations](array-operations.md)
- [index](index.md)
- [special-types-intro](/basics/special-types-intro.md)
- [constraints-and-data-quality](/database-design/constraints-and-data-quality.md)
- [time-modeling](/database-design/time-modeling.md)
- [postgis](/ecosystem/postgis.md)
- [postgresql-17-features](/ecosystem/postgresql-17-features.md)
- [gist](/indexing/gist.md)
官方文档：[范围类型](https://www.postgresql.org/docs/current/rangetypes.html)、[btree_gist 扩展](https://www.postgresql.org/docs/current/btree-gist.html)。
