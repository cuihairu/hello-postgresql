# Transactions and Isolation Levels

PostgreSQL implements all four isolation levels from the SQL standard, but its implementation differs from both the standard's description and MySQL: no level ever produces a dirty read (READ UNCOMMITTED is merely an alias kept for standard compatibility, behaving the same as READ COMMITTED), READ COMMITTED is the default, and REPEATABLE READ eliminates phantoms as well. The underlying difference between levels is "when the snapshot is taken"; see [MVCC and Multi-Versioning](./mvcc-and-multi-version).

## The four levels in PostgreSQL

| Level | Snapshot timing | Dirty read | Non-repeatable read | Phantom | Write conflict |
| --- | --- | --- | --- | --- | --- |
| READ COMMITTED (default) | New snapshot per statement | None | Possible | Possible | Wait for the other side to finish, then re-evaluate against the new version |
| REPEATABLE READ | At the transaction's first statement | None | None | None | Reports 40001; the transaction must roll back and be retried |
| SERIALIZABLE | At the transaction's first statement | None | None | None | SSI aborts one side proactively, reporting 40001 |
| READ UNCOMMITTED | Same as READ COMMITTED | None | Possible | Possible | Same as READ COMMITTED |

## READ COMMITTED: a new snapshot per statement

- Two identical SELECTs issued in sequence within the same transaction may return different results (if another transaction committed in between);
- An UPDATE/DELETE that finds its target row being modified by a concurrent transaction waits first; after the other side commits, the WHERE clause is re-evaluated against the row's **latest version** — if it still matches, the operation proceeds on that version; if it no longer matches, the row is skipped;
- This makes single-statement behavior predictable, but cross-statement consistency is something your application has to guarantee. The classic pitfall is "SELECT to check, then UPDATE" breaking down under concurrency — rewrite it as an atomic conditional `UPDATE ... WHERE <condition>`, or use `INSERT ... ON CONFLICT`; see [Handling INSERT Conflicts](../basics/crud-and-on-conflict) for the syntax.

## REPEATABLE READ: a transaction-level snapshot

The snapshot is established at the transaction's first query statement and held until the transaction ends:

- Repeatedly running an ordinary SELECT yields consistent results; it does not read data committed by others afterwards. There are no phantoms either — visibility is decided by the snapshot, not by locks blocking new rows;
- Write conflicts surface as explicit errors: when a row you want to update was modified and committed by another transaction after the snapshot was taken, you get `could not serialize access` (SQLSTATE 40001) and the whole transaction must roll back and be retried;
- Long reports and consistent exports are a good fit here: the entire result is based on one point in time.

## SERIALIZABLE: SSI and retryable failures

SERIALIZABLE layers Serializable Snapshot Isolation (SSI, since PG 9.1) on top of REPEATABLE READ:

- It tracks read/write dependencies between transactions with predicate locks (SIReadLock), detecting rw anti-dependency cycles that would make serial execution results inconsistent;
- When a dangerous structure is detected, it proactively aborts one of the transactions and reports SERIALIZATION FAILURE (40001);
- Conflict detection is optimistic: predicate locks live in memory, so a low-conflict workload pays almost no extra cost. Under high-conflict load the 40001 retry rate climbs, which is behavior by design.

SERIALIZABLE only makes sense if your application implements a retry loop and **re-runs the entire transaction** (including the reads inside it); you cannot just retry the last statement.

## Setting the isolation level

```sql
-- Affects only the current transaction; it must be placed before the transaction's first query
BEGIN;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SELECT ...;
COMMIT;

-- Equivalent form
BEGIN ISOLATION LEVEL SERIALIZABLE;
...

-- Adjust the session default (use ALTER SYSTEM for a global default that survives restart)
SET default_transaction_isolation = 'repeatable read';
```

```sql
-- Observe the current value
SHOW transaction_isolation;
SELECT name, setting FROM pg_settings
WHERE name IN ('default_transaction_isolation', 'transaction_isolation');
```

