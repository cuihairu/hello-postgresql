# pg_stat_statements

pg_stat_statements is the built-in SQL execution statistics extension: it aggregates total time, call counts, rows, buffers, and WAL usage per normalized statement, and is the standard answer to "which SQL statements are consuming database resources over the long run". It is the collection step for the first stage of slow query governance; the full workflow is in [A Slow Query Governance Workflow](./slow-query-governance).

## Installing and Enabling

Enabling the extension takes two steps, and neither can be skipped. The first hooks the module into shared memory from `postgresql.conf` (requires an instance restart):

```plaintext
# postgresql.conf
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.max = 10000        # how many statements to track at most, default 5000
pg_stat_statements.track = top        # top=track only top-level statements (default); all=include nested
pg_stat_statements.track_utility = on # whether to track utility statements (SET/COPY/PREPARE, etc.)
```

The second creates the extension in the target database:

```sql
CREATE EXTENSION pg_stat_statements;
SELECT * FROM pg_stat_statements LIMIT 1;   -- if this returns rows, it is working
```

After changing `shared_preload_libraries` you must restart; running only `CREATE EXTENSION` without a restart leaves the view present but its statistics permanently empty. To see planning time separately from execution, PG 13+ already has a `total_plan_time` column, no extra configuration needed. Managed cloud databases usually pre-load this extension, so a single `CREATE EXTENSION` is enough.

## Key Columns

The view has many columns; day to day, watch these:

| Column | Meaning | Use |
| --- | --- | --- |
| `calls` | Number of calls | High-frequency + low-latency statements are worth governing too |
| `total_exec_time` | Cumulative execution time (milliseconds) | Rank by total resource consumption |
| `mean_exec_time` | Average per-call time = total/calls | Rank by single-call experience |
| `rows` | Cumulative rows returned or affected | An abnormally large rows/calls usually means a missing LIMIT or a full pull |
| `shared_blks_hit` / `shared_blks_read` | Buffered blocks hit/read | A low hit ratio means the query is hauling data from disk into memory |
| `temp_blks_written` | Blocks written to temp files | Points directly at sort/aggregate spilling, see [Sort Spilling to Disk](./common-bad-plans) |
| `wal_bytes` | WAL bytes produced (PG 13+) | Assess write amplification and replication pressure |
| `total_exec_time` split from `total_plan_time` (PG 13+) | Plan and execute counted separately | A high planning share means the SQL is overly complex or statistics are jittering |

PG 17 renamed the IO timing columns: `blk_read_time`/`blk_write_time` became `shared_blk_read_time`/`shared_blk_write_time`, and added columns such as `local_blk_read_time`, so monitoring SQL that crosses versions needs updating too. Timing columns are only nonzero with `track_io_timing = on` (it carries a real cost).

## Query Normalization and queryid

pg_stat_statements aggregates by **query structure**: constants are folded into `$1` placeholders, so `WHERE user_id = 42` and `WHERE user_id = 99` count as the same statement and share one statistics row. The aggregation key `queryid` is a hash of the parsed query tree:

```sql
SELECT queryid, calls, query FROM pg_stat_statements
WHERE query LIKE '%orders%' LIMIT 3;
```

```plaintext
queryid                 | calls | query
-7939279735244372691    | 85230 | SELECT * FROM orders WHERE user_id = $1
 6644210390673785246    |   931 | SELECT * FROM orders WHERE status = $1 LIMIT $2
```

Key points and boundaries:

- `queryid` is not guaranteed stable across restarts or versions; for long-term comparison, key on the normalized text (the `query` column) or take your own periodic snapshots.
- Identical text with different `search_path`s or parameter types can land on different queryids, so two "identical" queries splitting into two rows is normal.
- Normalization works on literals but does not understand data distributions—`status = 'paid'` (250,000 rows) and `status = 'weird-rare'` (1 row) merge into one statistic, so mean_exec_time is a mixed average; when investigating parameter-sensitive problems use the actual parameters from `pg_stat_activity` or the logs.
- `track_utility = off` silences noisy statements like SET/COMMIT; `track = all` also counts nested queries inside function bodies (slightly more overhead).

## Top 10 Slow Query Templates

Two useful ranking angles: total resource consumption (impact on the database as a whole) and average per-call time (impact on user experience), filtering out low-frequency statements to avoid noise:

```sql
-- by total time: the 10 most resource-hungry
SELECT calls,
       round(total_exec_time::numeric / 1000, 1)          AS total_s,
       round(mean_exec_time::numeric, 2)                  AS mean_ms,
       rows,
       round(100.0 * shared_blks_hit
             / nullif(shared_blks_hit + shared_blks_read, 0), 1) AS hit_pct,
       temp_blks_written,
       left(regexp_replace(query, '\s+', ' ', 'g'), 80)   AS query
FROM pg_stat_statements
WHERE calls > 100
ORDER BY total_exec_time DESC
LIMIT 10;

-- by average time: the 10 slowest per call
SELECT calls, round(mean_exec_time::numeric, 2) AS mean_ms,
       left(query, 80) AS query
FROM pg_stat_statements
WHERE calls > 100
ORDER BY mean_exec_time DESC
LIMIT 10;
```

