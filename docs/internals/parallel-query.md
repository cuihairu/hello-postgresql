# Parallel Query

PostgreSQL has supported parallel query since 9.6: when executing a query, the backend that initiated it (called the leader) can request a number of parallel worker processes, each scanning a portion of the data and doing computation, then the results are gathered back. Its target scenario is "a single large query" — large table scans, large aggregations, large joins; OLTP short queries usually don't use it and shouldn't. This page records where workers come from, how the cost is calculated, which plans can be parallelized, and how to confirm in EXPLAIN that parallelism actually happened.

## Leader and Worker Process Model

- The top of the plan tree has a `Gather` node (unordered gather) or a `Gather Merge` node (order-preserving gather), indicating there is a parallel segment (a parallel-aware subtree) here.
- The leader receives output from each worker via a tuple queue in shared memory; by default the leader also participates in scanning (`parallel_leader_participation = on`).
- Workers are not persistent; each query forks them on demand and they exit on completion. The available quota tightens in three layers:

| Parameter | Meaning | Default |
| --- | --- | --- |
| `max_worker_processes` | total background process count for the whole instance (including replication, extensions) | 8 |
| `max_parallel_workers` | how many of those may be used for parallelism | 8 |
| `max_parallel_workers_per_gather` | how many a single Gather node may request at most | 2 |

- When there aren't enough workers the query doesn't fail: `Workers Launched` will be less than `Workers Planned`, parallelism degrades automatically, and it can still run with just the leader.

## Which Plans Can Be Parallelized

Parallel-capable execution nodes were opened up gradually by version; common capabilities:

- Parallel sequential scan (9.6); parallel index scan, index-only scan, bitmap heap scan (10); parallel Append (11, combined with partitioned tables).
- Parallel hash join (11, workers share one hash table, the plan node is called Parallel Hash), merge join, nested loop (outer side parallel).
- Aggregation: Partial/Finalize Aggregate (see below); `SELECT DISTINCT` (15).
- `CREATE INDEX` (btree from 11, GIN/BRIN too), `REFRESH MATERIALIZED VIEW` (14).

Scenarios that cannot be parallelized or are restricted:

- Cursors (FETCH after `DECLARE CURSOR`), `FOR ... IN query` loops in PL/pgSQL, do not produce parallel plans.
- Data-modifying nodes (ModifyTable, i.e. the write actions of INSERT/UPDATE/DELETE) always run on the leader; but the scans beneath them can be parallel in PG 11+ (e.g. `INSERT INTO ... SELECT`).
- **PARALLEL UNSAFE functions**: user-defined functions are UNSAFE by default; one appearing in the plan sends the entire subtree back to serial. This is one of the most common reasons for "why isn't my query parallel". The vast majority of built-in functions are SAFE.

```sql
CREATE FUNCTION is_hot(score numeric) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT score >= 90
$$;

-- Without a PARALLEL attribute it defaults to UNSAFE, and queries containing it won't parallelize
ALTER FUNCTION is_hot(numeric) PARALLEL SAFE;
```

## Parallel Cost and Threshold Parameters

The optimizer decides whether to parallelize and how many workers in two steps:

1. Is the table large enough: only tables exceeding `min_parallel_table_scan_size` (default 8MB) or `min_parallel_index_scan_size` (default 512KB) qualify. Each time the table size doubles, the candidate worker count increases by one.
2. Is the cost worthwhile: `parallel_setup_cost` (default 1000, the overhead of one process startup) plus `parallel_tuple_cost` (default 0.1, the overhead of passing each tuple across processes) is counted into the total cost; if it isn't cheaper than serial, give up.

Three entry points for controlling parallelism degree:

```sql
-- Global/session level: turn parallelism off entirely
SET max_parallel_workers_per_gather = 0;

-- Table level: directly specify this table's parallel scan degree, bypassing the cost model
ALTER TABLE big_fact SET (parallel_workers = 4);

-- Number of workers for parallel index creation (default 2)
SET max_parallel_maintenance_workers = 4;
```

