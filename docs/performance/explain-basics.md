# Reading EXPLAIN

EXPLAIN is the entry point for query tuning: it has the optimizer fully plan the SQL and prints the resulting execution plan—how it intends to scan tables, which join algorithm to use, in what order to combine the steps, and roughly how many rows each step is expected to produce. Plain `EXPLAIN` **plans but never executes**, so you can safely run it on any statement; to see real timings and cache hits you need the `ANALYZE` option, see [EXPLAIN (ANALYZE, BUFFERS, WAL)](./explain-analyze-buffers).

## Preparing the Sample Data

This page and the next few share this pair of tables:

```sql
CREATE TABLE users (
    user_id bigint PRIMARY KEY,
    name    text NOT NULL
);

CREATE TABLE orders (
    order_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    bigint NOT NULL REFERENCES users(user_id),
    amount     numeric(10,2) NOT NULL,
    status     text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO users SELECT g, 'user_' || g FROM generate_series(1, 100000) g;

INSERT INTO orders (user_id, amount, status, created_at)
SELECT 1 + (random() * 99999)::bigint,
       round((random() * 1000)::numeric, 2),
       (ARRAY['pending','paid','done','canceled'])[1 + floor(random() * 4)::int],
       now() - (random() * interval '90 days')
FROM generate_series(1, 1000000);

CREATE INDEX orders_user_id_idx ON orders (user_id);
ANALYZE users, orders;
```

## The Three Numbers: cost, rows, width

Every node in the plan carries `(cost=startup..total rows=N width=N)`:

```sql
EXPLAIN SELECT * FROM orders WHERE user_id = 42;
```

```plaintext
Index Scan using orders_user_id_idx on orders
    (cost=0.42..8.46 rows=10 width=46)
  Index Cond: (user_id = 42)
```

- **cost=startup..total**: two abstract cost numbers. Startup is the cost paid before the first row can be produced (nodes that accumulate data, like Sort or Hash table building, have high startup—they cannot emit a first row without consuming all input); total is the cost of producing all rows. The unit is an abstract value, not milliseconds: one sequential page read counts as 1.0 (`seq_page_cost`), one random page read defaults to 4.0 (`random_page_cost`), and processing one row counts as 0.01 (`cpu_tuple_cost`). Only look at relative magnitudes; never read cost as elapsed time.
- **rows**: the optimizer's estimate of how many rows this node outputs, derived from statistics. Whether the estimate is accurate directly determines plan quality; classic misestimation cases are covered in [Common Bad Plans](./common-bad-plans).
- **width**: the average bytes per row this node outputs, derived from column types and statistics. Useful when judging "how much data does this query move".

The top node's total is the cost of the whole query; a parent node's cost is accumulated from its children, so **only the top-level cost can be compared across queries**—costs of intermediate nodes only have meaning within the plan.

## The Plan Tree: Read It Inside Out

A plan is a tree: **the deeper the indentation, the earlier it executes, and the innermost nodes are the data sources (scans)**; output flows upward where each parent node processes it, and the topmost node hands the result to the client. For "count the orders of user 42" below, inside-out reads: index scan → nested loop join → aggregate:

```sql
EXPLAIN
SELECT u.name, count(*)
FROM users u JOIN orders o ON o.user_id = u.user_id
WHERE u.user_id = 42
GROUP BY u.name;
```

```plaintext
Aggregate  (cost=8.58..8.59 rows=1 width=40)
  ->  Nested Loop  (cost=0.42..8.56 rows=10 width=16)
        ->  Index Scan using users_pkey on users u
              (cost=0.42..8.44 rows=1 width=16)
              Index Cond: (user_id = 42)
        ->  Index Scan using orders_user_id_idx on orders o
              (cost=0.00..8.12 rows=10 width=0)
              Index Cond: (user_id = 42)
```

Reading tips:

- In time order the deepest nodes run first; only after the topmost node finishes is the result returned.
- A parent's rows are derived from "child rows × selectivity", so **a misestimate in a child poisons the whole path above it**—when investigating estimation problems, work bottom-up.
- The `Index Cond` / `Filter` lines under each node describe that node's filter conditions: `Index Cond` is a condition the index can exploit, `Filter` is a condition applied row by row after fetching (a large `Rows Removed by Filter` usually means the wrong index was chosen).

## Common Scan Nodes

| Node | Behavior | Typical scenario |
| --- | --- | --- |
| Seq Scan | Reads the whole table start to finish | No usable index; or the share of rows fetched is high (say, above a few to a dozen percent) |
| Index Scan | Walks a B-tree index, fetches full rows from the heap as needed | Highly selective condition, few rows returned |
| Index Only Scan | Reads the index alone, no heap fetches | All queried columns are contained in the index, and the table's visibility map is fairly clean |
| Bitmap Heap Scan + Bitmap Index Scan | First computes a bitmap of matching blocks in the index, then fetches heap blocks in block order | Moderate row counts (tens to tens of thousands), a single index or OR/AND combinations of multiple indexes |

Matching examples:

```sql
EXPLAIN SELECT * FROM orders WHERE user_id = 42;          -- Index Scan
EXPLAIN SELECT count(*) FROM orders WHERE user_id = 42;   -- Index Only Scan
EXPLAIN SELECT * FROM orders WHERE user_id BETWEEN 100 AND 200;
```

```plaintext
Bitmap Heap Scan on orders  (cost=25.31..1531.05 rows=1010 width=46)
  Recheck Cond: ((user_id >= 100) AND (user_id <= 200))
  Heap Blocks: exact=690
  ->  Bitmap Index Scan on orders_user_id_idx
        (cost=0.00..25.06 rows=1010 width=0)
        Index Cond: ((user_id >= 100) AND (user_id <= 200))
```

