# Aggregation and GROUP BY

Aggregate functions fold many rows into a single value; `GROUP BY` first splits the rows into groups, and the aggregate functions then compute per group. This page collects the five most used aggregate functions, the three forms of `COUNT`, the rules for non-aggregate columns, the split of duties between `HAVING` and `WHERE`, the behavior of NULL groups, plus entry points to conditional aggregation with `FILTER` and multi-dimensional rollups with `GROUPING SETS`.

## The example table

```sql
CREATE TABLE sales (
    id        bigserial PRIMARY KEY,
    region    text,
    category  text NOT NULL,
    amount    numeric(10,2) NOT NULL,
    sale_date date NOT NULL
);

INSERT INTO sales (region, category, amount, sale_date) VALUES
    ('North China', 'Books', 120.00, '2026-01-05'),
    ('North China', 'Books', 80.00,  '2026-01-20'),
    ('North China', 'Electronics', 3000.00,'2026-01-21'),
    ('East China', 'Books', 200.00, '2026-02-01'),
    (NULL,        'Electronics', 900.00, '2026-02-03'),
    ('East China', 'Books', 50.00,  '2026-02-10');
```

## The five common aggregate functions

`count`, `sum`, `avg`, `min`, `max` cover the vast majority of reporting needs. They share one rule: **every aggregate other than `count(*)` ignores NULL inputs**. That implies two easy-to-trip differences:

```sql
SELECT sum(amount) FROM sales WHERE category = 'Home Appliances';  -- NULL, not 0
SELECT count(*)    FROM sales WHERE category = 'Home Appliances';  -- 0
```

For a `sum` that "might cover zero rows", the habit is `coalesce(sum(amount), 0)` as a safety net. `min`/`max` also ignore NULL; `avg` is `sum/count(that column)`, and NULL rows are excluded from the denominator — if you want "treat NULL as 0 when averaging", write `avg(coalesce(amount, 0))` explicitly. The two semantics differ a great deal, so confirm the requirement before writing it.

## The three forms of COUNT

```sql
SELECT count(*)              AS row_count,     -- row count, including NULL rows
       count(region)         AS region_count,  -- rows where region is not NULL: 5
       count(DISTINCT region) AS distinct_regions  -- after dedup: 2 (North China, East China)
FROM sales;
```

`count(*)` counts rows, `count(col)` counts "rows where that column is not NULL", and `count(DISTINCT col)` counts distinct values. Whether to use `count(user_id)` or `count(*)` for "the number of users who placed an order" depends on whether you are counting order rows or users — writing the wrong one produces no error, it just quietly gives you the wrong number.

## GROUP BY semantics and the non-aggregate column rule

Every column in the SELECT list must either appear in `GROUP BY` or be wrapped in an aggregate function, otherwise you get `column must appear in the GROUP BY clause`. The rule guarantees that when each group emits one row, the non-aggregate values are determinate:

```sql
SELECT region, category, sum(amount) AS total
FROM sales
GROUP BY region, category
ORDER BY region NULLS LAST, category;
```

Two useful relaxations: `GROUP BY` may take the output column's ordinal position (`GROUP BY 1, 2`), which is handy for exploratory analysis but production SQL should name columns; and when grouping by a table's primary key, the table's other columns can be SELECTed without aggregation (functional-dependency inference, since PG 9.1) — for example, `SELECT o.id, o.status, sum(...)` grouped by `o.id` does not need `o.status` in the GROUP BY.

## HAVING vs WHERE

`WHERE` filters rows **before** grouping and cannot use aggregate functions; `HAVING` filters groups **after** grouping, and its condition may (and usually should) contain aggregates. Taking "regions with total sales above 1000" as an example:

```sql
SELECT region, sum(amount) AS total
FROM sales
WHERE sale_date >= '2026-01-01'          -- drop the unneeded rows first
GROUP BY region
HAVING sum(amount) > 1000                -- then filter on the group's aggregate value
ORDER BY total DESC;
```

Do not put a condition in `HAVING` if it can live in `WHERE`: the earlier `WHERE` filters, the less data reaches grouping and aggregation. Conversely, writing an aggregate condition in `WHERE` is a syntax error.

## Groups whose key is NULL

Unlike comparison operators, `GROUP BY` treats all NULLs as the same value — rows where `region` is NULL collapse into one group instead of vanishing individually. When you need to tell "genuinely NULL" apart from "forgot to group", you can give it a readable label with `coalesce(region, 'Unassigned')`:

```sql
SELECT coalesce(region, 'Unassigned') AS region, sum(amount) AS total
FROM sales
GROUP BY coalesce(region, 'Unassigned');
```

The earlier `ORDER BY region NULLS LAST` comes from the same problem: NULLs sort first by default (last with DESC), which usually needs explicit handling in a report.

## FILTER (WHERE ...): conditional aggregation

Since PG 9.4 there is a `FILTER` clause, so one GROUP BY can compute several measures side by side — much clearer than stuffing `CASE WHEN` inside `sum`:

```sql
SELECT category,
       count(*)                      AS all_rows,
       count(*) FILTER (WHERE amount >= 100)      AS big_orders,
       sum(amount) FILTER (WHERE region = 'North China') AS north_total
FROM sales
GROUP BY category;
```

The equivalent older form replaces `sum(amount) FILTER` with `sum(CASE WHEN region = 'North China' THEN amount END)` — same functionality, noticeably worse readability.

## A look at GROUPING SETS

Roll up several dimensions in a single query instead of issuing multiple SQL statements and UNIONing them:

```sql
SELECT region, category, sum(amount) AS total
FROM sales
GROUP BY GROUPING SETS ((region, category), (region), (category), ());
-- emits separately: detail combinations, subtotals by region, subtotals by category, grand total
```

In the result, "columns not participating in that level of grouping" show as NULL, and the `grouping()` function lets you tell subtotal rows apart. Multi-dimensional rollups, ROLLUP/CUBE, and window functions all belong to the reporting toolset, see [Window Functions](../advanced-sql/window-functions).

## Gotchas and common pitfalls

- Without `ORDER BY` the order of grouped results is not guaranteed at all; report SQL should always sort explicitly.
- `count(DISTINCT col)` is a memory hog on large tables; for counting distinct values at massive scale consider an HLL-family extension or pre-aggregation.
- After a JOIN comes GROUP BY, watch for one-to-many joins inflating row counts and thereby overstating counts, see the matching section of [The JOIN Family](./join-family).
- An empty `sum` group returning NULL was emphasized at the start; the NULL-ignoring semantics of `avg` also need to be confirmed at the requirement level.

## References

- [PostgreSQL official documentation · Part I. Tutorial](https://www.postgresql.org/docs/current/tutorial.html)
- [PostgreSQL official documentation · The SQL Language](https://www.postgresql.org/docs/current/sql.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [WHERE and Expressions](./where-and-expressions)
- [Window Functions](../advanced-sql/window-functions)
- [Conditional Expressions](../advanced-sql/conditional-expressions)
- [conditional-expressions](/advanced-sql/conditional-expressions.md)
- [set-operations](/advanced-sql/set-operations.md)
- [window-functions](/advanced-sql/window-functions.md)
- [index](index.md)
- [join-family](join-family.md)
Official documentation: [Aggregate functions](https://www.postgresql.org/docs/current/functions-aggregate.html), [GROUP BY and HAVING documentation](https://www.postgresql.org/docs/current/tutorial-agg.html).
