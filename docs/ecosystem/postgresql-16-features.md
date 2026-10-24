# PostgreSQL 16 Highlights

PostgreSQL 16 was released on September 14, 2023. It is a "solidify the foundations" release: few new syntactic features, with the weight on logical replication usability, I/O observability (pg_stat_io), and fine-grained improvements to the executor and vacuum. Below I group the entries that matter most to day-to-day development and operations; the full list is in the [official release notes](https://www.postgresql.org/docs/release/16.0/).

## SQL and Queries

- **Presorted aggregates**: aggregates carrying `ORDER BY` or `DISTINCT` (such as `string_agg(x ORDER BY y)` or `count(DISTINCT id)`) can now reuse the ordering already present in the input, skipping an internal sort. The optimizer switch is `enable_presorted_aggregate`; turn it off to compare plans if you suspect the planner chose worse.
- **`string_agg()` / `array_agg()` run in parallel**: these two commonly used aggregates could not previously appear in parallel plans; aggregating large tables can now spread across multiple workers.
- **SQL/JSON constructors**: the standard SQL `JSON_ARRAY()`, `JSON_OBJECT()`, `JSON_ARRAYAGG()`, `JSON_OBJECTAGG()` and the `IS JSON` validation syntax are now available, so building JSON no longer means hand-splicing strings.
- **`ANY_VALUE()` aggregate**: picks "any one row's value in the group" after a GROUP BY, without the `array_agg(...)[1]` or `max()` workarounds. This requires the SQL to accept "any value" semantics for real.
- **`EXPLAIN (GENERIC_PLAN)`**: inspect the shape of a generic prepared plan without executing the statement. Very useful when tracking down slow queries from application-side bind variables. See [Plan Cache and Generic Plans](../internals/plan-cache-and-generic-plan).
- **Other**: `COPY FROM` supports the `DEFAULT` option for columns; `FROM` subqueries no longer require an alias; `0x`/`0o`/`0b` radix literals and digit-grouping underscores (`1_000_000`); `date_add()` / `date_subtract()` with time zones.

```sql
-- ANY_VALUE: take any one order status within the group
SELECT user_id, count(*) AS cnt, any_value(status) AS one_status
FROM orders
GROUP BY user_id;

-- Presorted aggregate: if there is an index on (user_id, created_at), the sort can be reused
SELECT user_id, string_agg(order_no, ',' ORDER BY created_at) AS timeline
FROM orders
GROUP BY user_id;
```

## Executor and Performance

- **Parallel hash joins for `FULL` and right outer joins**: these two join kinds could not be parallelized before, so wide analytical queries now get more complete parallel coverage.
- **Incremental sort in more places**: several plan shapes, including `DISTINCT`, can use incremental sort to avoid a full sort.
- **Relaxed HOT update conditions**: rows that only update BRIN-indexed columns can now take the HOT path, lowering the update cost of large time-series tables (which often use BRIN).
- **Memoize for `UNION ALL`**: repeated parameterized subplan results can be cached.
- **Faster vacuum freezing**: ordinary vacuum freezes suitable pages along the way, reducing the need for dedicated full-table freeze operations and giving the `xid` horizon more headroom.
- **`VACUUM (BUFFER_USAGE_LIMIT ...)`**: set the buffer ring size independently for manual vacuum / autovacuum (default 256kB), so a hand-run vacuum does not evict the shared buffers.
- **SIMD vectorization**: vectorized instructions on the ASCII and JSON string search paths, and in `COPY FROM` parsing.

```sql
-- See how vacuum affects shared buffers afterward; you can cap its footprint
VACUUM (VERBOSE, BUFFER_USAGE_LIMIT '8MB') big_table;
```

## Replication

- **Logical decoding on standbys**: a logical slot can be created on a physical standby (with `pg_log_standby_snapshot()`), so you can extract changes from a standby when the primary is under heavy load.
- **Parallel apply of large transactions**: `CREATE SUBSCRIPTION ... WITH (streaming = parallel)` lets the subscriber replay an in-flight large transaction with parallel workers, reducing latency spikes on the subscriber.
- **`ORIGIN` option prevents replication loops**: a subscriber can declare that it only replays changes with no origin. This is the key prerequisite for building bidirectional / multi-master topologies; full bidirectional logical replication lands in [PostgreSQL 17](./postgresql-17-features).
- **`REPLICA IDENTITY FULL` uses an index**: logical replication can locate the old row via a btree index rather than a full table scan, noticeably reducing the cost of replicating wide tables.

```sql
-- Create a logical slot on a standby (requires wal_level = logical, run on the standby)
SELECT pg_create_logical_replication_slot('app_slot', 'pgoutput');
SELECT pg_log_standby_snapshot();
```

## Monitoring and Observability

- **The `pg_stat_io` view**: counts read/write hits, evictions, reuses, and fsyncs broken down by backend type (normal / vacuum / autovacuum, etc.), I/O object, and context. Cache hit rates can finally be attributed to "who is reading". This is PG 16's most worthwhile observability upgrade; see [The pg_stat Observation Stack](../internals/pg-stat-observation).
- **Last-access timestamps**: views such as `pg_stat_all_tables` gain columns like `last_seq_scan` and `last_idx_scan`, so "which tables/indexes nobody really uses" finally has a direct answer.
- **Other**: the `n_tup_newpage_upd` counter for UPDATEs that move to a new page; `pg_locks` exposes speculative lock information; `SYSTEM_USER()` returns the authentication method and authenticated identity, making it easier to distinguish audit sources.

```sql
SELECT * FROM pg_stat_io WHERE backend_type = 'autovacuum worker';

SELECT relname, last_seq_scan, last_idx_scan
FROM pg_stat_user_tables
ORDER BY last_idx_scan NULLS FIRST
LIMIT 10;
```

## Security and Permissions

- **Regular expressions in `pg_hba.conf`**: entries for usernames and database names that begin with `/` are matched as regular expressions, so the rule count can be brought under control.
- **Tighter CREATEROLE**: a CREATEROLE role can no longer change "roles created by someone else" by default; administering membership requires `ADMIN OPTION`, shrinking the pitfall around role self-governance boundaries.
- **Explicit role inheritance**: `GRANT ... WITH INHERIT TRUE/FALSE` and `GRANT ... SET` control inheritance and role switching at per-role granularity, making least-privilege grants finer when combined with [Roles and Permissions](../security/roles-and-permissions).
- **The predefined role `pg_create_subscription`**: non-superusers get a dedicated role for creating subscriptions, so you no longer have to grant `CREATEDB` or superuser rights.
- **Client-side `require_auth`**: libpq can require that a connection authenticate through a specified method, preventing a silent downgrade to `trust`.
- **`scram_iterations`**: tune the SCRAM-SHA-256 iteration count, trading off login cost against offline cracking difficulty.

## Backup and Maintenance

- **pg_dump supports LZ4 / Zstandard compression**, with tunable options on both backup time and decompression speed at restore.
- **Finer pg_basebackup compression options**: syntax like `--compress=server-5` spells out "which end compresses + level", so you can let the server absorb compression when network bandwidth is tight.
- **Relaxed pg_upgrade requirements**: the new cluster's locale / encoding no longer has to match the old cluster exactly (though it still has to match at the database level).
- **vacuumdb works per schema** (`--schema` / `--exclude-schema`); `VACUUM` gains options such as `PROCESS_MAIN` and `SKIP_DATABASE_STATS`, making scripted maintenance more controllable.

```bash
# Physical backup with server-side zstd compression
pg_basebackup -D /backup/base -X stream --compress=server-zstd
```

Note: block-level **incremental backup is not a PG 16 feature**. `pg_basebackup --incremental` and `pg_combinebackup` were introduced in [PostgreSQL 17](./postgresql-17-features); plenty of articles online misplace this in 16.

## Upgrade Guidance

Common reasons to upgrade from PG 13/14/15 to 16: pg_stat_io and last-access timestamps on indexes (observability), logical decoding on standbys and parallel apply (replication topology), presorted aggregates (report-style queries). For the upgrade path and its caveats, see [Version Upgrade](../operations/version-upgrade); projects started after 2023 can simply start on PG 16. For a fuller version-by-version comparison, see [PostgreSQL 17 Highlights](./postgresql-17-features).

## References

- [wiki.postgresql.org/wiki/Foreign_data_wrappers](https://wiki.postgresql.org/wiki/Foreign_data_wrappers)
- [GitHub · pgvector/pgvector](https://github.com/pgvector/pgvector)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [PostgreSQL 17 Highlights](./postgresql-17-features)
- [The pg_stat Observation Stack](../internals/pg-stat-observation)
- [Logical Replication Internals](../internals/logical-replication-internals)
- [Version Upgrade](../operations/version-upgrade)
- [index](index.md)
- [postgresql-17-features](postgresql-17-features.md)
- [knowledge](/knowledge.md)