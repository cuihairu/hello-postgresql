# Join Implementations

SQL's `JOIN` only declares the result relation, not the algorithm. PostgreSQL has three physical implementations — Nested Loop, Hash Join, Merge Join — and the planner picks among them by cost. The performance gap between them can reach an order of magnitude, and the choice depends entirely on row-count estimates and index availability, which is also where the optimizer most often falls over. Official reference: [Planning joins](https://www.postgresql.org/docs/current/geqo-pg-intro.html).

## Nested Loop: Outer Drives Inner

For each row of the outer result, look for matches in the inner table:

```plaintext
for outer_row in outer:
    for inner_row in inner where inner.key = outer_row.key:   -- with an index this is one index probe
        emit(outer_row, inner_row)
```

- Best fit: **few outer rows + an index on the inner join column**, total cost ≈ outer rows × one index probe.
- **The only implementation that supports non-equality conditions**: `a.x < b.y`, `BETWEEN`-style joins — only it can do these.
- Once outer rows grow large, the inner table is probed repeatedly, and the worst case degenerates to O(N×M); when the outer side is underestimated (wrong rows estimate), Nested Loop is the source of disasters.
- Extremely fast when the inner table's hot pages are all in shared_buffers; the vast majority of small OLTP queries use it.

## Hash Join: Build a Hash Table, Then Probe

Two phases: first scan the smaller side (build side) to build a hash table in memory, then scan the other side (probe side) and probe row by row:

```plaintext
build:  hash_table = { hash(inner.key) → rows }        -- usually the small table
probe:  for outer_row in outer:
            emit(outer_row, hash_table.lookup(outer_row.key))
```

- **Only supports equijoins** (hashable, comparable expressions).
- Hash table size is constrained by `work_mem`; when it doesn't fit, it degrades to a hybrid hash join, batching by hash value (batch) and spilling to temp files across multiple passes. `Batches: N` in EXPLAIN, N > 1 means it is spilling to disk.
- Runs without any index, the default choice for equijoins on large tables; the cost is that it must consume the whole build side before emitting the first row, which is unfriendly to LIMIT.
- `work_mem` is the budget **per hash node, per parallel worker**, so memory multiplies under high-concurrency large joins, see [Architecture and Memory](./architecture-and-memory).

## Merge Join: Both Sides Ordered, Streamed Merge

Both sides are ordered by the join key first, then advance synchronously like the merge phase of merge sort:

- Ordering can come from an index scan (inherently ordered) or an explicit Sort node; **when both are already ordered it takes almost no extra memory and processes in a stream**.
- Only supports equality (precisely: join conditions comparable via btree, which in practice means equality).
- **Output is naturally ordered**: an upper-level `ORDER BY` can reuse it directly, saving a Sort.
- Often wins for large-table-against-large-table joins when the join columns happen to have suitable indexes; but as soon as one side needs an extra sort, it has to compete against the total price of "Hash Join + upper Sort".

## Selection Basis: What the Planner Compares

For each candidate implementation, the planner walks this chain to compute cost (the model itself is in [The Optimizer Cost Model](./optimizer-cost-model)):

1. Row-count estimates for both sides (pg_statistic);
2. Whether there is a usable index on the join columns, and whether the index order exactly matches the join key;
3. Whether an extra Sort is needed (whether it eats work_mem, whether it spills to disk);
4. Cost parameters (especially `random_page_cost`) and `work_mem`.

A wrong row-count estimate is the number one cause of join plan failures: the outer side estimated at 10 rows but actually 10 million turns Nested Loop from the optimal solution into the worst one.

## Comparing All Three with EXPLAIN

```sql
CREATE TABLE dim_user (id int PRIMARY KEY, name text);
INSERT INTO dim_user SELECT g, 'u' || g FROM generate_series(1, 1000) g;

CREATE TABLE fact_order (user_id int, amount numeric);
INSERT INTO fact_order SELECT g % 1000, g FROM generate_series(1, 1000000) g;
CREATE INDEX ON fact_order (user_id);
ANALYZE dim_user, fact_order;
```

When the outer side has only 1 row, Nested Loop wins hands down:

```sql
EXPLAIN SELECT u.name, o.amount
FROM   dim_user u JOIN fact_order o ON o.user_id = u.id
WHERE  u.id = 42;
-- Nested Loop
--   ->  Index Scan using dim_user_pkey on dim_user u
--         Index Cond: (id = 42)
--   ->  Index Scan using fact_order_user_id_idx on fact_order o
--         Index Cond: (user_id = 42)
```

