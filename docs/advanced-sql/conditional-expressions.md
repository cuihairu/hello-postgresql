# Conditional Expressions

Conditional expressions let SQL make branch decisions inside a query: `CASE` is the generic standard-SQL form, `COALESCE`/`NULLIF` handle NULL fallback, `FILTER (WHERE ...)` is PostgreSQL's proprietary conditional aggregation syntax, and `DISTINCT ON` solves the classic "take one row per group" problem. This page also covers `NULLS FIRST`/`NULLS LAST`, which are tied to ordering — when you do not declare them explicitly, their default behavior is opposite under `ASC` and `DESC`, a common source of scrambled report ordering.

## Sample Table

```sql
CREATE TABLE orders (
    id          bigserial PRIMARY KEY,
    user_id     bigint NOT NULL,
    amount      numeric(10,2),
    status      text NOT NULL,      -- paid / refunded / pending
    paid_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO orders (user_id, amount, status, paid_at) VALUES
    (1, 120.00, 'paid',    '2026-01-05 10:00+08'),
    (1,  80.00, 'refunded', '2026-01-06 10:00+08'),
    (2, 300.00, 'paid',    '2026-01-07 10:00+08'),
    (2, NULL,   'pending', NULL),
    (3,  50.00, 'paid',    '2026-01-09 10:00+08'),
    (3, 200.00, 'paid',    '2026-01-10 10:00+08');
```

## The Two Forms of CASE

**Simple form** compares one expression against a list of values one by one, and suits equality branches:

```sql
SELECT id, status,
       CASE status
           WHEN 'paid'     THEN 'Paid'
           WHEN 'refunded' THEN 'Refunded'
           ELSE 'Pending'
       END AS status_label
FROM orders;
```

**Search form** evaluates boolean conditions one by one and returns on the first hit; in expressiveness it fully covers the simple form:

```sql
SELECT id, amount,
       CASE
           WHEN amount >= 200 THEN 'Large'
           WHEN amount >= 100 THEN 'Medium'
           WHEN amount IS NULL THEN 'Unpriced'
           ELSE 'Small'
       END AS bucket
FROM orders
ORDER BY id;
```

**When there is no ELSE and no branch hits, the result is NULL** — not an error and not an empty string. Omitting ELSE is the most common reason for "a bunch of NULLs in the result."

### The Boundaries of Short-Circuit Evaluation

CASE branches are evaluated in order, and no expression after the branch that hits is executed. But the official documentation explicitly lists one exception: **aggregate expressions are computed before CASE's test**. Wrapping an aggregate in CASE does not prevent errors inside the aggregate's argument:

```sql
CREATE TABLE orders_bad (id int PRIMARY KEY, cnt int NOT NULL);
INSERT INTO orders_bad VALUES (1, 2), (2, 0), (3, 5);

-- Looks safe: min comes out as 0 so THEN runs; but sum(1/cnt) is an aggregate,
-- so it is evaluated over all rows before the CASE test, and the cnt=0 row raises a division-by-zero error
SELECT CASE WHEN min(cnt) > 0 THEN sum(1.0 / cnt) END
FROM orders_bad;
```

The solution the documentation recommends is to use `WHERE` or `FILTER` so the offending rows never reach the aggregate function at all; equivalently, you can put the branch inside the aggregate argument:

```sql
SELECT sum(1.0 / cnt) FILTER (WHERE cnt > 0) FROM orders_bad;
SELECT sum(CASE WHEN cnt > 0 THEN 1.0 / cnt END) FROM orders_bad;
```

Another counter-intuitive point: constant subexpressions may be evaluated at **planning** time, so `CASE WHEN x > 0 THEN x ELSE 1/0 END` still divides by zero, because `1/0` is folded away during the planning phase. Do not count on an outer CASE to catch error-prone computations such as division or casts.

## COALESCE and NULLIF

These two functions were introduced in [WHERE and Expressions](../basics/where-and-expressions); here the emphasis is only on their usage boundaries:

```sql
SELECT coalesce(sum(amount), 0) AS total FROM orders WHERE status = 'paid';  -- 0 for an empty group
SELECT coalesce(paid_at, created_at) AS effective_time FROM orders;         -- column-level fallback
SELECT NULLIF(status, 'pending') FROM orders;   -- pending becomes NULL, handy for a later coalesce
```

`NULLIF(a, b)` is equivalent to `CASE WHEN a = b THEN NULL ELSE a END`; a common use is to temporarily turn a "sentinel value" into NULL. Note that all of `coalesce`'s argument types must be identical or implicitly convertible, and mixing `text` with `int` raises a type error.

## FILTER (WHERE ...) Conditional Aggregation

From PG 9.4 the `FILTER` clause is supported, letting a single aggregate function count only the rows that meet a condition. Compared with the equivalent `CASE` form:

