# VACUUM and HOT

MVCC leaves old versions behind on UPDATE/DELETE instead of overwriting them in place (see [MVCC and Multi-Versioning](./mvcc-and-multi-version)); once no transaction needs an old version any more it becomes a dead tuple. VACUUM reclaims the space those dead tuples occupy. HOT (Heap-Only Tuple) updates reduce the load at the source: an update that meets the conditions never touches the indexes at all, sharply cutting write amplification and index bloat.

## Where dead tuples come from

- Every UPDATE turns the old version into a dead tuple — an UPDATE in PostgreSQL is fundamentally "insert a new version + mark the old version";
- Rows marked by DELETE become dead tuples once the deleting transaction commits and no transaction needs to see them any more;
- Versions written by rolled-back transactions are equally invisible and are also cleanup targets;
- As long as some snapshot could still read a given version (a long transaction, an unreleased replication slot, a standby with hot_standby_feedback), it cannot be cleaned up.

## What VACUUM does

One round of an ordinary VACUUM (lazy vacuum) does the following:

1. Scans the heap pages and removes dead tuples that are no longer visible: line pointers are marked free and the space within a page is tidied for reuse;
2. Updates the FSM (Free Space Map) so later INSERTs/UPDATEs can find free space within a page;
3. Updates the VM (Visibility Map) by flagging all-visible pages — this is what lets an index-only scan skip heap access, and it is also the basis for the next VACUUM round to skip clean pages;
4. Freezes tuples old enough to warrant it (replacing xmin with a special freeze marker), advancing transaction ID wraparound defense;
5. If many consecutive pages at the end of the table are entirely empty, truncates the file and returns the space to the operating system.

Key point: **an ordinary VACUUM leaves reclaimed space inside the table for reuse; the table file does not shrink** (trailing truncation aside). Running VACUUM after a file has already bloated shrinks the "dead tuple count", not the disk usage.

## HOT updates: updates that never touch the indexes

An UPDATE goes through the HOT path when two conditions hold at the same time:

- it does not modify any column referenced by an index (including the columns used by an expression index's expression or a partial index's WHERE clause);
- the new version fits on the same page as the old version (there is enough free space within the page).

The payoff from HOT:

- Not a single index is touched: no index entry is inserted for the new version, so indexes do not bloat because of it and the cost of the update drops sharply;
- Old and new versions form a HOT chain within the page, and following the old version's ctid leads you to the new one;
- HOT dead tuples accumulated within a page can be reclaimed early by lightweight page pruning, without waiting for VACUUM.

The second condition is what makes fillfactor matter: a table with the default `fillfactor = 100` packs its pages full, after which updates can only place new versions on a different page and miss HOT. Lowering fillfactor to 70–90 on frequently updated tables leaves room within the page for HOT and usually raises the HOT ratio noticeably.

```sql
-- Only takes effect for pages written from now on; existing full pages need a rewrite (VACUUM FULL/CLUSTER) to be rearranged at the new value
ALTER TABLE orders SET (fillfactor = 80);
```

## Observing dead tuples and the HOT ratio

```sql
SELECT relname, n_tup_upd, n_tup_hot_upd,
       round(100.0 * n_tup_hot_upd / nullif(n_tup_upd, 0), 1) AS hot_pct,
       n_dead_tup, last_vacuum, last_autovacuum
FROM pg_stat_user_tables
ORDER BY n_tup_upd DESC
LIMIT 10;
```

For update-heavy tables with a persistently low `hot_pct`: first confirm whether the update really avoids every indexed column, then consider lowering fillfactor. The statistics are cumulative, so observe a complete business cycle after `pg_stat_reset()` for more accurate numbers.

```sql
-- Progress of a VACUUM in flight (phase and pages scanned/cleaned)
SELECT v.pid, p.query, v.phase,
       v.heap_blks_total, v.heap_blks_scanned, v.heap_blks_vacuumed
FROM pg_stat_progress_vacuum v
JOIN pg_stat_activity p ON p.pid = v.pid;
```