For a full join it picks Hash Join by default (build on the small table, probe on the large table):

```sql
EXPLAIN SELECT count(*)
FROM   dim_user u JOIN fact_order o ON o.user_id = u.id;
-- Hash Join
--   Hash Cond: (o.user_id = u.id)
--   ->  Seq Scan on fact_order o
--   ->  Hash
--         ->  Seq Scan on dim_user u
```

Lowering work_mem lets you see the spill signal:

```sql
SET work_mem = '64kB';
EXPLAIN SELECT count(*)
FROM   dim_user u JOIN fact_order o ON o.user_id = u.id;
-- Hash Join ... Buckets: 1024  Batches: 64  Memory Usage: 40kB
-- Batches > 1: the hash table spilled to disk in batches
RESET work_mem;
```

Turning off the other two implementations (for demonstration only), observe Merge Join:

```sql
SET enable_hashjoin = off;
SET enable_nestloop = off;
EXPLAIN SELECT u.id, o.amount
FROM   dim_user u JOIN fact_order o ON o.user_id = u.id
ORDER  BY u.id;
-- Merge Join
--   Merge Cond: (u.id = o.user_id)
--   ->  Index Scan using dim_user_pkey on dim_user u
--   ->  Index Scan using fact_order_user_id_idx on fact_order o
RESET enable_hashjoin;
RESET enable_nestloop;
```

Three plans for the same result, with cost differences that can reach an order of magnitude — this is the main battlefield of EXPLAIN tuning.

## Multi-Table Join Order and GEQO

- When the number of relations does not exceed `geqo_threshold` (default 12), the planner uses dynamic programming to exhaustively enumerate join order and can find a fairly good solution.
- Beyond 12 relations it switches to a genetic algorithm (GEQO) for approximate search, avoiding combinatorial explosion; the cost is unstable plan quality — large BI queries "changing their plan when you add an irrelevant condition" mostly comes from this.
- If you want to pin a driving order for key queries, you can split into CTEs (with `MATERIALIZED` to build a fence when needed), use `LATERAL` to make the dependency explicit (see [LATERAL and FROM Subqueries](../advanced-sql/lateral-and-from-subquery)), or just `SET geqo = off` in small scenarios.

## Notes and Common Pitfalls

- **enable_hashjoin / enable_nestloop / enable_mergejoin / enable_seqscan are all debugging switches**: setting them off only adds a huge penalty to those plans, it doesn't disable them; in production tuning, fix statistics, cost parameters, and indexes first rather than relying on session-level switches.
- The build side of Hash Join is the "smaller side" chosen by the planner; a wrong estimate (the small table actually being the large table) causes the hash table to balloon and spill heavily.
- Merge Join depends on ordering: if one side's index is excluded (e.g. an expression wrapped around the join column, or a type mismatch), the merge becomes a Sort first, and the cost jumps immediately, see [Index Failure and Misuse](../indexing/index-failure-and-misuse).
- Non-equijoin can only be Nested Loop, and a non-equijoin with tens of millions of rows on both sides basically cannot run; solve it at the modeling or query-rewriting layer.
- Mismatched join column types (int vs bigint, or text vs varchar with different collations on each side) make both indexes and hashing awkward; align them at the modeling stage, see [Primary Key Design](../database-design/primary-key-design).

## References

- [PostgreSQL Official Docs · 19.7. Query Planning](https://www.postgresql.org/docs/current/runtime-config-query.html)
- [PostgreSQL Official Docs · Chapter 51. Overview of PostgreSQL Internals](https://www.postgresql.org/docs/current/overview.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [The Optimizer Cost Model](./optimizer-cost-model)
- [The Query Execution Pipeline](./query-execution-pipeline)
- [EXPLAIN Basics](../performance/explain-basics)
- [Composite Index Design](../indexing/composite-index-design)
- [join-family](/basics/join-family.md)
- [citus](/ecosystem/citus.md)
- [index](index.md)
- [optimizer-cost-model](optimizer-cost-model.md)
- [parallel-query](parallel-query.md)
- [query-execution-pipeline](query-execution-pipeline.md)
- [explain-basics](/performance/explain-basics.md)
Official docs reference: [Genetic Query Optimizer](https://www.postgresql.org/docs/current/runtime-config-query.html)