```sql
SELECT user_id,
       count(*) FILTER (WHERE status = 'paid')                     AS paid_cnt,
       count(*) FILTER (WHERE status = 'refunded')                 AS refunded_cnt,
       count(*) FILTER (WHERE paid_at IS NOT NULL)                 AS paid_with_time,
       sum(amount) FILTER (WHERE status = 'paid')                  AS paid_amount
FROM orders
GROUP BY user_id
ORDER BY user_id;
```

The equivalent `CASE` rewrites are `count(CASE WHEN status = 'paid' THEN 1 END)` and `sum(CASE WHEN status = 'paid' THEN amount END)`. FILTER's advantage is not performance (the two execution plans are essentially identical) but readability and one less "NULL-ifying" step to hold in mind; and `FILTER` can be applied directly to any aggregate, including `avg` and `array_agg`. When a wide report has seven or eight conditional metrics, the FILTER version of the SQL is noticeably closer to the requirement description.

## DISTINCT ON: One Row Per Group

`DISTINCT ON (expr)` is a PostgreSQL extension: after grouping by `expr`, only the **first row in sorted order** is kept per group. The syntax rule is strict — the DISTINCT ON expression must match the beginning of `ORDER BY` as a leftmost prefix:

```sql
-- Each user's most recent order
SELECT DISTINCT ON (user_id)
       user_id, id, amount, paid_at
FROM orders
WHERE paid_at IS NOT NULL
ORDER BY user_id, paid_at DESC, id DESC;
```

The part of `ORDER BY` after the DISTINCT ON column (`paid_at DESC, id DESC`) decides "which row wins within the group." **A unique key at the end (such as `id DESC`) is mandatory to break ties**; otherwise which of two rows with the same `paid_at` is kept is indeterminate. If the beginning of `ORDER BY` does not match the DISTINCT ON expression, PostgreSQL errors out immediately, but the error will not add the "unique key backstop" for you, so the instability problem still has to be avoided by writing it correctly.

It is often used as a replacement for the "window function ROW_NUMBER = 1, then filter" form, and the two give the same result; when you need the top N rows per group, window functions are more appropriate. See [Window Functions](./window-functions).

## NULLS FIRST / NULLS LAST

For ascending `ASC`, PostgreSQL defaults to putting NULL **last** (`NULLS LAST`), and for descending `DESC` defaults to putting NULL **first** (`NULLS FIRST`) — different from some databases (Oracle puts NULL last ascending, while SQL Server treats NULL as the smallest). This means that when you "order by time descending to get the latest records," all rows with `paid_at IS NULL` sort to the very front:

```sql
SELECT id, paid_at FROM orders ORDER BY paid_at DESC;
-- NULL rows first (the default NULLS FIRST)

SELECT id, paid_at FROM orders ORDER BY paid_at DESC NULLS LAST;
-- NULL rows last, matching the intuition of "newest first"
```

When sorting a nullable column descending, writing `NULLS LAST` explicitly is an extremely cheap defensive habit. Note that `NULLS FIRST/LAST` affects index usage: a btree index sorts by "ASC + NULLS LAST" by default, so `ORDER BY col DESC NULLS LAST` gets an extra Sort node unless there is an index with the corresponding order. See [btree index structure](../indexing/btree-structure).

## Caveats and Common Traps

- The return types of CASE branches must be compatible; `THEN 1 ... THEN 'one'` errors out at parse time. When you need mixed types, cast explicitly with `::text`.
- Without a unique key backstop, DISTINCT ON results are unstable, and that instability **raises no error** — it only surfaces after the data volume changes.
- `FILTER` may only follow an aggregate function and cannot be used on window functions; use `CASE` for conditional aggregation with window functions.
- In `ORDER BY`, an identifier that matches an output alias and a column name resolves to the output alias first; `ORDER BY lower(status)` and `ORDER BY status` may not refer to the same thing. Keep the ordering expression consistent with the index expression.
- Relying on CASE short-circuiting inside an aggregate argument to avoid division-by-zero or cast errors is unreliable; put the potentially error-prone expression inside the branch.

## References

- [PostgreSQL official documentation · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL official documentation · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Aggregates and GROUP BY](../basics/aggregate-and-group-by)
- [Window Functions](./window-functions)
- [Pagination and Sorting](./pagination-and-sorting)
- [btree index structure](../indexing/btree-structure)
- [index](index.md)
- [pagination-and-sorting](pagination-and-sorting.md)
- [set-operations](set-operations.md)
- [window-functions-advanced](window-functions-advanced.md)
- [window-functions](window-functions.md)
- [aggregate-and-group-by](/basics/aggregate-and-group-by.md)
Official documentation: [Conditional expressions](https://www.postgresql.org/docs/current/functions-conditional.html), [The DISTINCT clause of SELECT](https://www.postgresql.org/docs/current/sql-select.html#SQL-DISTINCT), [Ordering and NULL values](https://www.postgresql.org/docs/current/queries-order.html).
