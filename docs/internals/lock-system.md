# The Lock System

PostgreSQL locks are organized by object level into table locks, row locks, and advisory locks, plus lightweight locks that protect shared memory structures and do not take part in deadlock detection. Application developers deal with the first two the most: table locks decide whether DDL and DML can run in parallel, and row locks decide who goes first when two transactions modify the same row. Here we record the full set of table lock modes and the conflict matrix, plus usage of row locks and advisory locks. To troubleshoot lock waits in progress, see [Troubleshooting Lock Conflicts](./lock-conflict-troubleshooting). Official reference: [Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html).

## Table locks: eight modes and the conflict matrix

Every statement takes a table lock before it touches a table, and the plainest `SELECT` is no exception. The eight modes, weakest to strongest:

| Mode | Typical statement |
| --- | --- |
| ACCESS SHARE | `SELECT` (any read-only query) |
| ROW SHARE | `SELECT ... FOR UPDATE / FOR SHARE` |
| ROW EXCLUSIVE | `INSERT / UPDATE / DELETE / MERGE` |
| SHARE UPDATE EXCLUSIVE | `VACUUM` (not FULL), `ANALYZE`, `CREATE INDEX CONCURRENTLY` |
| SHARE | `CREATE INDEX` (non-concurrent) |
| SHARE ROW EXCLUSIVE | `CREATE TRIGGER`, `ALTER TABLE ... ADD FOREIGN KEY`, and the like |
| EXCLUSIVE | `REFRESH MATERIALIZED VIEW` (non-concurrent) |
| ACCESS EXCLUSIVE | `ALTER TABLE`, `DROP TABLE`, `TRUNCATE`, `VACUUM FULL`, `REINDEX` |

The conflict matrix (✕ means conflict; the later arrival must wait):

| Held ＼ Requested | ACCESS SHARE | ROW SHARE | ROW EXCL. | SHARE UPDATE EXCL. | SHARE | SHARE ROW EXCL. | EXCLUSIVE | ACCESS EXCL. |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ACCESS SHARE | | | | | | | | ✕ |
| ROW SHARE | | | | | | | ✕ | ✕ |
| ROW EXCLUSIVE | | | | | ✕ | ✕ | ✕ | ✕ |
| SHARE UPDATE EXCLUSIVE | | | | ✕ | ✕ | ✕ | ✕ | ✕ |
| SHARE | | | ✕ | ✕ | | ✕ | ✕ | ✕ |
| SHARE ROW EXCLUSIVE | | | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| EXCLUSIVE | | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| ACCESS EXCLUSIVE | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |

Three things to read out of it:

- **DML statements do not conflict with each other**: multiple `INSERT`/`UPDATE`/`DELETE`s (ROW EXCLUSIVE) can run concurrently; correctness at the row level is guaranteed by row locks and MVCC.
- **Reads and writes do not conflict**: ROW EXCLUSIVE is compatible with ACCESS SHARE, so writes do not block ordinary reads. That is MVCC's doing, not the locks being lenient.
- **Writes and "heavy" operations are mutually exclusive**: ROW EXCLUSIVE conflicts with SHARE (creating an index), SHARE ROW EXCLUSIVE, EXCLUSIVE, and ACCESS EXCLUSIVE.

## ROW EXCLUSIVE versus DDL

- `ALTER TABLE ...` takes **ACCESS EXCLUSIVE**, conflicting with every mode: not even an ordinary `SELECT` (ACCESS SHARE) can get in. The cost of changing a table's structure is not in how fast the change runs, it is in the lock queue.
- `CREATE INDEX` takes **SHARE**: it does not block reads, but it is exclusive with all writes. Online indexing on a large table must use `CREATE INDEX CONCURRENTLY` (it takes only SHARE UPDATE EXCLUSIVE and can run in parallel with DML, at the cost of being slower and leaving an invalid index behind if it fails).
- `TRUNCATE`, `VACUUM FULL`, and `DROP TABLE` are all ACCESS EXCLUSIVE.
- `ALTER TABLE ... ADD FOREIGN KEY` takes SHARE ROW EXCLUSIVE on the **referenced** table and blocks writes to that table.

Reproducing with two sessions: an uncommitted write blocks index creation.

```sql
-- Session A
BEGIN;
INSERT INTO orders VALUES (1, 'x');            -- holds ROW EXCLUSIVE, not committed

-- Session B (open a separate psql)
CREATE INDEX idx_orders_note ON orders(note);  -- stalls until A commits or rolls back
```

The reverse direction is more dangerous: once session B's ACCESS EXCLUSIVE enters the wait queue, every ordinary query behind it in the queue is blocked too (locks are requested in arrival order, no jumping the queue), and the whole table turns into a "parking lot" in an instant. For a backstop, see [Troubleshooting Lock Conflicts](./lock-conflict-troubleshooting).

## Row locks

Row locks exist only inside a transaction and are released automatically on commit or rollback. They do not go into the main lock table: the lock information is recorded in the tuple header (reusing the xmax field), and a wait is enqueued on a transaction ID lock (locktype = transactionid) only when a waiter actually appears.

DML takes row locks implicitly: `UPDATE`/`DELETE` hold a row lock until the transaction ends. When the change touches only ordinary columns it takes FOR NO KEY UPDATE (which does not block FOR KEY SHARE, i.e. other sessions can still perform foreign key reference checks); when the change involves a primary key or unique key column it escalates to FOR UPDATE. The four explicit strengths and their conflicts:

