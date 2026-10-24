# VACUUM Stalls and Performance

VACUUM is normally the job that "gives performance back", but it spends IO, competes for buffers, and writes WAL—cleanup and business share the same disk and the same buffer pool. This page records the impact of autovacuum's throttling mechanism, how table bloat drags down queries, forced cleanup when transaction IDs approach their limit, and balancing cleanup speed against business load.

## Cost Delay: autovacuum's Built-in Throttler

autovacuum consumes cost credits per page processed (1 for a buffer hit, 2 for a read-in, 20 for a dirty), and once the accumulated credits pass the limit (default 200) it sleeps for delay milliseconds. Two parameters set the speed of this fan:

```plaintext
autovacuum_vacuum_cost_delay = 2ms    # how long each sleep lasts (default 2ms since PG 12)
autovacuum_vacuum_cost_limit = -1     # -1 means inherit vacuum_cost_limit (default 200)
```

Two key behaviors:

- **All workers share one budget**: the limit is "spread out" across concurrent workers, so with 3 workers each is effectively throttled to 200/3. Adding workers does not mean faster cleanup; raise cost_limit alongside them.
- **Workers that override the parameter per table do not participate in the spread**: a worker with its own `autovacuum_vacuum_cost_limit` set for a table computes independently and does not affect the global budget's allocation.

## VACUUM Contending for Buffers and IO

VACUUM deliberately uses a very small ring buffer (default 256KB, tunable via `vacuum_buffer_usage_limit` since PG 16) to avoid evicting hot pages from the buffer pool—but contention still exists, through three paths:

- **IO bandwidth**: reading dirty pages, writing dirty pages back, prewriting WAL—all on the same disk business work uses;
- **WAL traffic**: the cleanup itself generates WAL (dead tuple prune records, freeze records); heavy cleanup pushes WAL write volume up, see [WAL Mechanics](../internals/wal-mechanism);
- **Checkpoint pressure**: the batches of dirtied pages push checkpoints earlier, and a flush storm layered on a business peak is a double slowdown.

So the classic symptom of a VACUUM stall is "while cleanup is running, p95 latency lifts across the board while CPU stays low"—the bottleneck is the IO queue, not compute.

## Table Bloat: Every Query Slows Down

When cleanup cannot keep up, dead tuples pile up and tables and indexes bloat. It does not only affect that one table; it raises the baseline for the whole database:

- Sequential scans must read more physical pages (garbage pages are scanned and skipped too);
- Indexes get thicker, with B-tree levels and page counts climbing, so each point lookup reads a few extra blocks;
- Index-only scans depend on the visibility map (VM); when the VM is incomplete for long, it falls back to heap fetches, so even an indexed query reads the table.

Precise bloat measurement and REINDEX techniques are in [Index Bloat and Maintenance](../indexing/index-bloat-and-maintenance); the cleanup actions and the HOT optimization are in [VACUUM and HOT](../internals/vacuum-and-hot).

## xid Age Approaching 2 Billion: Forced Cleanup Storms

As transaction ID age nears the limit, the system forces cleanup forward in stages: once a table's age passes `autovacuum_freeze_max_age` (default 200 million), anti-wraparound VACUUM triggers—**it starts even if autovacuum is globally disabled**, and it is not cancelled automatically on lock conflicts. The risk is that it is rarely a single table: several large tables cross the threshold at once, and rounds of full table scans stack on a shared cost budget, potentially lasting hours or even days with IO occupied the whole time. Push it far enough that only 3 million of age remains and the system refuses to allocate new transaction IDs, leaving the business read-only.

```sql
-- daily sweep: age distribution across the whole cluster
SELECT datname, age(datfrozenxid) AS db_age
FROM pg_database
ORDER BY 2 DESC;

-- find the oldest tables
SELECT relname, age(relfrozenxid) AS rel_age
FROM pg_class
WHERE relkind IN ('r', 't', 'm')
ORDER BY 2 DESC LIMIT 10;
```

Put age under alerting (say, a warning at 500 million, severe at 1 billion) and clean proactively during off-peak, rather than waiting for the system to decide the timing for you. Alerting details are in [Monitoring and Alerting](../operations/monitoring-and-alerting).

## Which Metrics to Monitor

```sql
-- dead tuple share and the most recent cleanup times
SELECT relname,
       n_live_tup, n_dead_tup,
       round(n_dead_tup * 100.0 / greatest(n_live_tup, 1), 2) AS dead_pct,
       last_autovacuum, last_autoanalyze
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC LIMIT 20;

-- how far a running VACUUM has gotten (PG 12+)
SELECT * FROM pg_stat_progress_vacuum;
```

- `dead_pct` climbing steadily with `last_autovacuum` not updating: cleanup is behind, or blocked by a long transaction;
- `pg_stat_progress_vacuum` gives phase and heap_blks_scanned/heap_blks_total, from which you can estimate time remaining;
- `log_autovacuum_min_duration` (default 10min, can be lowered) logs the duration and volume of each cleanup round.

## Finding the Balance Point for Cost Limit

There is one goal: **cleanup speed >= garbage generation rate**, with acceptable IO headroom. Adjustment direction depends on your hardware and business trade-offs:

- Cleanup chronically behind (dead_pct climbing): raise `autovacuum_vacuum_cost_limit` to 1000-3000, or drop the delay to 0-1ms, plus per-table parameters to give hot tables more share;
- Business peaks are sensitive: keep the default throttle and instead run a manual `VACUUM` on large tables during off-peak. Note that a manual VACUUM follows `vacuum_cost_delay` (default 0, unthrottled) and is far more aggressive than autovacuum—schedule it inside a window;
- Prefer reducing garbage generation itself: lower the trigger threshold for small, frequently updated tables, and keep HOT-able updates on HOT chains—see [autovacuum Tuning](../internals/autovacuum-tuning).

## References

- [PostgreSQL Official Documentation · 24.1. Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html#VACUUM-FOR-WRAPAROUND)
- [PostgreSQL Official Documentation · 14.1. Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [autovacuum-tuning](/internals/autovacuum-tuning.md)
- [vacuum-and-hot](/internals/vacuum-and-hot.md)
- [knowledge](/knowledge.md)
- [monitoring-and-alerting](/operations/monitoring-and-alerting.md)
- [index](index.md)
- [lock-and-concurrency-bottlenecks](lock-and-concurrency-bottlenecks.md)- [autovacuum Tuning](../internals/autovacuum-tuning)——trigger formulas and the full parameter landscape.
- [VACUUM and HOT](../internals/vacuum-and-hot)——the cleanup actions and HOT's load-reduction mechanism.
- [Monitoring and Alerting](../operations/monitoring-and-alerting)——putting xid age and bloat under alerts.
- [Write Throughput Optimization](./write-throughput-optimization)——writing styles that reduce dead tuples at the source.

Official docs: <https://www.postgresql.org/docs/current/routine-vacuuming.html#VACUUM-FOR-WRAPAROUND>
