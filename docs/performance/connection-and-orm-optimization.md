# Connection and ORM Optimization

Many "the database is slow" problems happen well before the SQL: an ORM splits one query into hundreds, connection count exceeds the CPU core count, a transaction spans an entire HTTP request, and row-by-row INSERTs flood the WAL. This page looks at database performance from the application side: spotting N+1 and batching it, common ORM pitfalls, parameter binding and prepared statements, connection pool sizing, transaction boundaries, and bulk writes.

## Spotting N+1 and Batching It

N+1 is the number-one performance problem in ORM scenarios: one fetch for the list, then one fetch of related data per object in the list. Recognition is straightforward—turn on the ORM's SQL logging and count the statements:

```plaintext
# Django debug log: a list page of 100 users fired 101 SQL statements
SELECT * FROM users LIMIT 100;
SELECT * FROM profiles WHERE user_id = 1;
SELECT * FROM profiles WHERE user_id = 2;
...
```

Three batching routes, chosen by scenario:

```sql
-- Approach 1: an IN list fetches everything at once, the application assembles by id
SELECT * FROM profiles WHERE user_id = ANY ($1);   -- bind an integer array {1,2,...,100}

-- Approach 2: a single JOIN (select_related / includes / eager loading in ORMs)
SELECT u.*, p.bio
FROM users u LEFT JOIN profiles p ON p.user_id = u.user_id;

-- Approach 3: use LATERAL when related data needs "top N per row", avoiding a full JOIN then filtering
SELECT u.user_id, r.order_id, r.amount
FROM users u
LEFT JOIN LATERAL (
    SELECT order_id, amount
    FROM orders o
    WHERE o.user_id = u.user_id
    ORDER BY created_at DESC
    LIMIT 3
) r ON true;
```

The LATERAL form lets the optimizer run one "locate by user_id + take the first 3" index scan per user—an order of magnitude cheaper than joining all orders first and then filtering with a window function. Syntax details are in [LATERAL and FROM Subqueries](../advanced-sql/lateral-and-from-subquery).

## Common ORM Pitfalls

Four high-frequency pitfalls, all visible in the SQL log:

- **Layered lazy loading**: one level deeper in the object graph doubles the queries. The strategy is to declare eager loading explicitly and keep lazy loading only on read paths.
- **SELECT \***: ORMs pull all columns by default; on wide tables with large TOAST fields a single query costs several times more. List endpoints should use `only()`/`select` to name columns; put large fields in a separate table or fetch lazily—see [TOAST](../internals/toast).
- **Unbounded count**: pagination components default to `count(*)` over the whole table; on a ten-million-row table that takes seconds. Estimate with `EXPLAIN` where you can, cache where you can, and switch to keyset pagination instead of an exact total where you can—pagination approaches in [Pagination and Sorting](../advanced-sql/pagination-and-sorting).
- **Per-object save**: 1000 UPDATEs inside a loop, each its own transaction. Collapse them into a batched operation (see "Bulk Writes" below).

One more, quieter pitfall: the parameter types an ORM generates disagree with the column types (say, a string bound to an integer column). Mildly that defeats the index; worse it triggers an implicit cast. Check the bound values and types in the log against the column definitions.

## Prepared Statements and Parameter Binding

Always use parameter binding on the application side; do not concatenate SQL. That both rules out injection and keeps the statement structure stable so the server can cache its plan:

```sql
-- server-side prepared statement (drivers usually issue the extended protocol's Parse/Bind automatically)
PREPARE get_user_orders(bigint, text) AS
SELECT order_id, amount, created_at
FROM orders
WHERE user_id = $1 AND status = $2
ORDER BY created_at DESC
LIMIT 20;

EXECUTE get_user_orders(40021, 'paid');
```

Key points:

