# Transaction Basics

A transaction is the mechanism by which a database guarantees that a group of operations either "all happen or none happen". PostgreSQL runs every statement in its own transaction by default (autocommit); your hand-written `BEGIN/COMMIT/ROLLBACK` just explicitly bundles several statements into one atomic unit. Correctness comes from MVCC and WAL; here we only cover the basic control statements, rollback semantics, and the common isolation-level read phenomena. For the deeper lock and visibility rules see [MVCC and Multi-Version](../internals/mvcc-and-multi-version).

## BEGIN / COMMIT / ROLLBACK

Transaction boundaries are controlled by these three statements. `BEGIN` opens a transaction, `COMMIT` commits and persists it, and `ROLLBACK` discards every uncommitted change:

```sql
BEGIN;

UPDATE accounts SET balance = balance - 30 WHERE id = 1;
UPDATE accounts SET balance = balance + 30 WHERE id = 2;

-- commit only after checks pass; any failure rolls back the whole thing
COMMIT;
-- ROLLBACK;   -- discard all uncommitted changes
```

In `psql`, if a statement errors after `BEGIN` the transaction enters the "aborted" state, and from then on any statement only returns `ERROR: current transaction is aborted, commands ignored until end of transaction block` until you `ROLLBACK`. This is normal protective behavior, not a bug.

## autocommit: semantic differences between psql and drivers

- **psql interactive mode**: autocommit is on by default, so each statement you send stands as its own transaction. If one statement errors, psql usually carries on (unless `ON_ERROR_ROLLBACK` is set), and the error affects only that one statement.
- **A driver's `autocommit` switch**: Python psycopg3, JDBC, Go `database/sql` and similar default to `autocommit=false`, in which case each statement is **not committed automatically** and changes are not durable until the connection closes or an explicit `commit` happens. The classic trap: you run an `UPDATE`, never commit, and other connections do not see the change.
- **psql's `\set autocommit off`**: lets psql manage transactions manually; with `\set ON_ERROR_ROLLBACK on` a single failing statement is rolled back automatically, which makes interactive debugging easier.

However a client wraps things, **the unit of atomicity on the database side is always an explicit `BEGIN...COMMIT` block**. Autocommit is really "add an implicit BEGIN/COMMIT pair around each statement".

## SAVEPOINT: sub-rollback points inside a transaction

When a long transaction only needs to undo its back half, use `SAVEPOINT` to set a sub-rollback point and avoid restarting the whole thing:

```sql
BEGIN;

INSERT INTO orders(user_id, amount) VALUES (1, 100);   -- step 1
SAVEPOINT after_order;

INSERT INTO order_items(order_id, sku, qty) VALUES (currval('orders_id_seq'), 'SKU-1', 2);

-- if step 3 fails, roll back to the SAVEPOINT and step 1 is preserved
ROLLBACK TO SAVEPOINT after_order;
UPDATE orders SET amount = 0 WHERE id = currval('orders_id_seq');

RELEASE SAVEPOINT after_order;   -- release, optional before commit
COMMIT;
```

Note that `ROLLBACK TO SAVEPOINT` does not end the outer transaction, it only returns to that point; you can keep executing and still `COMMIT`.

## DDL inside a transaction can be rolled back too

This is an important difference between PostgreSQL and MySQL: **MySQL DDL (such as `ALTER TABLE`) implicitly commits the current transaction** and cannot be rolled back; PostgreSQL DDL is transactional and can be committed or rolled back together with DML.

```sql
BEGIN;

CREATE TABLE audit_log (id bigint PRIMARY KEY, op text);
INSERT INTO audit_log VALUES (1, 'test');
ALTER TABLE audit_log ADD COLUMN created_at timestamptz DEFAULT now();

ROLLBACK;   -- the create + insert + add column above are all undone
```

This makes PostgreSQL's online DDL (such as adding a column to a large table) far safer: `ALTER TABLE ... ADD COLUMN` is a lightweight operation, can go into a transaction and commit together with business DML, and rolls back in one batch on failure. The cost is that DDL holds locks (see [The Lock System](../internals/lock-system)), so DDL inside a long transaction makes later DDL queue up and wait.