The bitmap plan collects the bitmap first and then fetches the heap in batches, avoiding the per-row random jumping of an Index Scan; `Heap Blocks: exact=...` is the number of blocks exactly matched by the bitmap (`lossy=` appearing means the in-memory bitmap no longer fit and it degraded to per-block matching, requiring `Recheck` to re-verify each row). Index Only Scan relies on the visibility map to tell whether a row version is visible to everyone; on a table freshly bulk-updated it can degrade to a plain Index Scan—for the mechanics see [VACUUM and HOT](../internals/vacuum-and-hot).

## Join Nodes and JOIN Implementations

Join nodes in a plan correspond to three physical implementations:

| Node | Algorithm | When the optimizer picks it |
| --- | --- | --- |
| Nested Loop | Each outer row drives one inner lookup | Few outer rows, or an index on the inner join column |
| Hash Join | Builds a hash table on the inner input, probes it per outer row | Both sides are sizable, equijoin |
| Merge Join | Sorts both sides on the join key, then merges | Both sides already ordered (indexed), and many rows to fetch |

In the `Nested Loop` example above, the outer side is the single user row and the inner side looks up orders via the index, so total cost is tiny; widen the condition to "all users" and the plan becomes a Hash Join—full scan to build the hash table first, then probe. The cost models and details of the three implementations are covered in [JOIN Implementations](../internals/join-implementations).

## Estimates vs Actuals: Build the Reflex

Every rows value in `EXPLAIN` output is an estimate and can be off by orders of magnitude. Read plans with an "estimate vs actual" reflex: when you see a suspicious ratio (an estimate of 1 row, say), immediately suspect stale statistics or a skewed distribution. Add the `ANALYZE` option to get actual row counts and timings:

```sql
EXPLAIN (ANALYZE) SELECT * FROM orders WHERE user_id = 42;
```

```plaintext
Index Scan using orders_user_id_idx on orders
    (cost=0.42..8.46 rows=10 width=46)
    (actual time=0.021..0.048 rows=8 loops=1)
  Index Cond: (user_id = 42)
Planning Time: 0.182 ms
Execution Time: 0.089 ms
```

Note that `EXPLAIN (ANALYZE)` **actually executes the statement**—wrap write statements in a transaction and roll it back, as detailed on the next page. Since PG 16 there is also `EXPLAIN (GENERIC_PLAN)`, which shows the generic plan of a parameterized query without filling in parameters or executing.

## Caveats and Common Pitfalls

- Plain `EXPLAIN` does not execute the statement: SELECTs do not run and DML does not touch data; `EXPLAIN (ANALYZE)` really executes—do not confuse the two.
- cost is model pricing, not milliseconds. Change parameters like `random_page_cost` or `seq_page_cost` and every cost number in the same plan shifts, while actual speed may not change at all.
- rows=1 is a danger sign: it usually means missing/stale statistics, or an independence assumption the optimizer made about correlated columns—every downstream node's estimate then goes wrong with it.
- Indentation in a plan tree is easy to misread as sequential; for complex plans add `FORMAT JSON` (a JSON tree structure) or run it through an EXPLAIN visualization tool before reading.
- `EXPLAIN` shows the decisions made at planning time; during real execution, buffer warmth and concurrent load all affect elapsed time—a high-cost plan is not necessarily slower than a low-cost one once caches are fully warm.

## References

- [PostgreSQL Official Documentation · 14.1. Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)
- [PostgreSQL Official Documentation · Chapter 14. Performance Tips](https://www.postgresql.org/docs/current/performance-tips.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [EXPLAIN (ANALYZE, BUFFERS, WAL)](./explain-analyze-buffers)
- [Common Bad Plans](./common-bad-plans)
- [Statistics and ANALYZE](./statistics-and-analyze)
- [Optimizer Cost Model](../internals/optimizer-cost-model)
- [Index Selection Decision Tree](../indexing/index-selection-decision-tree)
- [cte-and-non-recursive-with](/advanced-sql/cte-and-non-recursive-with.md)
- [lateral-and-from-subquery](/advanced-sql/lateral-and-from-subquery.md)
- [set-operations](/advanced-sql/set-operations.md)
- [subquery-family](/advanced-sql/subquery-family.md)
- [common-beginner-mistakes](/basics/common-beginner-mistakes.md)
- [join-family](/basics/join-family.md)
- [psql-getting-started](/basics/psql-getting-started.md)
- [pgvector](/ecosystem/pgvector.md)
- [postgresql-17-features](/ecosystem/postgresql-17-features.md)
- [when-to-choose-postgresql](/ecosystem/when-to-choose-postgresql.md)
- [btree-structure](/indexing/btree-structure.md)
- [composite-index-design](/indexing/composite-index-design.md)
- [index-failure-and-misuse](/indexing/index-failure-and-misuse.md)
- [join-implementations](/internals/join-implementations.md)
- [optimizer-cost-model](/internals/optimizer-cost-model.md)
- [parallel-query](/internals/parallel-query.md)
- [query-execution-pipeline](/internals/query-execution-pipeline.md)
- [knowledge](/knowledge.md)
- [common-bad-plans](common-bad-plans.md)
- [explain-analyze-buffers](explain-analyze-buffers.md)
- [index](index.md)
- [partition-pruning](partition-pruning.md)
- [statistics-and-analyze](statistics-and-analyze.md)
- [psql-advanced](/tools/psql-advanced.md)
Official docs: [EXPLAIN command](https://www.postgresql.org/docs/current/sql-explain.html), [Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html).
