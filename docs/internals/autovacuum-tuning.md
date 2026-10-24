# Autovacuum Tuning

autovacuum is woken periodically by the launcher process, which dispatches workers to run VACUUM/ANALYZE for tables that have crossed the trigger thresholds. The default settings are aimed at "small tables, light writes", so for large tables and high-update workloads they are usually too conservative — the result is dead tuples piling up, with tables and indexes bloating. Tuning mostly means two things: making the trigger conditions keep up with each table's update rate, and making the rate limits keep up with the hardware's IO capability.

## The trigger formula, and the pitfalls of the defaults

For each table, vacuum is triggered when the following holds:

```plaintext
dead tuples > autovacuum_vacuum_threshold (default 50)
             + autovacuum_vacuum_scale_factor (default 0.2) × estimated row count in the table
```

The scale_factor is designed around "clean once dead tuples reach 20%", which is far too lax for large tables: a table with 100 million rows does not trigger until roughly 20 million dead tuples have accumulated, and during that whole time every scan is skipping 20 million pieces of garbage — the table and its indexes are already noticeably bloated. Analyze triggers the same way (`autovacuum_analyze_scale_factor`, default 0.1).

## Per-table parameter overrides

For large tables and hot tables, per-table overrides are the most effective tool — there is no need to apply a single rule globally:

```sql
ALTER TABLE big_table SET (
  autovacuum_vacuum_scale_factor = 0.01,   -- 1% instead of 20%
  autovacuum_vacuum_threshold = 10000
);

-- See which tables have per-table overrides
SELECT n.nspname, c.relname, c.reloptions
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.reloptions IS NOT NULL
  AND n.nspname NOT IN ('pg_catalog', 'information_schema');
```

Lowering `autovacuum_vacuum_scale_factor` globally to 0.02–0.05 is also common practice, at the cost of vacuum triggering more often — you need to check the IO budget (see the next section).

## Rate limiting: cost limit and cost delay

autovacuum spends a certain number of "cost points" per page or dead tuple it processes, and once the points exceed the limit it sleeps for `delay` milliseconds — this is autovacuum's built-in IO rate limiter:

- `autovacuum_vacuum_cost_delay`: how long each sleep lasts, default 2ms (lowered from 20ms in PG 12, so autovacuum runs faster by default now);
- `autovacuum_vacuum_cost_limit`: the point ceiling, default -1, meaning it inherits `vacuum_cost_limit` (default 200);
- **All concurrent workers share the same budget**: with 3 workers each can effectively use only limit/3, so adding workers does not speed cleanup up proportionally — raise cost_limit at the same time.

On instances with good hardware (NVMe, a large buffer pool) where cleanup chronically falls behind, raise cost_limit to 1000–3000, or drop delay to 0–1ms. Conversely, if you worry that cleanup will interfere with daytime business, keep the defaults or even increase delay so cleanup is slower and gentler.

## Naptime and worker count

- `autovacuum_naptime` (default 1 minute): the launcher wakes up every interval of this length to dispatch workers for the databases that need cleanup. A smaller naptime means a shorter delay between a dead tuple being "created" and being "noticed";
- `autovacuum_max_workers` (default 3): the ceiling on simultaneously working workers. A multi-database instance, or one with hotspots concentrated on a few tables, can go to 6–8. Each worker's memory is bounded by `autovacuum_work_mem` (default: takes `maintenance_work_mem`), so adding workers requires checking memory and the shared cost budget together.

## Insert-only tables: the vacuum_insert trigger (PG 13+)

Tables that only insert and never update or delete (log tables, ledger tables) never accumulate enough dead tuples, so under the old formula they would never be vacuumed — old tuples never get frozen and the VM is never completed, which hurts transaction ID wraparound defense and index-only scans. PG 13 added an insert trigger:

```plaintext
rows inserted > autovacuum_vacuum_insert_threshold (default 1000)
               + autovacuum_vacuum_insert_scale_factor (default 0.2) × row count
```

Meeting this triggers vacuum (even with no dead tuples at all), used to advance freezing and complete the VM. For large ledger tables it is likewise worth overriding insert_scale_factor to a smaller value per table.

## Diagnosing: did it run, why is it slow, why is it not helping

