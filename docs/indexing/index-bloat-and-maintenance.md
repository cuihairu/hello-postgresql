# Index Bloat and Maintenance

An index is a continuously written ordered structure: UPDATEs leave old-version entries, DELETEs leave dead entries, and page splits leave half-full pages. vacuum can mark dead entries as reusable but does not shrink the file, so on long-running tables the space an index actually occupies is noticeably larger than what the live data needs — this is index bloat. Bloat's direct effect is that the same query has to read more index pages: IOS benefit leaks away and cache efficiency drops. This page covers how to quantify bloat, how to rebuild safely, and how to deal with duplicate and unused indexes.

## Where Bloat Comes From

- **Double writes from UPDATE**: under MVCC, an UPDATE writes a new version into the heap; if HOT optimization does not apply (an indexed column was updated, or the new version landed on a different page), every index has to append a new entry and the old entry waits for vacuum to reclaim it (the mechanism is in [VACUUM and HOT](../internals/vacuum-and-hot)).
- **Deletes and space reuse**: vacuum marks dead entries reusable and registers the space back into the page's free space, but the file size does not change; the space is only reused when a row with a nearby key value is later inserted on that page. When key distribution drifts over time (high values of an auto-increment id keep being inserted, old key ranges only deleted, never re-inserted), those holes are hard to reuse.
- **Page splits**: sequential inserts followed by out-of-order deletes, or random-key inserts, leave leaf pages at low density for a long time.
- Index garbage also appears in bursts after bulk rollbacks and large transactions.

One-line risk gauge: the more frequent the updates/deletes, the more indexes, and the wider they are, the faster the bloat. Append-only tables (INSERT only) barely bloat.

## Observing: pgstattuple and Estimating SQL

The `pgstattuple` extension gives you exact numbers:

```sql
CREATE EXTENSION IF NOT EXISTS pgstattuple;

-- B-tree internals: leaf page density, fragmentation
SELECT * FROM pgstatindex('idx_ios_flag');
```

Key fields:

```plaintext
 leaf_pages         | 90
 avg_leaf_density   | 90.16    -- average leaf page fill rate; a healthy value is around 90
 leaf_fragmentation | 0.00     -- higher means the physical order is more scrambled
```

An `avg_leaf_density` around 50% means half the index pages are holding air. A rough whole-database sweep can use the statistics views: indices whose size is far greater than "row count x per-row index width", or whose size diverges sharply from an approximate rebuild, are rebuild candidates:

```sql
SELECT s.schemaname, s.relname AS table_name, s.indexrelname,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size,
       s.idx_scan,
       n_live_tup, n_dead_tup, last_autovacuum
FROM pg_stat_user_indexes s
JOIN pg_stat_user_tables t USING (relid)
ORDER BY pg_relation_size(s.indexrelid) DESC
LIMIT 20;
```

A precise estimate requires running `pgstatindex` on every index and aggregating `avg_leaf_density`; the cost is scanning the whole index, so do this only in a maintenance window and only for the tables that matter.

## REINDEX and REINDEX CONCURRENTLY

A rebuild rewrites the index from the current data, and the file goes straight back to a compact state:

```sql
-- plain rebuild: takes an exclusive lock on the rebuilt index; while it runs the index is unavailable and related writes block
REINDEX INDEX idx_ios_flag;

-- online rebuild: CONCURRENTLY supported from PG 12, does not block reads or writes
REINDEX INDEX CONCURRENTLY idx_ios_flag;

-- bulk: by table or whole database
REINDEX TABLE CONCURRENTLY orders_p;
REINDEX DATABASE CONCURRENTLY mydb;
```

Key points:

- **PG 12 is the watershed**: `REINDEX CONCURRENTLY` is only available from PG 12 (system catalog rebuilds were not supported before); on older versions you can only do the rename dance — create a new index CONCURRENTLY, rename the old one, drop the old one.
- `REINDEX CONCURRENTLY` cannot run inside a transaction block; it takes roughly twice as long as a plain rebuild (it must build a shadow index, scan the table twice, and wait for transactions to finish).
- **An interruption leaves INVALID indexes**: after the process is killed or an error occurs, half-built indexes with `pg_index.indisvalid = false` may remain; they keep paying write amplification but serve no queries, so they must be cleaned up:

  ```sql
  SELECT indexrelid::regclass
  FROM pg_index
  WHERE NOT indisvalid;

  -- after confirming: try REINDEX CONCURRENTLY once more, and drop it if that fails
  DROP INDEX CONCURRENTLY half_built_index_name;
  ```

- When to rebuild: `avg_leaf_density` is markedly low and the index serves high-frequency queries; extreme cases vacuum cannot recover; after a major version upgrade or a collation change. A small index used by low-frequency queries is not worth a downtime rebuild over a few MB.

## Finding and Handling Duplicate and Unused Indexes