Note that `ALTER TABLE ... SET (parallel_workers)` affects both ordinary parallel scans and parallel index creation; after tuning it's recommended to `RESET` it, to avoid long-term impact on other plans.

## Partial Aggregate and Finalize

Parallel aggregation happens in two segments: workers first each compute a partial result (Partial Aggregate), then the leader collects them and merges into the final value (Finalize Aggregate). `GROUP BY` that needs to merge by group is paired with `Gather Merge` to keep ordered output.

```sql
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF)
SELECT status, count(*) FROM orders GROUP BY status;
```

```plaintext
Finalize GroupAggregate (actual rows=3 loops=1)
  ->  Gather Merge (actual rows=9 loops=1)
        Workers Planned: 2
        Workers Launched: 2
        ->  Partial GroupAggregate (actual rows=3 loops=3)
              ->  Sort (actual rows=666667 loops=3)
                    ->  Parallel Seq Scan on orders (actual rows=666667 loops=3)
```

Key point: parallel aggregation requires the aggregate function to have a combine function; all built-in aggregates have one, while custom aggregates don't by default and therefore cannot parallelize.

## Confirming Parallelism in EXPLAIN

`EXPLAIN` (without ANALYZE) only shows `Workers Planned`; only with `ANALYZE` do you get `Workers Launched`, and each worker's actual row count shows as indented `loops=N` (cumulative across multiple rows; for how to read this see [EXPLAIN Basics](../performance/explain-basics)):

```sql
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF)
SELECT count(*) FROM orders;
```

To see what the parallel segment is busy with during execution, the worker's `leader_pid` in `pg_stat_activity` points to its leader:

```sql
SELECT pid, backend_type, leader_pid, wait_event_type, wait_event
FROM pg_stat_activity
WHERE backend_type = 'parallel worker';
```

## maintenance_work_mem and Parallel Index Creation

When creating indexes in parallel (btree/GIN/BRIN), `maintenance_work_mem` is the **upper limit for the entire index-creation operation (leader + all workers combined)**, not one share per person. The official requirement is that each worker gets at least 32MB and the leader keeps an extra 32MB, so an insufficient budget directly suppresses the number of workers actually requested. To get parallelism when indexing large tables, you have to raise this value accordingly (or explicitly specify it via `ALTER TABLE ... SET (parallel_workers)` as in the official docs).

## Notes and Common Pitfalls

- Parallel isn't necessarily faster: for small tables, tables fully in cache, and high-concurrency OLTP scenarios, the process startup and tuple transfer overhead is actually a negative benefit. The basis for judgment is comparing `EXPLAIN ANALYZE` before and after, not "the bigger it is, the more it should parallelize".
- `Workers Launched < Workers Planned` is mostly because `max_worker_processes`/`max_parallel_workers` are occupied by other sessions; this is normal degradation, but it means when "you set 4 workers but only 1 comes up", tuning `max_parallel_workers_per_gather` has no effect — look at the upper layer quota.
- Each parallel worker's sort and hash independently consume `work_mem`; the higher the parallelism degree, the larger the memory peak, for capacity planning see [Architecture and Memory](./architecture-and-memory).
- The same SQL parallelizing sometimes and not others (due to worker preemption): when investigating performance jitter, first fix the session's `max_parallel_workers_per_gather` before comparing.

## References

- [PostgreSQL Official Docs · 15.1. How Parallel Query Works](https://www.postgresql.org/docs/current/how-parallel-query-works.html)
- [PostgreSQL Official Docs · Chapter 51. Overview of PostgreSQL Internals](https://www.postgresql.org/docs/current/overview.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [index-selection-decision-tree](/indexing/index-selection-decision-tree.md)
- [index](index.md)- [Process Architecture](./process-architecture) — where backends and background processes come from.
- [Join Implementation Methods](./join-implementations) — the basis for choosing hash/merge/nested loop.
- [The Optimizer Cost Model](./optimizer-cost-model) — how parallel cost enters the total cost.
- [EXPLAIN Basics](../performance/explain-basics) — reading loops and row counts in parallel plans.

Official docs: <https://www.postgresql.org/docs/current/how-parallel-query-works.html>
