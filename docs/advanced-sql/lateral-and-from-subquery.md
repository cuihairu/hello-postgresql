# LATERAL and FROM Subqueries

The FROM clause can hold not only tables but also subqueries (derived tables) and set-returning functions; the LATERAL keyword (PG 9.3+) goes further by allowing these FROM items to reference columns of other FROM items to their left, making "run a parameterized subquery for each row of the left table" a piece of ordinary SQL. This page covers derived tables, correlated subqueries, LATERAL syntax, two ways of writing per-group Top-N compared, and the usual expansion idioms for unnest/generate_series.

## FROM Subqueries (Derived Tables)

```sql
SELECT region, avg_total
FROM (
    SELECT region, avg(amount) AS avg_total
    FROM orders
    GROUP BY region
) t                          -- a derived table must have an alias
WHERE avg_total > 1000
ORDER BY avg_total DESC;
```

Essentials:

- A derived table must have an alias, otherwise you get `subquery in FROM must have an alias`.
- To the optimizer a derived table is just an ordinary subquery: outer conditions can push down into it and it can take part in JOIN reordering; since PG 12, once single-reference CTEs are inlined by default, the plan matches the CTE form (see [CTEs and Non-Recursive WITH](./cte-and-non-recursive-with)).
- "Aggregate on the inside, filter the aggregate result on the outside" is the most typical layered use.

## Correlated Subqueries

Without LATERAL, a subquery that references outer columns may only appear in the SELECT output list, in WHERE, or in a JOIN ON, and is logically evaluated once per outer row:

```sql
SELECT region,
       (SELECT max(amount) FROM orders o WHERE o.region = r.region) AS max_amt
FROM (SELECT DISTINCT region FROM orders) r
ORDER BY region;
```

Its limit: a subquery in the output list can only return a single scalar, and an EXISTS in WHERE can only answer true or false. If you want to reference columns from the left directly inside FROM while returning multiple rows and columns, you need LATERAL. For a complete comparison of the subquery family, see [The Subquery Family](./subquery-family).

## LATERAL: The Right Side References the Left

The sample data for this page:

```sql
CREATE TABLE regions (region text PRIMARY KEY);
INSERT INTO regions VALUES ('North China'), ('East China'), ('South China'), ('Northeast');   -- Northeast has no orders yet

CREATE TABLE orders (
    id         int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    region     text NOT NULL,
    seller     text NOT NULL,
    amount     numeric(10,2) NOT NULL,
    created_at date NOT NULL
);

INSERT INTO orders (region, seller, amount, created_at) VALUES
    ('North China', 'Zhang', 1200, '2026-03-01'),
    ('East China',  'Wang',  2000, '2026-03-02'),
    ('East China',  'Zhao',  1500, '2026-03-02'),
    ('North China', 'Li',    800,  '2026-03-03'),
    ('North China', 'Zhou',  950,  '2026-03-03'),
    ('East China',  'Wu',    1100, '2026-03-04'),
    ('North China', 'Zhang', 1400, '2026-03-05'),
    ('South China', 'Qian',  900,  '2026-03-06'),
    ('South China', 'Sun',   800,  '2026-03-06'),
    ('South China', 'Zheng', 300,  '2026-03-06');
```

Take the top 2 sellers by amount in each region:

```sql
SELECT r.region, top.seller, top.amount
FROM regions r
CROSS JOIN LATERAL (
    SELECT o.seller, o.amount
    FROM orders o
    WHERE o.region = r.region        -- references a column of the left regions table
    ORDER BY o.amount DESC
    LIMIT 2
) top
ORDER BY r.region, top.amount DESC;
```

Rules:

- A FROM item modified by LATERAL can reference columns of any FROM item to its left; the reverse does not hold, and getting it backwards yields `invalid reference to FROM-clause entry`.
- Evaluation runs left to right: for each row the left side produces, the right side executes once with that row's column values, much like a "parameterized correlated subquery." The optimizer does not reorder across the LATERAL boundary.
- `CROSS JOIN LATERAL` drops groups where the inner query returns no rows (Northeast disappears entirely here); to keep them, use `LEFT JOIN LATERAL (...) top ON true`, and Northeast emits one NULL row.
- Function calls in FROM (such as unnest) are implicitly LATERAL; subqueries must write the LATERAL keyword explicitly.