Read queries with `hit_pct` under 90% deserve a look at the plan (very likely a full table scan); a nonzero `temp_blks_written` means sort spilling. Put these two queries in your monitoring dashboard and snapshot or persist them regularly—that is your governance baseline. Templates are in [Monitoring and Alerting](../operations/monitoring-and-alerting).

## reset and the Collection Cycle

Statistics accumulate from when the extension was enabled; `pg_stat_statements_reset()` zeroes them out (PG 14+ supports precise resets per user/database/queryid), and `pg_stat_statements_info` records the last reset time and deallocation count:

```sql
SELECT pg_stat_statements_reset();            -- reset everything
SELECT pg_stat_statements_reset(NULL, NULL, -7939279735244372691);  -- PG 14+, reset one queryid
SELECT dealloc, stats_reset FROM pg_stat_statements_info;
```

Two usage rhythms:

- **Cumulative observation**: never reset; periodically (say, hourly) snapshot the rows you care about into your own table and use the deltas to compute "incremental time this hour". Good for a long-term baseline.
- **Periodic reset**: reset daily/weekly and accumulate for one cycle before looking at the full ranking. Good for an ad-hoc focused investigation.

A steadily growing `dealloc` means `pg_stat_statements.max` is too small and hot entries are being evicted; raising it requires a restart. Note that a reset affects every monitor reading this view—align with your team before doing it.

## Complementary to pg_stat_activity

The two answer questions about different tenses:

- **pg_stat_statements is historical aggregation**: over the past interval, who was slowest and how many times it was called—answering "who should be governed".
- **pg_stat_activity is a current snapshot**: what each connection is running right now, in what state, and which lock it waits on—answering "who is slowing whom down, right now".

A typical pairing: pg_stat_statements shows a statement's mean_exec_time climbing from 5ms to 500ms, then use `pg_stat_activity` to see which wait event it is currently stuck on:

```sql
SELECT pid, wait_event_type, wait_event, state, left(query, 60) AS query
FROM pg_stat_activity
WHERE state <> 'idle' AND wait_event_type IS NOT NULL;
```

`wait_event_type = Lock` goes to lock investigation ([Lock Conflict Troubleshooting](../internals/lock-conflict-troubleshooting)), `IO/DataFileRead` goes to cache and scan problems, `LWLock/buffer_content` is usually hot-block contention.

## Caveats and Common Pitfalls

- Forgetting `shared_preload_libraries` is the most common failure: `CREATE EXTENSION` succeeds but statistics stay empty until after a restart.
- `total_exec_time` excludes network transfer and client-side processing time, so the latency felt at the application layer can be far larger.
- Normalization merges statistics across different parameters; in parameter-skewed scenarios, verify a single execution against the logs or `pg_stat_activity`.
- `track = all` is noticeably expensive on databases that call many PL/pgSQL functions; turn it on only if you have confirmed the need.
- Querying the view has a cost itself; keep polling intervals of at least 10 seconds for high-frequency monitors, and select fixed columns to avoid expanding full rows.
- An extension upgrade (`ALTER EXTENSION pg_stat_statements UPDATE;`) resets statistics when crossing major versions—expect it in your upgrade window.

## References

- [PostgreSQL Official Documentation · 14.1. Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)
- [PostgreSQL Official Documentation · Chapter 14. Performance Tips](https://www.postgresql.org/docs/current/performance-tips.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [A Slow Query Governance Workflow](./slow-query-governance)
- [EXPLAIN (ANALYZE, BUFFERS, WAL)](./explain-analyze-buffers)
- [Observing Statistics](../internals/pg-stat-observation)
- [extension-management](/ecosystem/extension-management.md)
- [when-to-choose-postgresql](/ecosystem/when-to-choose-postgresql.md)
- [pg-stat-observation](/internals/pg-stat-observation.md)
- [plan-cache-and-generic-plan](/internals/plan-cache-and-generic-plan.md)
- [process-architecture](/internals/process-architecture.md)
- [query-execution-pipeline](/internals/query-execution-pipeline.md)
- [version-upgrade](/operations/version-upgrade.md)
- [common-bad-plans](common-bad-plans.md)
- [index](index.md)
- [slow-query-governance](slow-query-governance.md)
Official docs: [pg_stat_statements](https://www.postgresql.org/docs/current/pgstatstatements.html), [The Statistics Collector](https://www.postgresql.org/docs/current/monitoring-stats.html).