| Requested row lock | Conflicts with a held lock of |
| --- | --- |
| FOR KEY SHARE | FOR UPDATE |
| FOR SHARE | FOR NO KEY UPDATE, FOR UPDATE |
| FOR NO KEY UPDATE | FOR SHARE, FOR NO KEY UPDATE, FOR UPDATE |
| FOR UPDATE | All four |

`SELECT ... FOR UPDATE / FOR SHARE` takes the table's ROW SHARE table lock as well as the row locks. The two most useful modifiers:

- **NOWAIT**: fails immediately with `ERROR: could not obtain lock on row` if the lock cannot be obtained. Suited to foreground operations that cannot tolerate a queue.
- **SKIP LOCKED**: skips rows already locked by another session — the classic pattern for a job queue table:

```sql
-- Session A
BEGIN;
SELECT id FROM jobs WHERE status = 'pending'
ORDER BY id LIMIT 1
FOR UPDATE SKIP LOCKED;          -- gets id = 1
UPDATE jobs SET status = 'running' WHERE id = 1;
COMMIT;

-- Session B runs the same query immediately: id=1 is already locked, SKIP LOCKED moves straight past it and gets id=2
```

## Advisory locks

Advisory locks are cooperative locks for the application to use as a "named mutex"; the database does not use them itself. There are two families: **session level** (unrelated to transactions — released only by an explicit unlock or by disconnecting) and **transaction level** (released automatically on COMMIT/ROLLBACK).

| Function | Scope | Notes |
| --- | --- | --- |
| `pg_advisory_lock(key)` | Session level | Blocks until acquired |
| `pg_try_advisory_lock(key)` | Session level | Returns bool immediately; does not wait if it cannot be acquired |
| `pg_advisory_unlock(key)` / `pg_advisory_unlock_all()` | Session level | Release manually |
| `pg_advisory_xact_lock(key)` | Transaction level | Released automatically when the transaction ends; no corresponding unlock |
| `pg_try_advisory_xact_lock(key)` | Transaction level | Returns bool immediately |

A typical use for preventing overlapping scheduled jobs:

```sql
SELECT pg_try_advisory_lock(hashtext('nightly-report')) AS got;
-- Proceed only when got = true; once done:
SELECT pg_advisory_unlock(hashtext('nightly-report'));
```

Notes:

- Session-level locks are **unaffected by transaction rollback**. Forgetting to unlock leaks it until the connection closes — especially dangerous when a connection pool reuses sessions long term. When in doubt, use the transaction-level variant.
- Blocking acquisition queues first-come-first-served, fairly.
- A key is a bigint or two ints. When you compress a string to an int with `hashtext()`, bear in mind that hash collisions can cause two different jobs to lock each other out.
- Observing them: `SELECT * FROM pg_locks WHERE locktype = 'advisory';`

## Locks in memory: the fast path and lightweight locks

In one line: the small number of ordinary locks each backend holds (up to 16) can be kept directly in a private fast path array instead of the shared lock table, and the vast majority of `SELECT` ACCESS SHARE locks take this shortcut. What protects shared memory data structures such as the buffer pool is the LWLock (lightweight lock); it does not take part in deadlock detection and does not show up among the ordinary locks in `pg_locks`. For the overall picture of processes and memory structures, see [Architecture and Memory](./architecture-and-memory).

## Observability and common pitfalls

To see every lock currently held on a given table:

```sql
SELECT l.pid, a.usename, l.locktype, l.mode, l.granted, l.waitstart,
       left(a.query, 60) AS query
FROM   pg_locks l
JOIN   pg_stat_activity a USING (pid)
WHERE  l.relation = 'orders'::regclass
ORDER  BY l.granted, l.pid;
```

- **A row lock inside a long transaction is a time bomb**: row locks persist until the transaction ends, so "open a transaction and go wait on a human" suspends every subsequent update.
- **Row lock re-evaluation under READ COMMITTED**: once the other side commits, the statement re-checks the WHERE condition against the latest row version and skips the row if it no longer matches.
- **Foreign key checks take FOR KEY SHARE on the parent row**: high-concurrency inserts into a child table lock the referenced parent rows, conflicting with an UPDATE that "changes the parent's primary key" (it is compatible with an ordinary parent UPDATE).
- **Do not abuse strong locks with `LOCK TABLE`**: an explicit `LOCK TABLE orders IN ACCESS EXCLUSIVE MODE` queues every query behind it and belongs only in a maintenance window.

## References

- [PostgreSQL official documentation · 13.3. Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [PostgreSQL official documentation · Chapter 51. Overview of PostgreSQL Internals](https://www.postgresql.org/docs/current/overview.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Troubleshooting Lock Conflicts](./lock-conflict-troubleshooting)
- [Transactions and Isolation Levels](./transactions-and-isolation)
- [MVCC and Multi-Versioning](./mvcc-and-multi-version)
- [Locks and Concurrency Bottlenecks](../performance/lock-and-concurrency-bottlenecks)
- [glossary](/appendix/glossary.md)
- [data-types-overview](/basics/data-types-overview.md)
- [transaction-basics](/basics/transaction-basics.md)
- [index](index.md)
- [lock-conflict-troubleshooting](lock-conflict-troubleshooting.md)
- [transactions-and-isolation](transactions-and-isolation.md)
- [ops-sop](/operations/ops-sop.md)
- [lock-and-concurrency-bottlenecks](/performance/lock-and-concurrency-bottlenecks.md)
- [schema-migration-tools](/tools/schema-migration-tools.md)
Official reference: [Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)
