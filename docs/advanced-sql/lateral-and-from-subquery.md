# LATERAL 与 FROM 子查询

FROM 子句里除了表，还可以放子查询（派生表）和集合返回函数；LATERAL 关键字（PG 9.3 起）进一步允许这些 FROM 项引用左侧其他 FROM 项的列，让「对左表的每一行跑一段带参数的子查询」成为一条普通 SQL。这里整理派生表、相关子查询、LATERAL 语法、每组 Top-N 的两种写法对比，以及 unnest/generate_series 的常规展开用法。

## FROM 子查询（派生表）

```sql
SELECT region, avg_total
FROM (
    SELECT region, avg(amount) AS avg_total
    FROM orders
    GROUP BY region
) t                          -- 派生表必须有别名
WHERE avg_total > 1000
ORDER BY avg_total DESC;
```

要点：

- 派生表必须有别名，否则报 `subquery in FROM must have an alias`。
- 派生表对优化器就是普通子查询，外层条件可以推进去、可以参与 JOIN 重排；PG 12 起单引用 CTE 默认内联后，与 CTE 写法计划一致（见 [CTE 与非递归 WITH](./cte-and-non-recursive-with)）。
- 「内层做聚合、外层对聚合结果再过滤」是最典型的分层用法。

## 相关子查询

不写 LATERAL 时，引用外层列的子查询只能放在 SELECT 输出列表、WHERE、JOIN ON 里，逻辑上对外层每一行求值一次：

```sql
SELECT region,
       (SELECT max(amount) FROM orders o WHERE o.region = r.region) AS max_amt
FROM (SELECT DISTINCT region FROM orders) r
ORDER BY region;
```

它的局限：输出列表里的子查询只能返回一个标量，WHERE 里的 EXISTS 只能回答真伪。想在 FROM 里就引用左边的列、还能返回多列多行，就需要 LATERAL。各类子查询的完整对比见 [子查询家族](./subquery-family)。

## LATERAL：右侧引用左侧

本页示例数据：

```sql
CREATE TABLE regions (region text PRIMARY KEY);
INSERT INTO regions VALUES ('华北'), ('华东'), ('华南'), ('东北');   -- 东北暂无订单

CREATE TABLE orders (
    id         int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    region     text NOT NULL,
    seller     text NOT NULL,
    amount     numeric(10,2) NOT NULL,
    created_at date NOT NULL
);

INSERT INTO orders (region, seller, amount, created_at) VALUES
    ('华北', '小张', 1200, '2026-03-01'),
    ('华东', '小王', 2000, '2026-03-02'),
    ('华东', '小赵', 1500, '2026-03-02'),
    ('华北', '小李', 800,  '2026-03-03'),
    ('华北', '小周', 950,  '2026-03-03'),
    ('华东', '小吴', 1100, '2026-03-04'),
    ('华北', '小张', 1400, '2026-03-05'),
    ('华南', '小钱', 900,  '2026-03-06'),
    ('华南', '小孙', 800,  '2026-03-06'),
    ('华南', '小郑', 300,  '2026-03-06');
```

每个地区取销售额前 2 名：

```sql
SELECT r.region, top.seller, top.amount
FROM regions r
CROSS JOIN LATERAL (
    SELECT o.seller, o.amount
    FROM orders o
    WHERE o.region = r.region        -- 引用左侧 regions 的列
    ORDER BY o.amount DESC
    LIMIT 2
) top
ORDER BY r.region, top.amount DESC;
```

规则：

- LATERAL 修饰的 FROM 项可以引用它左边任意 FROM 项的列；反过来不行，写反了报 `invalid reference to FROM-clause entry`。
- 求值从左到右：左侧每产出一行，右侧带着这一行的列值执行一遍，类似「参数化的相关子查询」，优化器不会跨过 LATERAL 边界重排。
- `CROSS JOIN LATERAL` 会丢弃内层无行的组（本例东北整组消失）；要保留就改 `LEFT JOIN LATERAL (...) top ON true`，东北输出一行 NULL。
- FROM 里的函数调用（如 unnest）天然隐含 LATERAL；子查询则必须显式写 LATERAL 关键字。

## 每组 Top-N：两种写法对比

同一需求也可以用窗口函数：