## Route differences from MySQL

MySQL InnoDB defaults to REPEATABLE READ; consistent reads are based on the undo version chain plus a ReadView, and it uses gap locks (next-key locks) to lock a range in current-read scenarios and prevent phantom inserts. PostgreSQL's REPEATABLE READ/SERIALIZABLE place no range locks on ordinary reads, eliminates phantoms through snapshots, and relies on optimistic SSI detection for serialization. When migrating a system, do not assume the lock behavior is the same on both sides — especially for code that relies on MySQL gap locks to get "prevent-insert" semantics.

## Application-layer retry patterns

Both 40001 (serialization_failure) and 40P01 (deadlock_detected) should be retried:

```plaintext
for attempt in 1..MAX_RETRIES:
    try:
        BEGIN (REPEATABLE READ or SERIALIZABLE)
        run all reads and writes inside the transaction
        COMMIT
        return success
    except SQLSTATE in (40001, 40P01):
        ROLLBACK
        sleep(random exponential backoff, e.g. 50ms * 2^attempt * rand())
    except any other error:
        ROLLBACK
        raise
```

Key points:

- Keep transactions as short as possible, and move cross-transaction interactions like "query, then ask the user / call an external API" out of the transaction;
- Add random jitter to the backoff so many clients do not retry in lockstep and create a fresh spike of conflicts;
- Cap the retry count and monitor it. A workload with a persistently high retry rate is telling you that this isolation level, or that piece of logic, does not suit the current load.

## Observability SQL

```sql
-- Predicate locks held by a SERIALIZABLE transaction (they appear aggregated in pg_locks, not one per row)
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT * FROM orders WHERE amount > 1000;
SELECT pid, mode, granted FROM pg_locks WHERE mode = 'SIReadLock';
ROLLBACK;
```

```sql
-- Transaction duration and state in other sessions; combine with the retry rate to gauge conflict pressure
SELECT pid, state, now() - xact_start AS xact_age, query_start, query
FROM pg_stat_activity
WHERE backend_type = 'client backend' AND xact_start IS NOT NULL
ORDER BY xact_start;
```

## Notes and common pitfalls

- Isolation levels do not eliminate deadlocks: any level can deadlock, and the remedy is always a 40P01 retry. See [The Lock System](./lock-system).
- Under REPEATABLE READ/SERIALIZABLE, long transactions combined with heavy concurrent writes noticeably increase 40001s. Before raising the isolation level, make sure the business logic can tolerate retries.
- Under a connection pool (transaction-level reuse), the session effect of `SET default_transaction_isolation` may be inherited by the next tenant reusing the connection; prefer declaring it explicitly with `SET TRANSACTION` inside the transaction.

## References

- [PostgreSQL official documentation · 13.2. Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [PostgreSQL official documentation · Chapter 51. Overview of PostgreSQL Internals](https://www.postgresql.org/docs/current/overview.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [pagination-and-sorting](/advanced-sql/pagination-and-sorting.md)
- [transaction-basics](/basics/transaction-basics.md)
- [comparison-with-mysql](/ecosystem/comparison-with-mysql.md)
- [index](index.md)
- [lock-system](lock-system.md)
- [mvcc-and-multi-version](mvcc-and-multi-version.md)
- [snapshot-and-visibility](snapshot-and-visibility.md)
- [knowledge](/knowledge.md)- [MVCC and Multi-Versioning](./mvcc-and-multi-version) — the underlying mechanism for snapshots and visibility.
- [Snapshots and Visibility](./snapshot-and-visibility) — the complete visibility rules.
- [The Lock System](./lock-system) — explicit locks and deadlock troubleshooting.
- [Transaction Basics](../basics/transaction-basics) — basic BEGIN/COMMIT/SAVEPOINT usage.

Official docs: <https://www.postgresql.org/docs/current/transaction-iso.html>
