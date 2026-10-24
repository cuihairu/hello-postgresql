# Troubleshooting Lock Conflicts

The surface symptoms of lock waits are usually "a slow statement" or "connections piling up", and the bottleneck is the waiting, not the execution. The troubleshooting approach is a fixed three steps: find the waiter, find the blocker, decide whether to wait or to terminate. `pg_blocking_pids()` in PostgreSQL 9.6+ turns the hardest step into a one-line call; combined with `lock_timeout` as a backstop and deadlock retries, most lock problems converge. Official reference: [pg_locks and Lock Monitoring](https://www.postgresql.org/docs/current/monitoring-locks.html).

## One SQL statement to find who is waiting on whom

```sql
SELECT blocked.pid     AS blocked_pid,
       blocked.usename AS blocked_user,
       left(blocked.query, 60)          AS blocked_query,
       now() - blocked.xact_start       AS blocked_xact_age,
       pg_blocking_pids(blocked.pid)    AS blocked_by,
       left(blocker.query, 60)          AS blocker_query,
       now() - blocker.xact_start       AS blocker_xact_age
FROM   pg_stat_activity blocked
JOIN   pg_stat_activity blocker
       ON blocker.pid = ANY (pg_blocking_pids(blocked.pid))
WHERE  cardinality(pg_blocking_pids(blocked.pid)) > 0
ORDER  BY blocked_xact_age DESC;
```

- `pg_blocking_pids(pid)` returns the array of session pids "directly in front of you"; an empty array means it is not waiting on a lock.
- The result includes **whoever is queued ahead of you**, which is not necessarily the current lock holder; with a long queue you need to follow the array.
- Each call to this function has to scan the lock table, so do not poll all sessions at high frequency inside a monitoring script.

## Joining pg_locks with pg_stat_activity to trace a wait chain

```sql
SELECT l.pid,
       a.wait_event_type || ':' || a.wait_event AS waiting_on,
       l.locktype, l.mode, l.granted,
       l.relation::regclass AS rel,
       l.transactionid
FROM   pg_locks l
JOIN   pg_stat_activity a USING (pid)
WHERE  NOT l.granted
ORDER  BY l.pid;
```

Typical signals: a row lock wait shows `Lock:transactionid` (waiting for some transaction to end), and a table lock wait shows `Lock:relation`. Once you have found the waiter, look the other way for the holder — in `pg_locks` find the pid with the same transactionid / same relation and `granted = true`, then go back to `pg_stat_activity` to see what it is running and how long its transaction has been open.

## Reproduction one: a row lock wait

```sql
-- Session A
BEGIN;
UPDATE accounts SET balance = balance - 10 WHERE id = 1;  -- holds the row lock on that row

-- Session B
UPDATE accounts SET balance = balance + 10 WHERE id = 1;  -- suspends

-- Session C (a monitoring session) runs the join above:
-- B's waiting_on = Lock:transactionid, blocked_by = {A's pid}
```

Once A commits, B continues immediately. Note the READ COMMITTED detail: after B waits, it re-evaluates the WHERE against the **latest row version** — `id = 1` still matches, so it adds 10 on top of the value A changed, with no lost update.

## Reproduction two: a table lock wait and "no queue-jumping"

```sql
-- Session A
BEGIN;
SELECT * FROM orders WHERE id = 1;        -- holds ACCESS SHARE, not committed

-- Session B
ALTER TABLE orders ADD COLUMN note text;  -- ACCESS EXCLUSIVE, waits for A to commit

-- Session C (run while B is still waiting)
SELECT count(*) FROM orders;              -- also has to wait for B!
```

The pitfall is session C: lock requests queue in arrival order, so once an ACCESS EXCLUSIVE enters the queue, an ACCESS SHARE arriving later must wait for it too. That means "just adding a column" can make the entire table unavailable for an instant — a long read-only transaction plus a casual ALTER TABLE is a common recipe for a production incident.

## Using lock_timeout / statement_timeout as a backstop

```sql
SET lock_timeout = '3s';
ALTER TABLE orders ADD COLUMN note text;  -- gives up if the lock is not obtained within 3 seconds
RESET lock_timeout;
```

- `lock_timeout` covers only the "waiting for a lock" part (it reports `canceling statement due to lock timeout`, SQLSTATE 55P03); `statement_timeout` covers the whole statement. Both default to 0, meaning no limit.
- Adding `SET lock_timeout` to every DDL change script is standard operations practice: if you cannot get the lock, exit and retry rather than turning the table into a parking lot. If it cannot be changed, use a retry loop or a maintenance window.
- Defaults can be set per role or per database: `ALTER ROLE ddl_runner SET lock_timeout = '5s';`
- Set `statement_timeout` separately for OLTP roles, so one runaway report cannot pin a connection.

## Deadlocks: detection, reading the error, and retry

When two transactions each hold a lock the other wants, a cycle forms. PostgreSQL does not prevent this; instead it waits for a timeout and then detects: once the wait exceeds `deadlock_timeout` (default 1 second), deadlock detection runs, and if a cycle is found it terminates whichever side is cheaper to abort:

```plaintext
ERROR:  deadlock detected
DETAIL:  Process 12345 waits for ShareLock on transaction 20001;
         blocked by process 12346.
Process 12346 waits for ShareLock on transaction 20000;
         blocked by process 12345.
HINT:  See server log for query details.
```

The N in "waits for ShareLock on transaction N" inside the DETAIL is the transaction id holding the row lock, corresponding to the `pg_locks.transactionid` column. The terminated transaction rolls back, the other side completes normally, and no data is lost.

A classic cross-update reproduction:

```sql
-- Session A                           -- Session B
BEGIN;                               BEGIN;
UPDATE t SET v = v WHERE id = 1;     UPDATE t SET v = v WHERE id = 2;
UPDATE t SET v = v WHERE id = 2;     UPDATE t SET v = v WHERE id = 1;
-- After about 1 second one side receives deadlock detected
```

On the application layer, retry with random backoff, catching SQLSTATE `40P01` (deadlock) and `40001` (serialization failure):

```plaintext
for attempt in 1..max_retries:
    try:      run_transaction(); break
    except e where e.sqlstate in ('40P01', '40001'):
        sleep(random_between(10, 200) * attempt ms)   # random jitter
```

Retrying at a fixed interval makes both transactions start again at the same moment and collide again; randomization is what breaks the pattern. Do not make `deadlock_timeout` too small: when lock conflicts are frequent, running a full cycle detection often is itself expensive.

## idle in transaction: the invisible source of blocking

A long transaction holding no row locks and no table locks is equally dangerous: its transaction snapshot pins an xmin, so VACUUM cannot clean the dead tuples created after it, which gradually bloats tables. It also holds back xid freeze progress (see [Snapshots and Visibility](./snapshot-and-visibility)). The most common sources are an ORM forgetting to commit, or a transaction left open while waiting on a human or the network.

```sql
SELECT pid, usename, state,
       now() - xact_start   AS xact_age,
       now() - state_change AS idle_age,
       backend_xmin,
       left(query, 60)      AS last_query
FROM   pg_stat_activity
WHERE  state IN ('idle in transaction', 'idle in transaction (aborted)')
ORDER  BY xact_start;
```

Backstop parameters:

- `idle_in_transaction_session_timeout` (PG 9.6+): terminates the session when a transaction has been idle too long.
- `transaction_timeout` (PG 17+): times out the entire transaction, including a long transaction that has been working the whole time.
- `backend_xmin` shows the oldest xmin it is pinning; combine it with `pg_stat_user_tables.n_dead_tup` to judge the degree of bloat. For the approach, see [VACUUM and HOT](./vacuum-and-hot) and [Autovacuum Tuning](./autovacuum-tuning).

## Notes and common pitfalls

- **Look at waits before talking about slow queries**: a session with `wait_event_type = 'Lock'` in `pg_stat_activity` does not belong on the slow SQL optimization list — optimizing it does nothing.
- **Lock waits cascade**: an ACCESS EXCLUSIVE queued at the front slows the entire queue, so terminate the ALTER at the head rather than killing each subsequent query one by one.
- **You can check on read-only replicas too**: `pg_stat_activity` and `pg_locks` are available on a standby as well, though row lock waits appear only on the primary.
- **Use `pg_terminate_backend(pid)` to terminate**: `pg_cancel_backend` only cancels the statement currently executing and cannot kill an idle in transaction.

## References

- [PostgreSQL official documentation · Chapter 27. Monitoring Database Activity](https://www.postgresql.org/docs/current/monitoring.html)
- [PostgreSQL official documentation · Chapter 51. Overview of PostgreSQL Internals](https://www.postgresql.org/docs/current/overview.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [The Lock System](./lock-system)
- [VACUUM and HOT](./vacuum-and-hot)
- [Locks and Concurrency Bottlenecks](../performance/lock-and-concurrency-bottlenecks)
- [Connections and ORM Optimization](../performance/connection-and-orm-optimization)
- [common-errors-and-troubleshooting](/appendix/common-errors-and-troubleshooting.md)
- [index](index.md)
- [lock-system](lock-system.md)
- [streaming-replication-and-sync](streaming-replication-and-sync.md)
- [monitoring-and-alerting](/operations/monitoring-and-alerting.md)
- [ops-sop](/operations/ops-sop.md)
- [lock-and-concurrency-bottlenecks](/performance/lock-and-concurrency-bottlenecks.md)
- [pg-stat-statements](/performance/pg-stat-statements.md)
- [troubleshooting-toolbox](/tools/troubleshooting-toolbox.md)
Official reference: [Monitoring Database Activity](https://www.postgresql.org/docs/current/monitoring.html)
