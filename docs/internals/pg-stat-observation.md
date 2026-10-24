# Observing With pg_stat

The built-in `pg_stat_*` view family in PostgreSQL is the entry point for database observation: what a session is doing, how a table is being read and written, how the instance's cache hit rate looks, where IO goes — all of it is visible without installing any extension. They are all **cumulative counters** (since some reset/restart), so the readings themselves mean nothing; only differences mean something. Here we walk the four layers "session → table → instance → IO" through the most commonly used views and their companion SQL. For statement-level timing statistics, see [pg_stat_statements](../performance/pg-stat-statements).

## The Statistics System and PG 15's Architectural Change

PG 14 and earlier, each process packed statistic events into UDP packets sent to a standalone stats collector process, which aggregated them and wrote a file — under high load UDP **drops packets**, so statistic drift happens. From PG 15 it changed to **shared memory**: processes update a local cache directly and flush into shared memory periodically; the packet-loss problem is eliminated and read consistency is better too.

The persistence change is worth remembering: on a normal shutdown, statistics are saved to the `pg_stat` subdirectory of the data directory and survive restarts; but **after crash recovery, an immediate shutdown, or a start from a base backup or PITR, all counters are cleared to zero**. When setting up monitoring baselines, account for the gap after a restart.

## pg_stat_activity: What Each Session Is Doing Right Now

The most useful set of fields: `state` (active / idle / **idle in transaction**), the paired `wait_event_type` + `wait_event` (reading/writing files, waiting for locks, waiting for CPU all have names), `query`, `backend_type`, `leader_pid` (a parallel worker points to its leader), and `backend_xmin` — the oldest transaction id held by that session's snapshot, which is what keeps VACUUM from doing its job.

```sql
-- Active and inactive profile: find idle in transaction and long transactions
SELECT pid, usename, state, wait_event_type, wait_event,
       now() - xact_start AS xact_age,
       now() - state_change AS idle_age,
       left(query, 60) AS query, backend_xmin
FROM pg_stat_activity
WHERE backend_type = 'client backend'
ORDER BY xact_start NULLS LAST;

-- Who holds the oldest xmin (the one blocking VACUUM)
SELECT pid, usename, state, backend_xmin,
       age(backend_xmin) AS xmin_age
FROM pg_stat_activity
ORDER BY age(backend_xmin) DESC NULLS LAST
LIMIT 5;
```

The key to reading `wait_event` is to look at them in pairs: `wait_event_type = Lock` combined with `pg_blocking_pids(pid)` finds the blocking source; `IO` means it is reading/writing files (normal busyness); only when `LWLock` appears in bulk does it need deep digging. For the complete wait-event reference table, see the monitoring-stats chapter of the official docs.

## pg_stat_user_tables: The Table-Level Read/Write Profile

```sql
SELECT relname,
       seq_scan, seq_tup_read, idx_scan,
       n_tup_ins + n_tup_upd + n_tup_del AS writes,
       n_dead_tup, n_mod_since_analyze,
       last_autovacuum, last_autoanalyze
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 10;
```

Typical readings: `seq_scan` high while `idx_scan` is 0 → a candidate for a missing index; a high share of `n_dead_tup` or `last_autovacuum` NULL → autovacuum can't keep up (threshold and stall investigation in [autovacuum Tuning](./autovacuum-tuning)); a large `n_mod_since_analyze` → statistics are stale and the plan may be off. Since PG 13, manual and automatic vacuum counts are separate (`vacuum_count` vs `autovacuum_count`), so attribution no longer relies on guesswork.

## pg_stat_database: Instance-Level Health

```sql
SELECT datname,
       xact_commit, xact_rollback,
       round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2) AS cache_hit_pct,
       temp_files, pg_size_pretty(temp_bytes) AS temp_written,
       deadlocks
FROM pg_stat_database
WHERE datname NOT LIKE 'template%';
```

