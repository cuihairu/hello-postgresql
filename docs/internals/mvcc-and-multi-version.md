# MVCC and Multi-Versioning

PostgreSQL implements non-blocking reads and writes with multiversion concurrency control (MVCC): UPDATE/DELETE do not overwrite the old data in place, but instead create a new row version and mark the old one as obsolete, and each transaction decides which version is visible based on the snapshot it holds. Reads do not take locks and writes do not block reads; the cost is that the heap accumulates old versions (dead tuples) which must be reclaimed by VACUUM.

## Tuple headers: xmin, xmax, ctid, and infomask

Every row (tuple) in the heap carries version-control fields in its header:

- `xmin`: the transaction ID (XID) that inserted this row version;
- `xmax`: the transaction ID that deleted (or updated-and-replaced) this version; 0 means it has not been marked for deletion yet;
- `cmin` / `cmax`: the command counter within the transaction, used to handle visibility for several statements in sequence within the same transaction;
- `ctid`: the physical location of the row (page number, offset within the page). A new version produced by an update gets a new ctid, so old and new versions form a version chain;
- `infomask`: a set of flag bits that caches the commit/abort status of xmin/xmax (e.g. HEAP_XMIN_COMMITTED), so visibility checks do not have to look up transaction status (clog) every time.

## What INSERT, DELETE, and UPDATE leave in the heap

- **INSERT**: writes a new tuple with xmin = the current transaction ID;
- **DELETE**: does not move the data away, only sets that tuple's xmax to the current transaction ID;
- **UPDATE**: equivalent to "insert a new version + mark the old version's xmax". On the index side, every index appends an index entry for the new version (unless the update goes through a HOT update, see [VACUUM and HOT](./vacuum-and-hot)) — this is also the root cause of index bloat in heavily updated tables.

As long as any transaction might still read an old version, it has to stay in the heap; "when nobody needs it any more" is decided by the snapshot visibility rules and by VACUUM.

## How a snapshot decides visibility

A snapshot records three things:

- `xmin`: the smallest XID among all transactions active at snapshot time; any transaction smaller than it is guaranteed to have finished;
- `xmax`: the next XID to be assigned; anything greater than or equal to it is definitely invisible to this snapshot;
- `xip_list`: the list of transaction IDs still in progress at snapshot time.

The visibility check (simplified): a row is visible if and only if xmin has been committed and is not in xip_list, and xmax is empty, not yet committed, or the transaction for xmax has aborted. The isolation levels differ in "when the snapshot is taken", which is exactly what produces the behavioral differences across levels described in [Transactions and Isolation Levels](./transactions-and-isolation).

## The benefits and costs of non-blocking reads and writes

Benefits:

- An ordinary SELECT takes no row locks, is not held up by a writing transaction, and generates no lock waits;
- Consistent reads hold by nature: a long-running query sees the data as of its snapshot time and is not torn apart by concurrent commits.

Costs:

- Every update produces an old version, so heavily updated tables keep manufacturing dead tuples;
- Dead tuples pile up and bloat tables and indexes: sequential scans and index scans must skip more garbage, and index entries for old and new versions coexist;
- Visibility checks must walk the version chain and look up transaction status, so the longer the chain the greater the overhead.

The reclaim path for all of these costs is VACUUM; see [VACUUM and HOT](./vacuum-and-hot) and [Autovacuum Tuning](./autovacuum-tuning) for the mechanism and tuning.

## Implementation differences from MySQL InnoDB

InnoDB writes old versions to a separate undo log and keeps only the latest version in the clustered index; PostgreSQL keeps both old and new versions in the heap and relies on background VACUUM to reclaim them. The two therefore bloat in different places: InnoDB bloat shows up in the rollback segments / history list, while PostgreSQL bloat shows up directly in the table files and indexes.

## Observability SQL

```sql
-- Observe the version fields on any business table (swap t for your table name)
SELECT ctid, xmin, xmax, *
FROM t
ORDER BY ctid
LIMIT 10;
```

```sql
-- Before/after an update: the old version gets xmax set, the new version gets a new ctid and xmin
BEGIN;
SELECT ctid, xmin, xmax FROM t WHERE id = 1;
UPDATE t SET val = val + 1 WHERE id = 1;
SELECT ctid, xmin, xmax FROM t WHERE id = 1;
ROLLBACK;
```

```sql
-- The snapshot triple xmin:xmax:xip_list in its raw form
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SELECT txid_current_snapshot();   -- output like 198560:198563:198560,198562
ROLLBACK;
```

```sql
-- Dead tuple volume and ratio per table
SELECT relname, n_live_tup, n_dead_tup,
       round(n_dead_tup * 100.0 / nullif(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       last_vacuum, last_autovacuum
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 10;
```

## Notes and common pitfalls

- Do not treat ctid as a stable row identifier: UPDATE, VACUUM FULL, and CLUSTER all change it. Use ctid only for debugging and physical location lookups.
- Long-running transactions are the number-one cause of dead tuple buildup: a single uncommitted transaction held open for hours makes every old version since its start unreclaimable. Check `pg_stat_activity.backend_xmin` alongside [Snapshots and Visibility](./snapshot-and-visibility).
- For high-frequency UPDATE workloads, reduce the load at the source: get updates onto HOT paths as much as possible and keep the number of indexes under control, rather than relying on after-the-fact cleanup.

## References

- [PostgreSQL official documentation · Chapter 13. Concurrency Control](https://www.postgresql.org/docs/current/mvcc.html)
- [PostgreSQL official documentation · Chapter 51. Overview of PostgreSQL Internals](https://www.postgresql.org/docs/current/overview.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [glossary](/appendix/glossary.md)
- [common-beginner-mistakes](/basics/common-beginner-mistakes.md)
- [transaction-basics](/basics/transaction-basics.md)
- [what-is-postgresql](/basics/what-is-postgresql.md)
- [comparison-with-mysql](/ecosystem/comparison-with-mysql.md)
- [index-only-scans](/indexing/index-only-scans.md)
- [index](index.md)
- [lock-system](lock-system.md)
- [snapshot-and-visibility](snapshot-and-visibility.md)
- [toast](toast.md)
- [transactions-and-isolation](transactions-and-isolation.md)
- [vacuum-and-hot](vacuum-and-hot.md)
- [knowledge](/knowledge.md)
- [lock-and-concurrency-bottlenecks](/performance/lock-and-concurrency-bottlenecks.md)- [VACUUM and HOT](./vacuum-and-hot) — reclaiming dead tuples and skipping index updates.
- [Transactions and Isolation Levels](./transactions-and-isolation) — snapshot timing decides each level's behavior.
- [Snapshots and Visibility](./snapshot-and-visibility) — the complete visibility rules.
- [Index Bloat and Maintenance](../indexing/index-bloat-and-maintenance) — the index-side cost of multi-versioning.

Official docs: <https://www.postgresql.org/docs/current/mvcc.html>