## Per-Group Top-N: Two Approaches Compared

The same requirement can also be expressed with window functions:

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

Performance intuition:

- The LATERAL version is close to "number of groups x LIMIT per group" index probes: with a composite (region, amount DESC) index on orders (see [Composite Index Design](../indexing/composite-index-design)), each group scans two rows and stops. When there are few groups, the index is right, and you only need a few rows at each group's head, it is clearly cheaper; and before the inner LIMIT you can freely JOIN and write complex filters, giving more compositional freedom.
- The window-function version scans the full table once and sorts by partition once to compute all groups at once: more balanced when there are many groups, no suitable index exists, or each group needs a substantial share of its rows (such as the top half of each group).
- When unsure, compare actual plans and row estimates with EXPLAIN; see [EXPLAIN basics](../performance/explain-basics).

## LATERAL and Set-Returning Functions

Expanding an array, a JSON array, or a string within one row into multiple rows is LATERAL's most common day-to-day use:

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

Ticket 3 has an empty array for tags, so unnest produces 0 rows and the row disappears entirely under CROSS JOIN; changing to `LEFT JOIN LATERAL unnest(t.tags) AS u(tag) ON true` keeps that ticket.

Use generate_series to build a calendar skeleton so days with no orders still appear in the report:

```sql
SELECT d::date AS day, count(o.id) AS order_cnt
FROM generate_series(date '2026-03-01', date '2026-03-07', interval '1 day') AS d
LEFT JOIN orders o ON o.created_at = d::date
GROUP BY d
ORDER BY d;        -- order_cnt for 03-07 is 0
```

## A Look at Set-Returning Functions

Functions that can produce multiple rows in FROM are collectively called set-returning functions (SRFs):

```sql
SELECT * FROM generate_series(1, 3);                     -- 1, 2, 3

SELECT tag, ordinality                                   -- includes a position ordinal (PG 9.4+)
FROM unnest(ARRAY['a', 'b', 'c']) WITH ORDINALITY AS t(tag, ordinality);

SELECT word
FROM regexp_split_to_table('a,b,c', ',') AS word;        -- a, b, c

SELECT j
FROM jsonb_array_elements('[1, 2, 3]'::jsonb) AS j;      -- 1, 2, 3 (jsonb type)
```

An SRF written in the SELECT output list also works (the older one-row-becomes-many-rows style), but new code should place it in FROM consistently; the form combined with LATERAL is clearer and easier to control.

## Caveats and Common Traps

- CROSS JOIN LATERAL drops groups silently: when the inner query can return 0 rows (regions with no orders, empty arrays), decide deliberately whether you want LEFT JOIN + ON true.
- When the inner subquery is expensive, LATERAL amplifies it by the left side's row count: total cost is roughly "left row count x inner cost." Confirm that orders has a composite (join column + sort column) index, and use EXPLAIN ANALYZE to check the actual per-loop time.
- LATERAL can only reference the left side: writing the dependency on the right and referencing it is a common typo.
- Derived tables must have aliases; when a function expands multiple columns, name them explicitly with `AS t(col1, col2)` to avoid ambiguity.

## References

- [PostgreSQL official documentation · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL official documentation · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Window Functions](./window-functions)
- [Window Functions in Depth](./window-functions-advanced)
- [The Subquery Family](./subquery-family)
- [Array Operations](./array-operations)
- [array-operations](array-operations.md)
- [index](index.md)
- [sql-functions-advanced](sql-functions-advanced.md)
- [subquery-family](subquery-family.md)
- [window-functions-advanced](window-functions-advanced.md)
- [join-family](/basics/join-family.md)
- [join-implementations](/internals/join-implementations.md)
- [connection-and-orm-optimization](/performance/connection-and-orm-optimization.md)
Official documentation: [FROM and LATERAL](https://www.postgresql.org/docs/current/queries-table-expressions.html), [Set-returning functions](https://www.postgresql.org/docs/current/functions-srf.html).
