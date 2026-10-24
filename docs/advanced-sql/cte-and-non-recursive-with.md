# CTEs and Non-Recursive WITH

The WITH clause defines several named temporary result sets (CTEs, Common Table Expressions) inside a single statement, and the main query refers to them as tables. Most CTEs can be rewritten as subqueries; the real value is that they break deeply nested SQL into flat, named steps, so complex queries can be read step by step, intermediate results get reused, and a combined "write-then-read" operation completes atomically inside one statement.

## The Basic Shape

The sample data for this page:

```sql
CREATE TABLE orders (
    id         serial PRIMARY KEY,
    region     text NOT NULL,
    amount     numeric(10,2) NOT NULL,
    status     text NOT NULL DEFAULT 'pending',
    created_at date NOT NULL
);

INSERT INTO orders (region, amount, created_at) VALUES
    ('North China', 1200, '2026-01-05'),
    ('North China', 800,  '2026-02-10'),
    ('East China', 2000, '2026-01-18'),
    ('East China', 1500, '2026-02-22'),
    ('South China', 300,  '2026-03-01');
```

The simplest usage: one CTE, referenced once by the main query.

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

Syntax essentials:

- `name AS (query)` defines a CTE; separate multiple CTEs with commas.
- A CTE is visible only within this statement; it disappears when the statement ends. It is not a temporary table.
- A CTE can carry an explicit column list: `WITH t (a, b) AS (SELECT ...)`, used to give the output columns uniform names.
- When a CTE name collides with a real table name, the CTE wins (it shadows the table).

## Multiple CTEs Referring to Each Other

A later CTE can refer to one defined earlier, processing layer by layer like a pipeline:

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
    FROM region_month          -- refers to the previous CTE
    GROUP BY region
)
SELECT rm.region, rm.month, rm.total, ra.avg_month_total,
       round(rm.total - ra.avg_month_total, 2) AS diff
FROM region_month rm
JOIN region_avg ra USING (region)
ORDER BY rm.region, rm.month;
```

## Rewriting Nested Queries with CTEs

Requirement: find the "region-month" pairs whose monthly total exceeds the average monthly total across the whole table. The subquery version forces you to write the inner aggregation logic twice, and every change has to be applied in both places:

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

The CTE version is written once and reads step by step:

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

Rewriting principle: give each CTE you extract a name that "explains what this step does"; when the same logic appears twice or more, prefer extracting it into a CTE.

## From PG 12: Inlining and MATERIALIZED

Before PG 12, every CTE was fully computed, materialized as an intermediate result, and only then read by the main query. That acted as an optimization barrier: filter conditions from the main query could not be pushed down. From PG 12 the default changed to inlining: a CTE is expanded into an ordinary subquery and takes part in whole-query optimization when all of the following hold — it is non-recursive, it has no side effects (no data-modification statements and no volatile functions), it is referenced only once in the statement, and it is not explicitly declared MATERIALIZED.

Both directions can be forced:

```sql
-- Force materialization: computed only once even with multiple references; the cost is that conditions do not push down
WITH big AS MATERIALIZED (
    SELECT region, amount FROM orders WHERE amount > 1000
)
SELECT b.region, b.amount, s.avg_amount,
       round(b.amount - s.avg_amount, 2) AS diff
FROM big b
CROSS JOIN (SELECT avg(amount) AS avg_amount FROM big) s;

-- Force inlining: expanded even with multiple references, so outer conditions reach the table scan; the cost is that it may be computed more than once
WITH big AS NOT MATERIALIZED (
    SELECT region, amount FROM orders WHERE amount > 1000
)
SELECT * FROM big WHERE region = 'East China';
```

How to choose:

- Expensive and referenced multiple times: keep it materialized (multi-reference CTEs are materialized by default), so it is computed only once.
- Referenced once, with filters still outer: use the default inlining so conditions push down and can use an index.
- Referenced once but you still want exactly one computation (for example when the CTE contains "stop when satisfied" semantics such as LIMIT): use explicit MATERIALIZED.

Data-modification CTEs (those containing INSERT/UPDATE/DELETE) are never inlined. You can verify inlining with EXPLAIN: after inlining the CTE disappears from the plan and the condition appears on the table scan node; materialized CTEs show a CTE Scan node. See [EXPLAIN basics](../performance/explain-basics).

## Reading and Writing in One Statement: Data-Modification CTEs

Put a write statement with RETURNING inside a CTE, then have the main query read its output, and you can complete operations like "delete and immediately summarize" atomically:

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

Rules and limits:

- The main query reads the RETURNING output, not the new state of the target table.
- Multiple data-modification sub-statements in the same WITH run concurrently under the same snapshot and cannot see each other's changes to tables.
- Data-modification sub-statements execute fully once whether or not the main query reads their output, and they are not affected by a LIMIT in the main query.
- If two sub-statements try to modify the same row, the statement errors out immediately.

## Caveats and Common Traps

- Carrying over pre-PG 12 assumptions and treating CTEs as optimization barriers: newer versions inline single-reference CTEs by default, so the barrier is gone; conversely, adding NOT MATERIALIZED to a multi-reference CTE can cause repeated computation, so always confirm with EXPLAIN.
- Data-modification CTEs are invisible to each other: `WITH u AS (UPDATE ... RETURNING ...) SELECT * FROM target_table` reads the old values. To read the new state, use u's RETURNING output instead.
- A CTE name shadows a real table of the same name: when debugging "the query returns wrong data," first check the WITH clause for a same-named definition.
- CTEs solve readability, not performance: once inlined, a CTE produces the same plan as a subquery, so do not wrap things in CTEs blindly in hopes of "speed."

## References

- [PostgreSQL official documentation · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL official documentation · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Recursive CTEs](./recursive-cte)
- [The Subquery Family](./subquery-family)
- [EXPLAIN basics](../performance/explain-basics)
- [Batching and Writes](./batch-and-write)
- [index](index.md)
- [lateral-and-from-subquery](lateral-and-from-subquery.md)
- [recursive-cte](recursive-cte.md)
- [subquery-family](subquery-family.md)
- [window-functions](window-functions.md)
- [views-and-updatable-views](/database-design/views-and-updatable-views.md)
Official documentation: [WITH Queries (CTEs)](https://www.postgresql.org/docs/current/queries-with.html), [SELECT syntax and the WITH clause](https://www.postgresql.org/docs/current/sql-select.html).