Every index taxes every write, so redundant indexes are pure overhead. Two filtering steps:

```sql
-- 1) functional overlap: A's key columns are a prefix of B's key columns (or identical), so A is a redundancy candidate
SELECT r.indexrelid::regclass AS redundant_index,
       c.indexrelid::regclass AS covering_index,
       r.indrelid::regclass   AS table_name
FROM pg_index r
JOIN pg_index c
  ON c.indrelid = r.indrelid
 AND c.indexrelid <> r.indexrelid
 AND c.indisunique = false                      -- the covering index carries no unique constraint itself
 AND (c.indkey::text = r.indkey::text           -- key columns are identical
   OR c.indkey::text LIKE r.indkey::text || ' %'); -- r is a key prefix of c

-- 2) zero usage: never scanned since the statistics were reset
SELECT s.schemaname, s.indexrelname,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
       s.idx_scan
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0
  AND NOT i.indisunique
  AND NOT i.indisprimary
ORDER BY pg_relation_size(s.indexrelid) DESC;
```

The first query exploits the leftmost prefix rule: a composite index `(a, b)` can fully take over a single-column index `(a)`'s equality and range lookups, so indexing both columns twice is double taxation. Its output is only a candidate list — it does not compare opclass, expression, or partial-index predicate differences, so every entry must be confirmed by hand before deletion. Follow the process for deletion:

1. **Record the definition**: `SELECT pg_get_indexdef('index_name'::regclass);` and archive it, including all details of INCLUDE, predicate, and opclass.
2. **Observation period**: cover `idx_scan` statistics for at least one complete business cycle (low-frequency queries such as month-end and quarterly reports will under-report). Cross-check the `stats_reset` time against the `pg_stat_statements_reset` timeline or `pg_stat_database.stats_reset`. You can rename the index to `zz_unused_xxx` and observe for a while first — renaming does not affect functionality, and rollback is just renaming it back.
3. **Delete off-peak**: `DROP INDEX CONCURRENTLY index_name;` does not block reads or writes. Primary key and unique constraint indexes cannot be dropped this way (they carry the constraint), nor really should they be dropped at all.
4. **Rollback plan**: keep the definition from step 1 as a one-click rebuild script in the change ticket.

Notes: replicas and the primary run different query sets, so an index unused on the primary may be heavily used on a replica; `idx_scan` resets to zero after an instance restart, a `crash`, or a manual reset, so do not draw conclusions from freshly reset statistics.

## Maintenance Window Strategy

- **Normal case**: always `REINDEX ... CONCURRENTLY`, picked during business low tide and staggered from backups and bulk ETL jobs; rebuild one index at a time and watch I/O and replication lag (see [Streaming Replication and Synchronization](../internals/streaming-replication-and-sync)).
- **Dedicated window**: for small indexes, or tables that can briefly block writes, a plain `REINDEX` is faster and lighter on resources.
- **Cannot stop writes and cannot wait for a window**: the external extension `pg_repack` can organize tables and indexes online (rebuilding into new files and then renaming), suited to severely bloated whole-table cases that CONCURRENTLY cannot solve.
- **Automated inspection**: put "number of INVALID indexes" and "number of indexes with avg_leaf_density below the threshold" into monitoring and alerting (integration is described in [Monitoring and Alerting](../operations/monitoring-and-alerting)); bloat is a chronic condition, so manage it by inspection rather than waiting until queries slow down.

## References

- [PostgreSQL Official Documentation · Chapter 11. Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL Official Documentation · 11.2. Index Types](https://www.postgresql.org/docs/current/indexes-types.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [composite-index-design](composite-index-design.md)
- [gin](gin.md)
- [index-only-scans](index-only-scans.md)
- [index](index.md)
- [autovacuum-tuning](/internals/autvacuum-tuning.md)
- [mvcc-and-multi-version](/internals/mvcc-and-multi-version.md)
- [vacuum-and-hot](/internals/vacuum-and-hot.md)
- [disaster-recovery-drills](/operations/disaster-recovery-drills.md)
- [ops-sop](/operations/ops-sop.md)
- [vacuum-stall-and-performance](/performance/vacuum-stall-and-performance.md)- [Index-Only Scans](./index-only-scans) — how bloat directly erodes IOS benefit.
- [VACUUM and HOT](../internals/vacuum-and-hot) — the creation and reclamation of dead entries.
- [B-tree Structure and Principles](./btree-structure) — the structural background of page splits and leaf page density.
- [autovacuum Tuning](../internals/autovacuum-tuning) — the upstream lever for keeping cleanup ahead of writes.

Official documentation: [REINDEX](https://www.postgresql.org/docs/current/sql-reindex.html), [pgstattuple](https://www.postgresql.org/docs/current/pgstattuple.html), [Index Routine Maintenance](https://www.postgresql.org/docs/current/indexes.html).
