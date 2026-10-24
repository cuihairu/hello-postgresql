# Snapshots and Visibility

Every MVCC query is answering the same question: which version of this row is visible to the current transaction? The answer is decided by two things — the **snapshot** taken at query start, and the xmin/xmax in each tuple header. This page breaks down the snapshot's structure, the four states in the transaction status file pg_xact, the full visibility determination steps, and the risk boundaries of freezing and xid wraparound. For the tuple structure itself, see [MVCC and Multi-Version](./mvcc-and-multi-version).

## What's in a Snapshot: xmin / xmax / xip_list

A snapshot is essentially three numbers:

- **xmin**: the earliest still-running transaction id at the time the snapshot was created. All transactions below xmin were already committed or aborted by the time the snapshot was created.
- **xmax**: the "next transaction id to be assigned" at snapshot creation time. All transactions greater than or equal to xmax have not started yet, and are necessarily invisible.
- **xip_list**: the list of xids still running at snapshot creation, containing only those within the [xmin, xmax) range.

PG 13+ lets you observe this directly:

```sql
-- Session A: open a transaction that won't commit, holding a xid
BEGIN;
SELECT txid_current();          -- e.g.: 105

-- Session B: look at the current snapshot
SELECT pg_current_snapshot();   -- e.g.: 100:105:100,102
COMMIT;
```

How to read `100:105:100,102`: xmin=100, xmax=105; xids 100 and 102 are still running, 101/103/104 are committed, and 105 onward have not committed yet. So the modifications of 101/103/104 are visible to this snapshot, while 100/102/105 (inclusive) and later are not. Older versions used `txid_current_snapshot()`, with the same output format.

## pg_xact (clog) and the Four Transaction States

Visibility determination has to answer "was xmin committed", and the answer lives in the pg_xact directory (called pg_clog before PG 10): each transaction takes only 2 bits, with four states:

| State | Meaning |
| --- | --- |
| IN_PROGRESS | transaction is running |
| COMMITTED | committed |
| ABORTED | aborted |
| SUB_COMMITTED | subtransaction committed, but the top-level transaction has not committed yet |

It is accessed extremely frequently; shared buffers hold a dedicated SLRU cache for it. PG 13+ can observe hit rates on the Xact/Subtrans caches via `pg_stat_slru`. Only after VACUUM freezes old tuples can the pg_xact content for the corresponding range be truncated and reused.

## Visibility Determination Steps

For a given version of a tuple, it simplifies to two steps in order:

1. **Look at xmin (the transaction that created this version)**:
   - xmin is your own transaction's xid → look at the command id (next section); visible only if cmin is less than the current command id.
   - xmin is running (in xip_list, or ≥ snapshot xmax) → invisible.
   - xmin is aborted → invisible.
   - xmin is committed → go to step 2.
2. **Look at xmax (the transaction that deleted/updated this version)**:
   - xmax not set → visible, this is the latest version.
   - xmax is running, or aborted → visible.
   - xmax is committed and "complete" relative to the current snapshot (xmax < snapshot xmax and not in xip_list) → invisible; otherwise visible.

The old version of an `UPDATE` points via xmax at the transaction that updated it, new and old versions are linked by ctid, and the executor walks the chain to the first visible version. This determination is exactly the implementation basis for the read behaviors of each isolation level in [Transactions and Isolation Levels](./transactions-and-isolation).

## Command id (cmin/cmax) and Same-Statement Self-Visibility

Snapshots are transaction/statement scoped; statement-granularity visibility relies on the command id (cmin/cmax) in the tuple header: within the same transaction, **modifications by an earlier statement are visible to a later statement, but a single statement cannot see its own not-yet-complete modifications**:

```sql
BEGIN;
UPDATE t SET v = v + 1 WHERE id = 1 RETURNING v;  -- RETURNING returns the new value directly
INSERT INTO t (id) SELECT id + 1000 FROM t;       -- just-inserted rows won't be scanned again by this statement
COMMIT;
```

A common pitfall: calling a VOLATILE function inside a single statement that writes to a table and then reads it won't read the rows just written by that statement — this is not a bug, it's command id semantics; if you need "write then immediately read", split it into two statements, or chain with a CTE `RETURNING`.

