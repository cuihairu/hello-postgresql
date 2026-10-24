# The Query Execution Pipeline

A SQL statement goes through five stages from text to result: parse → analyze → rewrite → plan → execute. The first four are "compile time", producing various tree structures in memory without touching data; the last is "run time". Understanding each stage's output is what lets you know why EXPLAIN looks the way it does, why views can be pushed down and optimized, and exactly which interval pg_stat_statements is measuring. Official reference: [Query Processing Overview](https://www.postgresql.org/docs/current/overview.html).

## Overview of the Five Stages

```plaintext
SQL text
  │ ① parse    lexer + parser          → raw parse tree
  │ ② analyze  semantic analysis       → query tree
  │ ③ rewrite  rule system             → rewritten query tree (views expanded here)
  │ ④ plan     optimizer               → plan tree (this is what EXPLAIN shows)
  │ ⑤ execute  executor                → tuple stream → result set
```

`EXPLAIN` (without ANALYZE) only goes through step ④; it does not execute the statement. Only `EXPLAIN ANALYZE` actually runs step ⑤ and replays statistics.

## ① parse: Lexer and Syntax

The parser only recognizes the "shape" of SQL and never touches any table structure: `SELECT foo FROM bar` is completely syntactically valid even if the bar table does not exist. Lexical splitting and parsing are based on flex/bison (gram.y, scan.l) and produce the raw parse tree — its nodes are grammatical structures such as SELECT/INSERT, and columns are still string names. `ERROR: syntax error at or near ...` is all reported at this gate.

## ② analyze: Semantic Analysis and the Query Tree

The analyze stage does semantic resolution: table names and column names are resolved to OIDs in the system catalogs, functions and operators have concrete implementations chosen, implicit type casts are added, and object permissions are checked. The product is the query tree (the Query struct), at which point column references are already numbered (attnum) rather than strings. Table does not exist, column does not exist, type mismatch, insufficient permission — all reported at this step.

## ③ rewrite: The Rule System and View Expansion

The rewrite stage applies the rule system (rules live in the pg_rewrite table):

- **A view is just a `_RETURN` rule**: locations in the query tree that reference a view are replaced with the subquery of the view's definition, after which the optimizer treats it as an ordinary subquery.
- Rewriting of updatable views, and the definition maintenance of materialized views, also go through this stage.

```sql
CREATE VIEW active_users AS
  SELECT id, name FROM users WHERE deleted_at IS NULL;

EXPLAIN (VERBOSE, COSTS OFF)
SELECT name FROM active_users WHERE id = 42;
-- Seq Scan on public.users
--   Output: name
--   Filter: ((id = 42) AND (deleted_at IS NULL))
```

There is no "view" object in the plan — it was already expanded in the rewrite stage, and `id = 42` was also pushed down by the optimizer onto the base table scan. To look at a view's definition, use `\d+ view_name` or `pg_get_viewdef()`.

## ④ plan: The Plan Tree

The planner takes the query tree as input, enumerates scan methods, join order, and join algorithms, and picks the lowest-cost plan tree according to the cost model. EXPLAIN displays exactly this tree: node nesting corresponds to data flow, and child nodes are the input to their parent. The cost and rows annotated on each node come from estimates; for the source of estimates see [The Optimizer Cost Model](./optimizer-cost-model), and for the trade-offs between the three join algorithms see [Join Implementations](./join-implementations).

## ⑤ execute: The Volcano Model and Node Types

The executor is the classic Volcano iterator model: each plan node implements a "give me the next tuple" pull interface, upper nodes pull one at a time from lower nodes (pull), processing one and emitting one. Memory usage is decoupled from input size, which is what allows LIMIT to short-circuit early.

- **Scan family**: Seq Scan, Index Scan, Index Only Scan, Bitmap Heap Scan.
- **Join family**: Nested Loop, Hash Join, Merge Join.
- **Auxiliary nodes**: Sort, HashAggregate/GroupAggregate, Limit, Materialize, CTE Scan, WindowAgg, etc.

Watch for pipeline breakers: Sort, HashAggregate, and the build phase of Hash Join must consume all input before they can emit the first row, so `LIMIT` cannot save execution time on aggregation/sort queries — it only saves transfer.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT status, count(*) FROM orders GROUP BY status ORDER BY 2 DESC LIMIT 3;
```

## Which Link pg_stat_statements Times

pg_stat_statements measures only two intervals: **planning** (the `plans`/`total_plan_time` columns in PG 13+) and **execution** (`calls`/`total_exec_time`). parse/analyze/rewrite are not measured separately — they usually take only sub-milliseconds, and slow statements are almost always slow in plan or execute:

```sql
SELECT query, plans, total_plan_time, calls, total_exec_time, mean_exec_time
FROM   pg_stat_statements
ORDER  BY total_exec_time DESC
LIMIT  5;
```

Statements with a high share of `total_plan_time` (simple OLTP queries, SQL built by concatenating large numbers of different constants) indicate the problem is in planning rather than execution; the direction is parameterization and connection-pool governance, see [pg_stat_statements](../performance/pg-stat-statements).

## PREPARE and Cached Plans

`PREPARE`d statements complete parse/analyze/rewrite at prepare time, and the plan is reusable. To see what plan a prepared statement would use right now:

```sql
EXPLAIN EXECUTE stmt_name;
```

The switching rules between generic plan and custom plan are in [Plan Cache and Generic Plans](./plan-cache-and-generic-plan).

## Notes and Common Pitfalls

- After view expansion, **filter pushdown is done by the optimizer, not the rule system**: when a view contains window functions, DISTINCT, aggregates, or LIMIT, outer conditions cannot be pushed in — "a view wrapper makes it slower" mostly comes from this.
- Permission checks happen at the analyze stage, but **row-level security (RLS) policy conditions are injected at plan time**; `EXPLAIN VERBOSE` shows you the policy filter.
- Bind parameters keep user input always as data only, never entering the SQL text of step ① — the root of SQL injection is string concatenation breaking through that boundary.
- Memory allocation at the execute stage is constrained by `work_mem`; Sort/Hash that exceed it spill to disk, see [Architecture and Memory](./architecture-and-memory).

## References

- [PostgreSQL Official Docs · Chapter 51. Overview of PostgreSQL Internals](https://www.postgresql.org/docs/current/overview.html)
- [PostgreSQL Official Docs · Chapter 13. Concurrency Control](https://www.postgresql.org/docs/current/mvcc.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [The Optimizer Cost Model](./optimizer-cost-model)
- [Join Implementations](./join-implementations)
- [Plan Cache and Generic Plans](./plan-cache-and-generic-plan)
- [EXPLAIN Basics](../performance/explain-basics)
- [index](index.md)
- [join-implementations](join-implementations.md)
Official docs reference: [Query Processing Overview](https://www.postgresql.org/docs/current/overview.html)
