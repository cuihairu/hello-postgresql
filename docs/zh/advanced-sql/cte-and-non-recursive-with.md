# CTE 与非递归 WITH

WITH 子句在一条语句里定义若干个命名的临时结果集（CTE，Common Table Expression），主查询把它们当表来引用。CTE 大多能改写成子查询，真正的价值在于：把多层嵌套的 SQL 拆成平铺的命名步骤，让复杂查询可以按步骤阅读、复用中间结果，并在一条语句内原子地完成「先写后读」的组合操作。

## 基本形态

本页示例数据：

```sql
CREATE TABLE orders (
    id         serial PRIMARY KEY,
    region     text NOT NULL,
    amount     numeric(10,2) NOT NULL,
    status     text NOT NULL DEFAULT 'pending',
    created_at date NOT NULL
);

INSERT INTO orders (region, amount, created_at) VALUES
    ('华北', 1200, '2026-01-05'),
    ('华北', 800,  '2026-02-10'),
    ('华东', 2000, '2026-01-18'),
    ('华东', 1500, '2026-02-22'),
    ('华南', 300,  '2026-03-01');
```

最简单的用法：一个 CTE，主查询引用一次。

```sql
WITH region_stats AS (
    SELECT region, count(*) AS cnt, sum(amount) AS total
    FROM orders
    GROUP BY region
)
SELECT region, total, round(total / cnt, 2) AS avg_per_order
FROM region_stats
ORDER BY total DESC;
```

语法要点：

- `名字 AS (查询)` 定义一个 CTE，多个 CTE 之间用逗号分隔。
- CTE 只在本条语句内可见，语句结束即消失，不是临时表。
- CTE 可以带列名列表：`WITH t (a, b) AS (SELECT ...)`，用于给输出列统一命名。
- CTE 名与真实表同名时 CTE 优先（遮蔽表）。

## 多个 CTE 相互引用

后面的 CTE 可以引用前面定义的 CTE，像管道一样逐层加工：

```sql
WITH region_month AS (
    SELECT region,
           date_trunc('month', created_at)::date AS month,
           sum(amount) AS total
    FROM orders
    GROUP BY 1, 2
),
region_avg AS (
    SELECT region, avg(total) AS avg_month_total
    FROM region_month          -- 引用上一个 CTE
    GROUP BY region
)
SELECT rm.region, rm.month, rm.total, ra.avg_month_total,
       round(rm.total - ra.avg_month_total, 2) AS diff
FROM region_month rm
JOIN region_avg ra USING (region)
ORDER BY rm.region, rm.month;
```

## 用 CTE 改写嵌套查询

需求：找出月总额高于全表月均值的「地区-月份」。子查询写法要把内层聚合逻辑写两遍，改动时得同步两处：

```sql
SELECT region, month, total
FROM (
    SELECT region, date_trunc('month', created_at)::date AS month,
           sum(amount) AS total
    FROM orders GROUP BY 1, 2
) m
WHERE total > (
    SELECT avg(total)
    FROM (SELECT sum(amount) AS total
          FROM orders GROUP BY date_trunc('month', created_at)) t
);
```

CTE 版只写一遍，按步骤可读：

```sql
WITH region_month AS (
    SELECT region, date_trunc('month', created_at)::date AS month,
           sum(amount) AS total
    FROM orders GROUP BY 1, 2
),
month_avg AS (
    SELECT avg(total) AS avg_total FROM region_month
)
SELECT rm.region, rm.month, rm.total
FROM region_month rm, month_avg ma
WHERE rm.total > ma.avg_total;
```

改写原则：每抽出一个 CTE 就给它一个「说明这一步在干什么」的名字；同一段逻辑出现两次以上时，优先抽成 CTE。

## PG 12 起：内联与 MATERIALIZED

PG 12 之前，所有 CTE 都先算完、物化成中间结果再被主查询读取，相当于一道优化屏障，主查询的过滤条件推不进去。PG 12 起改为默认内联：满足以下全部条件的 CTE 会被展开成普通子查询参与整体优化——非递归、无副作用（不含数据修改和 volatile 函数）、在语句中只被引用一次、未显式声明 MATERIALIZED。

两个方向都可以强制：