- `cache_hit_pct` is the **shared_buffers** hit rate, where 99% or more is normal; it does not include the OS page cache, so "a low hit rate" does not mean it is actually slow — pair it with `pg_stat_io` to see the actual disk reads.
- `temp_files/temp_bytes` growing = sorts/hashes spilling to disk, a direct signal that `work_mem` is too small.
- An abnormally rising `xact_rollback / xact_commit` ratio usually points at deadlock retries in the application or abnormal connection-pool behavior.

## pg_stat_io (PG 16+)

It counts reads, writes, hits, extends, evictions, fsyncs, and so on across three dimensions — backend_type × IO object (relation/temp, plus wal from PG 17) × context (normal / vacuum / checkpoint) — with `op_bytes` marking the unit. It is the first time "who actually produced the IO" is broken down — for example VACUUM reads no longer mix into the normal context:

```sql
SELECT backend_type, context, io_object,
       SUM(reads) AS reads, SUM(hits) AS hits, SUM(writes) AS writes
FROM pg_stat_io
WHERE io_object = 'relation'
GROUP BY backend_type, context, io_object
ORDER BY reads DESC;
```

With `track_io_timing = on` it also records `read_time/write_time` (added in PG 17), which directly answers "which class of process is waiting on IO". The official docs give a full set of usage examples: many client-backend reads means insufficient cache, many checkpointer writes means checkpoints are too aggressive, and so on.

## reset and the Statistics Lifecycle

```sql
SELECT pg_stat_reset();                              -- clear all cumulative statistics for the current database
SELECT pg_stat_reset_single_table_counters('orders'::regclass);  -- clear just one table
SELECT pg_stat_statements_reset();                   -- separately clear the pg_stat_statements extension
```

Usage discipline: a reset is a global action (within this database), there is no undo, so don't reset casually during peak hours; for A/B comparisons, "note the current value first, then take the difference after an interval" is safer than resetting. For the PG 15+ crash-clearing behavior see above — the first day's baseline after a restart has to be rebuilt.

## Notes and Common Pitfalls

- All views are **eventually consistent**: processes flush into shared memory only after accumulating a little, and `pg_stat_activity` is the exception (it is a live snapshot, not cumulative counters). Using counters for second-level alerts produces sawtooths.
- Collecting statistics has overhead of its own, but the default settings (`track_counts=on`, `track_activities=on`) are the production standard; turning them off saves little and blinds you.
- Table-level and instance-level statistics accumulate independently on the standby, so primary and standby numbers cannot be directly added and compared.

## References

- [PostgreSQL Official Docs · 27.2. The Cumulative Statistics System](https://www.postgresql.org/docs/current/monitoring-stats.html)
- [PostgreSQL Official Docs · 27.2. The Cumulative Statistics System](https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-IO-VIEW)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [system-catalogs-and-metadata](/basics/system-catalogs-and-metadata.md)
- [materialized-views](/database-design/materialized-views.md)
- [postgresql-16-features](/ecosystem/postgresql-16-features.md)
- [architecture-and-memory](architecture-and-memory.md)
- [index](index.md)
- [process-architecture](process-architecture.md)
- [knowledge](/knowledge.md)
- [monitoring-and-alerting](/operations/monitoring-and-alerting.md)
- [explain-analyze-buffers](/performance/explain-analyze-buffers.md)
- [lock-and-concurrency-bottlenecks](/performance/lock-and-concurrency-bottlenecks.md)
- [pg-stat-statements](/performance/pg-stat-statements.md)
- [audit](/security/audit.md)
- [troubleshooting-toolbox](/tools/troubleshooting-toolbox.md)- [autovacuum Tuning](./autovacuum-tuning) — the next step for abnormal n_dead_tup.
- [pg_stat_statements](../performance/pg-stat-statements) — the other half of statement-level timing observation.
- [Monitoring and Alerting](../operations/monitoring-and-alerting) — turn this page's SQL into alert items.
- [EXPLAIN ANALYZE and buffers](../performance/explain-analyze-buffers) — IO observation at single-query granularity.

Official docs: <https://www.postgresql.org/docs/current/monitoring-stats.html> and <https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-IO-VIEW>