## An overview of read phenomena: dirty read / non-repeatable read / phantom read

Under different isolation levels the same query may see different results. PostgreSQL defaults to `READ COMMITTED`; the three read phenomena and their minimum isolation levels:

| Read phenomenon | Meaning | Minimum isolation level |
| --- | --- | --- |
| Dirty read | reading **uncommitted** changes from another transaction | `READ COMMITTED` |
| Non-repeatable read | two reads of the same row within one transaction give different results | `REPEATABLE READ` |
| Phantom read | two range queries within one transaction return different row counts | `SERIALIZABLE` |

You can reproduce a non-repeatable read under `READ COMMITTED` by simply opening two psql connections as session A and session B:

```sql
-- session A
BEGIN;
UPDATE users SET balance = 999 WHERE id = 1;   -- not committed

-- session B (separate connection; under autocommit it reads the old value 100)
SELECT balance FROM users WHERE id = 1;        -- 100

-- session A commits
COMMIT;

-- session B reads again and sees the new value 999 — non-repeatable read
SELECT balance FROM users WHERE id = 1;        -- 999
```

PostgreSQL's `REPEATABLE READ` is implemented on MVCC snapshots without locks, and it also avoids phantom reads; `SERIALIZABLE` is where predicate locks and serialization-conflict detection enter. For the full semantics of the four isolation levels and how to use `SET TRANSACTION ISOLATION LEVEL` see [Transactions and Isolation Levels](../internals/transactions-and-isolation).

## The hazards of long transactions and dblink

- **Long transactions**: a transaction that never commits keeps old tuple versions from being reclaimed by VACUUM, causing table bloat, which in turn slows down `UPDATE/DELETE` and index scans. In production, avoid "opening a business transaction and then waiting on a person, the network, or manual confirmation".
- **Nested transactions in `dblink` / `postgres_fdw`**: cross-database operations do not commit atomically with the local transaction; you need two-phase commit or compensating logic to avoid "one side succeeds while the other hangs".
- To hunt down long transactions, query `pg_stat_activity` directly and look at sessions with `state = 'idle in transaction'` and their `xact_start`:

```sql
SELECT pid, state, now() - xact_start AS age, query
FROM   pg_stat_activity
WHERE  state = 'idle in transaction'
ORDER  BY age DESC;
```

## Gotchas and common pitfalls

- **"Pseudo-transactions" under autocommit**: type two `UPDATE`s in a row, and when the second one fails the first is already committed and cannot be undone by a later `ROLLBACK` — you need an explicit `BEGIN`.
- **`BEGIN` is not "clear the state"**: once inside a transaction, any failing statement puts it into the aborted state and you must `ROLLBACK` before continuing.
- **Wrap DDL in transactions too**: apart from `CREATE INDEX CONCURRENTLY` (which does not lock the table but cannot run inside a transaction block), DDL should generally go into a transaction to avoid leaving half-built objects.
- **Do not do slow work inside a transaction**: long transactions combined with DDL amplify lock contention; this commonly happens when "adding an index / adding a column / changing a type" is mixed into a business transaction, see [Locks and Concurrency Bottlenecks](../performance/lock-and-concurrency-bottlenecks).

## References

- [PostgreSQL official documentation · Part I. Tutorial](https://www.postgresql.org/docs/current/tutorial.html)
- [PostgreSQL official documentation · The SQL Language](https://www.postgresql.org/docs/current/sql.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [MVCC and Multi-Version](../internals/mvcc-and-multi-version)
- [Transactions and Isolation Levels](../internals/transactions-and-isolation)
- [The Lock System](../internals/lock-system)
- [Common psql operations](./psql-getting-started)
- [sql-command-reference](/appendix/sql-command-reference.md)
- [crud-and-on-conflict](crud-and-on-conflict.md)
- [index](index.md)
- [transactions-and-isolation](/internals/transactions-and-isolation.md)