```sql
-- A full listing of the global parameters
SELECT name, setting, unit FROM pg_settings
WHERE name LIKE 'autovacuum%' ORDER BY name;
```

```sql
-- Dead tuples and cleanup history per table; an empty last_autovacuum means it has never triggered
SELECT relname, n_live_tup, n_dead_tup, autovacuum_count, last_autovacuum
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 20;
```

```sql
-- autovacuum currently running, and its phase
SELECT v.pid, v.phase, v.heap_blks_scanned, v.heap_blks_vacuumed, p.query
FROM pg_stat_progress_vacuum v
JOIN pg_stat_activity p ON p.pid = v.pid;
```

If a worker is running but `n_dead_tup` does not come down, cleanup range is usually being blocked — dead tuples newer than the "oldest active snapshot" cannot be cleaned at all:

```sql
-- Who is holding back the xmin horizon: long transactions
SELECT pid, usename, state, now() - xact_start AS xact_age, backend_xmin, query
FROM pg_stat_activity
WHERE backend_xmin IS NOT NULL
ORDER BY xact_start
LIMIT 10;

-- An unconsumed replication slot blocks cleanup the same way (the standby keeps old versions around)
SELECT slot_name, active, xmin, catalog_xmin
FROM pg_replication_slots
WHERE xmin IS NOT NULL OR catalog_xmin IS NOT NULL;
```

The instance log records an `automatic vacuum of table ...` entry at the end of each autovacuum round, including the time spent in each phase. If the logs show cleanup is happening all along yet the table keeps bloating, head in the direction of the two kinds of "cleanup-blocking" checks above.

## Notes and common pitfalls

- autovacuum cannot clean versions that a transaction currently needs. Fix long transactions and abandoned replication slots first, then talk about tuning parameters. See [VACUUM Stalls and Performance](../performance/vacuum-stall-and-performance).
- Per-table parameter changes take effect immediately, with no restart.
- Aggressive global tuning (such as scale_factor 0.001) makes vacuum scan large tables frequently. Evaluate the total IO budget together with cost_delay and worker count; for related memory and IO parameters see [Parameter Tuning](../performance/parameter-tuning).
- A manual `VACUUM` is not governed by autovacuum's rate-limit parameters (it follows `vacuum_cost_limit` itself), so during emergency cleanup of a large table it may hit harder than autovacuum does.

## References

- [PostgreSQL official documentation · 24.1. Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html#AUTOVACUUM)
- [PostgreSQL official documentation · Chapter 51. Overview of PostgreSQL Internals](https://www.postgresql.org/docs/current/overview.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [constraints-and-data-quality](/database-design/constraints-and-data-quality.md)
- [postgresql-17-features](/ecosystem/postgresql-17-features.md)
- [when-to-choose-postgresql](/ecosystem/when-to-choose-postgresql.md)
- [gin](/indexing/gin.md)
- [index-bloat-and-maintenance](/indexing/index-bloat-and-maintenance.md)
- [index](index.md)
- [lock-conflict-troubleshooting](lock-conflict-troubleshooting.md)
- [mvcc-and-multi-version](mvcc-and-multi-version.md)
- [pg-stat-observation](pg-stat-observation.md)
- [process-architecture](process-architecture.md)
- [vacuum-and-hot](vacuum-and-hot.md)
- [knowledge](/knowledge.md)
- [disaster-recovery-drills](/operations/disaster-recovery-drills.md)
- [statistics-and-analyze](/performance/statistics-and-analyze.md)
- [vacuum-stall-and-performance](/performance/vacuum-stall-and-performance.md)- [VACUUM and HOT](./vacuum-and-hot) — the cleanup action itself, and the load HOT takes off it.
- [VACUUM Stalls and Performance](../performance/vacuum-stall-and-performance) — scenarios where cleanup and business contend for IO.
- [Parameter Tuning](../performance/parameter-tuning) — the full picture of related memory and IO parameters.
- [Index Bloat and Maintenance](../indexing/index-bloat-and-maintenance) — precise bloat measurement and REINDEX.

Official docs: <https://www.postgresql.org/docs/current/routine-vacuuming.html#AUTOVACUUM>