```sql
WITH ranked AS (
    SELECT region, seller, amount,
           row_number() OVER (PARTITION BY region ORDER BY amount DESC) AS rn
    FROM orders
)
SELECT region, seller, amount
FROM ranked
WHERE rn <= 2
ORDER BY region, rn;
```

性能直觉：

- LATERAL 版本接近「分组数 × 每组 LIMIT」的索引探测：orders 上若有 (region, amount DESC) 复合索引（见 [复合索引设计](../indexing/composite-index-design)），每组扫两行即停。分组少、索引合适、每组只要头部几行时，它明显便宜；而且内层 LIMIT 之前可以随意 JOIN、写复杂过滤，组合自由度更高。
- 窗口函数版本全表扫一遍、按分区排序一次算完所有组：分组数多、没有合适索引、或每组要的行数占比不小（如每组前一半）时更均衡。
- 拿不准就用 EXPLAIN 对比实际计划与行数估算，见 [EXPLAIN 基础](../performance/explain-basics)。

## LATERAL 展开集合返回函数

把一行里的数组、JSON 数组、字符串展开成多行，是 LATERAL 最常见的日常用法：

```sql
CREATE TABLE tickets (
    id   int PRIMARY KEY,
    tags text[]
);

INSERT INTO tickets VALUES
    (1, ARRAY['db', 'urgent']),
    (2, ARRAY['api']),
    (3, ARRAY[]::text[]);

SELECT t.id, u.tag
FROM tickets t
CROSS JOIN LATERAL unnest(t.tags) AS u(tag)
ORDER BY t.id;
```

票据 3 的 tags 是空数组，unnest 产 0 行，CROSS JOIN 下它整行消失；改成 `LEFT JOIN LATERAL unnest(t.tags) AS u(tag) ON true` 可保留该票据。

generate_series 补日历骨架，让没订单的日子也出现在报表里：

```sql
SELECT d::date AS day, count(o.id) AS order_cnt
FROM generate_series(date '2026-03-01', date '2026-03-07', interval '1 day') AS d
LEFT JOIN orders o ON o.created_at = d::date
GROUP BY d
ORDER BY d;        -- 03-07 的 order_cnt 为 0
```

## 集合返回函数一瞥

能在 FROM 里产出多行的函数统称集合返回函数（SRF）：

```sql
SELECT * FROM generate_series(1, 3);                     -- 1、2、3

SELECT tag, ordinality                                   -- 附带位置序号（PG 9.4 起）
FROM unnest(ARRAY['a', 'b', 'c']) WITH ORDINALITY AS t(tag, ordinality);

SELECT word
FROM regexp_split_to_table('a,b,c', ',') AS word;        -- a、b、c

SELECT j
FROM jsonb_array_elements('[1, 2, 3]'::jsonb) AS j;      -- 1、2、3（jsonb 类型）
```

SRF 写在 SELECT 输出列表里也能运行（一行变多行的旧风格），但新代码建议统一放 FROM 里，与 LATERAL 配合的写法更清晰、可控。

## 注意事项与常见坑

- CROSS JOIN LATERAL 静默丢组：内层可能产 0 行时（无订单的地区、空数组），想清楚要不要 LEFT JOIN + ON true。
- 内层子查询昂贵时 LATERAL 按左侧行数放大：总代价约为「左侧行数 × 内层代价」，确认内层有（关联列 + 排序列）复合索引，用 EXPLAIN ANALYZE 看每循环实际耗时。
- LATERAL 只能引用左侧：把依赖项写在右边再引用是常见笔误。
- 派生表必须起别名；函数展开多列时用 `AS t(col1, col2)` 显式命名，避免歧义。

## 参考资料

- [PostgreSQL 官方文档 · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL 官方文档 · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [窗口函数](./window-functions)
- [窗口函数进阶](./window-functions-advanced)
- [子查询家族](./subquery-family)
- [数组操作](./array-operations)
- [array-operations](array-operations.md)
- [index](index.md)
- [sql-functions-advanced](sql-functions-advanced.md)
- [subquery-family](subquery-family.md)
- [window-functions-advanced](window-functions-advanced.md)
- [join-family](/basics/join-family.md)
- [join-implementations](/internals/join-implementations.md)
- [connection-and-orm-optimization](/performance/connection-and-orm-optimization.md)
官方文档：[FROM 与 LATERAL](https://www.postgresql.org/docs/current/queries-table-expressions.html)、[集合返回函数](https://www.postgresql.org/docs/current/functions-srf.html)。