- Drivers send parameters over the extended protocol, so PostgreSQL compares using the actual types—there is no type drift from string concatenation.
- The server caches execution plans: the first 5 executions generate a custom plan with the real parameters, after which it may switch to a generic plan. In extreme distribution scenarios a generic plan can go slow; fall back with `SET plan_cache_mode = force_custom_plan;`. Mechanics in [Plan Cache and Generic Plans](../internals/plan-cache-and-generic-plan).
- Transaction-level reuse in a connection pool (such as PgBouncer's transaction pooling mode) has compatibility boundaries with stateful prepared statements; confirm your driver's behavior before choosing a pool mode—see [Connection Management](../operations/connection-management).

## Connection Pool Parameters

In PostgreSQL each connection is a process, and with too many connections the scheduling and context-switch overhead eats the concurrency gain. Starting formula:

```plaintext
pool size ≈ CPU cores × 2 (then fine-tune for storage capacity; add one per disk spindle for spinning media)
```

A 16-core machine starts with 32 active connections, load-test, then adjust—do not compute it as "app instances × the framework's default of 10", which usually starts in the hundreds and just gets slower. Companion check:

```sql
-- what are the connections doing: lots of active or lots of idle
SELECT state, count(*) FROM pg_stat_activity GROUP BY state ORDER BY 2 DESC;
```

- Large `idle` pileup → the application is not returning connections, and the pool is not achieving reuse;
- `active` pinned at ≈ the pool cap for long, with heavy queueing → the database is at its concurrency bottleneck; optimize slow queries before adding connections;
- When over 90% of requests wait on a single slow SQL, adding connections only moves the queue from the application to the database.

Whether the pool lives on the application side or in a separate gateway (PgBouncer / built-in pooling), and how to choose a pool mode, are covered in [Connection Management](../operations/connection-management); single-node capacity limits in [Capacity and Scaling Limits](./capacity-and-scaling-limits).

## Keep Transaction Boundaries Short

Transactions hold locks and block VACUUM cleanup (see [VACUUM and HOT](../internals/vacuum-and-hot)); long transactions are a shared source of both concurrency degradation and table bloat. Two disciplines:

- **Do not do external interaction inside a transaction**: no HTTP calls, no RPC, no waiting on user input. In the fetch-compute-write pattern, only the two small database-touching pieces belong in the transaction.
- **Cap idle-in-transaction time**: connection leaks or infinite loops leave `idle in transaction` connections behind; one switch catches them:

```sql
-- in postgresql.conf, or per session
SET idle_in_transaction_session_timeout = '30s';
SET statement_timeout = '60s';   -- per-statement cap, prevents a slow query from holding a connection for long
```

To find the scene, use `pg_stat_activity` to locate connections with `state = 'idle in transaction'` and their `xact_start`, and handle hot rows alongside [Lock and Concurrency Bottlenecks](./lock-and-concurrency-bottlenecks).

## Bulk Writes: executemany and COPY

Per-row commits are the enemy of write throughput: each statement is one network round trip, one parse, one transaction log entry. Upgrade the approach with the data volume:

```sql
-- thousands of rows: multi-row INSERT, one statement, one commit
INSERT INTO metrics (tag, value, taken_at)
VALUES ('cpu', 0.72, now()), ('cpu', 0.81, now()), ('cpu', 0.77, now());

-- ten thousand rows and up: the driver's batch API or COPY
COPY metrics (tag, value, taken_at) FROM STDIN WITH (FORMAT csv);
```

Driver-side mapping: JDBC turns `addBatch` into multi-row INSERTs with `rewriteBatchedInserts=true`; psycopg3's `executemany` has a built-in pipeline mode (one network round trip executes a batch); in any language COPY is the speed ceiling for loading data, with ready-made interfaces in `psycopg.copy` and `pgx.CopyFrom`. Transaction granularity and the fsync trade-off for bulk writes are in [Batch and Write](../advanced-sql/batch-and-write) and [Write Throughput Optimization](./write-throughput-optimization).

## Caveats and Common Pitfalls

- Before batching, confirm the bottleneck really is round trips: a statement that already takes 2 seconds alone will not be saved by batching—start with [A Slow Query Governance Workflow](./slow-query-governance).
- An ORM's `bulk_create`/`insert_all` usually skips ORM hooks and default value validation; confirm the behavioral difference in tests.
- A bigger connection pool is not always better: active connections beyond twice the CPU core count just add contention. Queueing (a little waiting) is more stable than full concurrency.
- The element type of an `ANY ($1)` array binding must match the column type, or the index may not be used.
- COPY and multi-row INSERT both inflate a single WAL entry; split very large batches into chunks of 10,000-50,000 rows to leave headroom for replication and checkpoints.
- ORM behaviors that nest many SAVEPOINTs inside a transaction (Django's nested atomic blocks, say) may not work in a pool's transaction mode—verify before shipping.

## References

- [PostgreSQL Official Documentation · 14.1. Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)
- [PostgreSQL Official Documentation · Chapter 14. Performance Tips](https://www.postgresql.org/docs/current/performance-tips.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [A Slow Query Governance Workflow](./slow-query-governance)
- [Batch and Write](../advanced-sql/batch-and-write)
- [Connection Management](../operations/connection-management)
- [Plan Cache and Generic Plans](../internals/plan-cache-and-generic-plan)
- [common-errors-and-troubleshooting](/appendix/common-errors-and-troubleshooting.md)
- [architecture-and-memory](/internals/architecture-and-memory.md)
- [lock-conflict-troubleshooting](/internals/lock-conflict-troubleshooting.md)
- [connection-management](/operations/connection-management.md)
- [capacity-and-scaling-limits](capacity-and-scaling-limits.md)
- [index](index.md)
- [parameter-tuning](parameter-tuning.md)
- [slow-query-governance](slow-query-governance.md)
- [client-drivers](/tools/client-drivers.md)
Official docs: [COPY](https://www.postgresql.org/docs/current/sql-copy.html), [Query Planning Configuration](https://www.postgresql.org/docs/current/runtime-config-query.html).