```sql
-- 强制物化：多次引用也只算一次；代价是条件下推不进去
WITH big AS MATERIALIZED (
    SELECT region, amount FROM orders WHERE amount > 1000
)
SELECT b.region, b.amount, s.avg_amount,
       round(b.amount - s.avg_amount, 2) AS diff
FROM big b
CROSS JOIN (SELECT avg(amount) AS avg_amount FROM big) s;

-- 强制内联：即使多次引用也展开，外层条件能推到表扫描；代价是可能算多次
WITH big AS NOT MATERIALIZED (
    SELECT region, amount FROM orders WHERE amount > 1000
)
SELECT * FROM big WHERE region = '华东';
```

选择依据：

- 昂贵且被引用多次：保持物化（多次引用时默认即物化），保证只算一次。
- 只引用一次、外层还有过滤：用默认内联，让条件推下去走索引。
- 单引用但仍想固定算一次（如 CTE 里有 LIMIT 之类「取到即止」的语义）：显式 MATERIALIZED。

数据修改 CTE（内含 INSERT/UPDATE/DELETE）永远不会被内联。用 EXPLAIN 可以验证内联与否：内联后计划中 CTE 消失、条件出现在表扫描节点上，物化则能看到 CTE Scan 节点，详见 [EXPLAIN 基础](/zh/performance/explain-basics)。

## 一条语句里读和写：数据修改 CTE

CTE 里放带 RETURNING 的写语句，主查询读取其输出，可以原子地完成「删完立刻汇总」这类操作：

```sql
CREATE TABLE sessions (
    id          serial PRIMARY KEY,
    user_id     int NOT NULL,
    last_active date NOT NULL
);

INSERT INTO sessions (user_id, last_active) VALUES
    (1, '2026-01-10'), (1, '2026-02-01'), (2, '2026-03-05'), (3, '2025-12-20');

WITH removed AS (
    DELETE FROM sessions
    WHERE last_active < date '2026-03-01' - interval '30 days'
    RETURNING user_id
)
SELECT user_id, count(*) AS cleaned_sessions
FROM removed
GROUP BY user_id;
```

规则与限制：

- 主查询读到的是 RETURNING 的输出，而不是目标表的新状态。
- 同一 WITH 里的多个数据修改子语句以同一快照并发执行，互相看不到对方对表的改动。
- 无论主查询是否读取其输出，数据修改子语句都会完整执行一次，不受主查询 LIMIT 影响。
- 两个子语句试图修改同一行会直接报错。

## 注意事项与常见坑

- 沿用 PG 12 前的经验把 CTE 当优化屏障：新版本对单引用 CTE 已默认内联，屏障失效；反过来给多次引用的 CTE 加 NOT MATERIALIZED 可能导致重复计算，务必 EXPLAIN 确认。
- 数据修改 CTE 之间互相不可见：`WITH u AS (UPDATE ... RETURNING ...) SELECT * FROM 目标表` 读到的是旧值，要读新状态请改用 u 的 RETURNING 输出。
- CTE 名遮蔽同名真实表：排查「查出来的数据不对」时先看 WITH 区有没有同名定义。
- CTE 解决的是可读性，不是性能：内联之后 CTE 和子查询计划相同，别为「提速」盲目套 CTE。

## 参考资料

- [PostgreSQL 官方文档 · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL 官方文档 · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [递归 CTE](/zh/advanced-sql/recursive-cte)
- [子查询家族](/zh/advanced-sql/subquery-family)
- [EXPLAIN 基础](/zh/performance/explain-basics)
- [批量与写入](/zh/advanced-sql/batch-and-write)
- [index](/zh/advanced-sql/index)
- [lateral-and-from-subquery](/zh/advanced-sql/lateral-and-from-subquery)
- [recursive-cte](/zh/advanced-sql/recursive-cte)
- [subquery-family](/zh/advanced-sql/subquery-family)
- [window-functions](/zh/advanced-sql/window-functions)
- [views-and-updatable-views](/zh/database-design/views-and-updatable-views)
官方文档：[WITH 查询（CTE）](https://www.postgresql.org/docs/current/queries-with.html)、[SELECT 语法与 WITH 子句](https://www.postgresql.org/docs/current/sql-select.html)。