## Freezing (frozen bit) and Early Freezing

- Once a tuple is frozen, its xmin is marked "visible to all snapshots" (since PG 9.4 this is the HEAP_XMIN_FROZEN flag bit on the tuple, no longer rewriting the xid value), so visibility determination no longer needs to consult pg_xact.
- VACUUM freezes tuples whose age exceeds `vacuum_freeze_min_age` (default 50 million); when the database's age approaches `autovacuum_freeze_max_age` (default 200 million), autovacuum triggers an aggressive full-table scan that **freezes early** even tuples that aren't all that old yet, avoiding having to rescan them again and again later. Early freezing writes a bit more WAL, in exchange for not having to process these pages later.
- To observe the frozen status of each page, use the pg_visibility extension:

```sql
CREATE EXTENSION IF NOT EXISTS pg_visibility;
SELECT * FROM pg_visibility_map('t') LIMIT 5;   -- all_visible / all_frozen
```

## xid Wraparound: Risk Boundaries and Alerts

xid is a 32-bit unsigned number, with a total of about 4.2 billion; PostgreSQL requires that the gap between "newest - oldest" stay within about 2 billion, so old transactions must be continuously frozen to make room for the counter. The default three lines of defense:

1. **age reaches 200 million** (`autovacuum_freeze_max_age`): triggers a forced wraparound-preventing vacuum for that database, aggressively freezing and truncating pg_xact.
2. **About 40 million transactions from wraparound**: the logs start emitting `database "x" must be vacuumed within N transactions` warnings at high frequency.
3. **Only millions of transactions from wraparound**: the server refuses to execute most commands, reporting `database is not accepting commands to avoid wraparound data loss`; only manual intervention remains: clean up long-running transactions / orphaned replication slots / prepared transactions, then manually run `VACUUM FREEZE`.

Wire this into monitoring (threshold alerts are recommended well before 200 million):

```sql
SELECT datname, age(datfrozenxid) AS oldest_xid_age
FROM   pg_database
ORDER  BY 2 DESC;
```

Note that forgotten replication slots (the xmin column of `pg_replication_slots`) and two-phase commit leftovers (`pg_prepared_xacts`) hold back freezing progress just like long transactions, and are the most common root cause of wraparound alerts. For alert configuration, see [Monitoring and Alerting](../operations/monitoring-and-alerting).

## Notes and Common Pitfalls

- **REPEATABLE READ's "snapshot too old"**: once `old_snapshot_threshold` is set (off by default), long transactions that time out will get a `snapshot too old` error; if you don't set it, everything is as before, but bloat and wraparound pressure are pushed onto VACUUM — essentially the same family of problems.
- **Freezing isn't free**: aggressive freezing generates a lot of WAL, which can inflate replication lag; handle large tables during business off-peak.
- **Don't use `txid_current()` as a business ID**: it consumes xids and only ever increases, never rewinding; use sequences or `pg_current_xact_id_if_assigned()` for business sequences.
- pg_xact is only 2 bits per transaction, but it keeps growing as transaction id ranges expand; a database that isn't frozen for a long time will have an abnormally large pg_xact even without data bloat.

## References

- [PostgreSQL Official Docs · 24.1. Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- [PostgreSQL Official Docs · Chapter 51. Overview of PostgreSQL Internals](https://www.postgresql.org/docs/current/overview.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [MVCC and Multi-Version](./mvcc-and-multi-version)
- [Transactions and Isolation Levels](./transactions-and-isolation)
- [VACUUM and HOT](./vacuum-and-hot)
- [Monitoring and Alerting](../operations/monitoring-and-alerting)
- [architecture-and-memory](architecture-and-memory.md)
- [index](index.md)
- [lock-conflict-troubleshooting](lock-conflict-troubleshooting.md)
- [mvcc-and-multi-version](mvcc-and-multi-version.md)
- [transactions-and-isolation](transactions-and-isolation.md)
- [knowledge](/knowledge.md)
Official docs reference: [Preventing Transaction ID Wraparound Failures](https://www.postgresql.org/docs/current/routine-vacuuming.html)
