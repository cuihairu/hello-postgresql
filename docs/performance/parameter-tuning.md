# Parameter Tuning

Parameter tuning is not memorizing a table of values; it is understanding, for each parameter, "what it allocates resources for, and what going wrong costs". This page gives a starting point grounded in memory and hardware, explains the three paths to changing a parameter and how they take effect, and ends with common misconfigurations. Every change should be tested before it is made, one variable at a time.

## Starting Guidance

The following starting points assume a dedicated database server (memory denoted RAM); each item comes with the "why":

```plaintext
shared_buffers = RAM × 25%            # default is only 128MB, must change
effective_cache_size = RAM × 50%~75%  # tells the planner the size of the OS cache
work_mem = 16MB~64MB to start, cap it against concurrency
maintenance_work_mem = 512MB~1GB      # used by VACUUM/CREATE INDEX
random_page_cost = 1.1                # SSD/NVMe; the default 4.0 is a spinning-disk era value
max_wal_size = 4GB~8GB                # the default 1GB is small for write-heavy databases
```

- `shared_buffers`: PostgreSQL's own buffer pool. 25% is the widely accepted starting point; returns diminish past 40%—beyond that the OS page cache caches the same pages, forming double caching with each side holding its own copy of memory.
- `effective_cache_size`: only affects the planner's judgment of "index scan or sequential scan", and **allocates no memory at all**. Set it too low and the planner underestimates the benefit of index scans.
- `work_mem`: memory for **each sort/hash node**, not a per-connection total. The global value must be estimated for worst-case concurrency:

```plaintext
worst-case peak ≈ max_connections × average sort/hash nodes per query × work_mem
```

  Example: 200 connections × an average of 2 nodes × 64MB = 25.6GB, which stacked on other memory can OOM. Keep the global value small; give individual complex queries `SET work_mem = '512MB'` in their session.
- `maintenance_work_mem`: used by maintenance operations like VACUUM, CREATE INDEX, and REINDEX; giving 1GB during an index rebuild on a large table is visibly faster. The autovacuum workers' share is separately constrained by `autovacuum_work_mem`.
- `random_page_cost`: in the planner's model, the cost of one random page read relative to one sequential read. On SSD/NVMe, 1.1 is a common value that lets the planner pick indexes more readily; on spinning disks keep the default 4.0. Alongside it, `effective_io_concurrency` can also be raised to around 200 on SSDs.
- `max_wal_size`: not a hard "no more than this much WAL" limit, but a soft target for the checkpoint interval. Undersize it on a write-heavy database and checkpoints fire constantly, with visible IO jitter.

## Three Paths to Changing a Parameter

```sql
-- 1. ALTER SYSTEM: writes postgresql.auto.conf, takes effect at instance level, the most common
ALTER SYSTEM SET max_wal_size = '8GB';
SELECT pg_reload_conf();          -- reload-class parameters take effect immediately

-- 2. conf.d directory: postgresql.conf usually ends with include_dir = 'conf.d';
--    centralize your own settings into one file, easier to version and troubleshoot
-- 3. Edit postgresql.conf directly: for hand-managed bare metal
```

Precedence: `postgresql.auto.conf` (what ALTER SYSTEM writes) is read last and overrides `postgresql.conf` and the conf.d it includes. When the same parameter is scattered across files, use `SHOW max_wal_size;` to see the effective value, and `SELECT source FROM pg_settings WHERE name = 'max_wal_size';` to see which layer it came from.

## What Needs a Restart vs a Reload

Check `pg_settings.context`:

```sql
-- parameters changed but not yet effective until restart
SELECT name, setting, context, pending_restart
FROM pg_settings
WHERE pending_restart;
```

- `postmaster`: needs a restart. `shared_buffers`, `max_connections`, `wal_level`, `autovacuum_max_workers` are all in this class.
- `sighup`: a reload suffices, via `pg_reload_conf()` or `pg_ctl reload`. `max_wal_size`, `checkpoint_timeout`, `log_min_duration_statement`, and most others fall here.
- `superuser` / `user`: not even a reload needed; a superuser can SET globally, and any user can SET in their own session (`work_mem`, `random_page_cost`). This is exactly why "a large work_mem for one specific complex query" is workable.
- `internal`: fixed at initdb/compile time (like `block_size`), not your concern.

After changing a reload-class parameter, confirm it took: `SHOW max_wal_size;`.

## Test Before Changing, One Variable at a Time

- Change one parameter at a time; after each change, compare TPS and p95 latency with a benchmark or a production traffic replay (methods in [Benchmark Tools](./benchmark-tools)), and watch a full business cycle before touching the next one.
- Build the baseline first: record pg_stat_statements top-query timings and checkpoint counts (`pg_stat_bgwriter`, split out as `pg_stat_checkpointer` in PG 17), and read the same metrics before and after the change.
- Land changes in a config file under version control; ALTER SYSTEM is for emergencies—sync the value back to conf.d afterwards to avoid the two drifting apart.
- No parameter is a silver bullet: the same set of values behaves completely differently under different loads (OLTP small transactions vs report-scale queries); building your own baseline beats copying someone else's config.

## Common Misconfigurations

- **A huge global work_mem (512MB and up)**: it is per node, per connection; at peak it stacks up to tens of GB and the OOM killer arrives. Be conservative globally, tune heavy queries per session.
- **shared_buffers at 60%+**: double caching wastes memory and adds lock-management overhead; start at 25% and add only with test evidence.
- **Treating effective_cache_size as memory that gets allocated**: it is only a planner assumption. Conversely, `work_mem` and `maintenance_work_mem` are really allocated—do not confuse the two.
- **max_connections casually at 1000**: each connection is a separate process; base memory + work_mem stack up, and scheduling overhead grows with connection count. Use a connection pool to converge the active connection count, see [Connection and ORM Optimization](./connection-and-orm-optimization).
- **Tuning memory but not max_wal_size**: on a write-heavy database, frequent checkpoints trigger flush storms that eat the gains of buffer tuning—look at both together.

## References

- [PostgreSQL Official Documentation · 19.1. Setting Parameters](https://www.postgresql.org/docs/current/config-setting.html)
- [PostgreSQL Official Documentation · Chapter 19. Server Configuration](https://www.postgresql.org/docs/current/runtime-config.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [architecture-and-memory](/internals/architecture-and-memory.md)
- [autovacuum-tuning](/internals/autovacuum-tuning.md)
- [checkpoint-and-buffer](/internals/checkpoint-and-buffer.md)
- [connection-management](/operations/connection-management.md)
- [benchmark-tools](benchmark-tools.md)
- [common-bad-plans](common-bad-plans.md)
- [index](index.md)
- [write-throughput-optimization](write-throughput-optimization.md)- [Optimizer Cost Model](../internals/optimizer-cost-model)——how random_page_cost and friends influence plan choice.
- [Checkpoint and Buffer](../internals/checkpoint-and-buffer)——the mechanics behind max_wal_size.
- [Write Throughput Optimization](./write-throughput-optimization)——other levers available on the write path.
- [Common Errors and Troubleshooting](../appendix/common-errors-and-troubleshooting)——symptom lookup for OOM and memory overruns.

Official docs: <https://www.postgresql.org/docs/current/config-setting.html> and <https://www.postgresql.org/docs/current/runtime-config.html>