Trigger it manually and look at the detailed output (compare it with the two statistics columns above):

```sql
VACUUM (VERBOSE, ANALYZE) orders;
```

## Dealing with bloat: the cost of VACUUM FULL

Once a table file has grown far beyond its live data, an ordinary VACUUM is powerless. The options are:

- `VACUUM (FULL)`: rewrites the whole table and all its indexes, returning space to the operating system. Cost: holds an ACCESS EXCLUSIVE lock throughout (blocking all reads and writes), needs temporary disk roughly the size of the table, and takes a long time on large tables;
- `CLUSTER`: rewrites the whole table in index order, similar effect plus physical clustering, with the same lock and disk costs;
- Online rewriting tools (pg_repack and the like) do not block reads or writes, at the cost of extra disk and trigger overhead.

The core of bloat management is prevention: control the rate of dead tuple production (favor HOT, cut pointless updates) and make sure autovacuum keeps up. See [Autovacuum Tuning](./autovacuum-tuning).

## Notes and common pitfalls

- `n_dead_tup` is a statistical estimate; to judge bloat, compare it against the table file size and live data volume. For exact measurements use the pgstattuple extension. See [Index Bloat and Maintenance](../indexing/index-bloat-and-maintenance).
- HOT does nothing for updates that change an indexed column. On wide tables, the more indexes there are, the lower the HOT ratio — weigh the write cost before creating an index. See [Composite Index Design](../indexing/composite-index-design).
- Long transactions are the biggest enemy of dead tuple cleanup: VACUUM can only clean tuples no snapshot can see, and one forgotten COMMIT can bloat the entire database.

## References

- [PostgreSQL official documentation · 24.1. Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- [PostgreSQL official documentation · 66.7. Heap-Only Tuples (HOT)](https://www.postgresql.org/docs/current/storage-hot.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [glossary](/appendix/glossary.md)
- [crud-and-on-conflict](/basics/crud-and-on-conflict.md)
- [soft-delete-and-tombstone](/database-design/soft-delete-and-tombstone.md)
- [comparison-with-mysql](/ecosystem/comparison-with-mysql.md)
- [postgresql-17-features](/ecosystem/postgresql-17-features.md)
- [timescaledb](/ecosystem/timescaledb.md)
- [index-bloat-and-maintenance](/indexing/index-bloat-and-maintenance.md)
- [index-only-scans](/indexing/index-only-scans.md)
- [autovacuum-tuning](autovacuum-tuning.md)
- [index](index.md)
- [lock-conflict-troubleshooting](lock-conflict-troubleshooting.md)
- [mvcc-and-multi-version](mvcc-and-multi-version.md)
- [snapshot-and-visibility](snapshot-and-visibility.md)
- [toast](toast.md)
- [knowledge](/knowledge.md)
- [monitoring-and-alerting](/operations/monitoring-and-alerting.md)
- [connection-and-orm-optimization](/performance/connection-and-orm-optimization.md)
- [explain-basics](/performance/explain-basics.md)
- [statistics-and-analyze](/performance/statistics-and-analyze.md)
- [vacuum-stall-and-performance](/performance/vacuum-stall-and-performance.md)
- [pgadmin-4](/tools/pgadmin-4.md)
- [real-world-cases](/tools/real-world-cases.md)- [Autovacuum Tuning](./autovacuum-tuning) — keeping automatic cleanup ahead of the update rate.
- [MVCC and Multi-Versioning](./mvcc-and-multi-version) — the origin of dead tuples.
- [Index Bloat and Maintenance](../indexing/index-bloat-and-maintenance) — REINDEX and bloat measurement.
- [VACUUM Stalls and Performance](../performance/vacuum-stall-and-performance) — scenarios where vacuum hurts the business, and how to counter them.

Official docs: <https://www.postgresql.org/docs/current/routine-vacuuming.html> and <https://www.postgresql.org/docs/current/storage-hot.html>
