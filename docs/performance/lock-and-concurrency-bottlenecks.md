# Lock and Concurrency Bottlenecks

A concurrency bottleneck is not always "the machine is too slow"—usually it is a batch of sessions queued behind the same row, the same lock, or the same internal data structure. This page starts with the most common case, a hot row under concurrent writes, then records the knock-on damage of long transactions, advisory lock queueing, lock_timeout as a safety net, and finishes with a diagnosis method that starts from wait events.

## Hot Rows: Concentrated UPDATEs on a Counter Row

When a single row is updated at high frequency (flash-sale stock, a global counter, a popular account balance), all UPDATEs serialize on the row lock: even with an idle machine, TPS is capped by "how fast a per-row lock can turn over". The symptom is typical—CPU and IO are both low, yet `UPDATE` latency rises linearly with concurrency.

```sql
-- reproduce: 100 sessions all incrementing the same row
UPDATE page_views SET cnt = cnt + 1 WHERE page_id = 42;
-- in pg_stat_activity, many sessions show:
-- wait_event_type = Lock, wait_event = tuple
```

Solutions, least to most invasive:

```sql
-- 1. Sharding: split one counter row into N rows, update a random row, aggregate on read
CREATE TABLE page_view_shards (
  page_id int NOT NULL,
  shard   int NOT NULL,
  cnt     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (page_id, shard)
);
UPDATE page_view_shards SET cnt = cnt + 1
WHERE page_id = 42 AND shard = floor(random() * 16)::int;
-- read side: SELECT sum(cnt) FROM page_view_shards WHERE page_id = 42;

-- 2. Application-side buffered aggregation: accumulate deltas in-process and flush to the
--    database once per second, trading database row-lock pressure for in-memory merging
```

Sharding trades "space for parallelism"; buffered aggregation trades "a small chance of losing tail data for throughput", which pays off visibly for counters that can tolerate half a second of error (paired with `synchronous_commit = off`, see [Write Throughput Optimization](./write-throughput-optimization)).

## The Knock-on Damage of Long Transactions

A long transaction creates two classes of problem at once:

- **Holding locks**: every row it touched stays locked, and other sessions wait for it; the older its snapshot, the longer the queue behind it. DDL queues up behind it (see lock_timeout below).
- **Holding xmin**: its snapshot makes every dead tuple "newer than it" across the whole database unreclaimable, VACUUM cannot advance, tables and indexes bloat continuously, and in the end the queries slowed down are ones with nothing to do with it.

```sql
-- find long transactions and the snapshots they hold
SELECT pid, state, xact_start, now() - xact_start AS xact_age,
       backend_xid, backend_xmin, query
FROM pg_stat_activity
WHERE state <> 'idle'
ORDER BY xact_start;
```

idle in transaction is the most common form: business code opens a transaction and never commits it, then goes off to make an RPC call. Governance is covered in [MVCC and Multi-Versioning](../internals/mvcc-and-multi-version) and [VACUUM Stalls and Performance](./vacuum-stall-and-performance).

## Observing Advisory Lock Queueing

Advisory locks are requested explicitly by the application and are often used for task mutual exclusion. Sessions that cannot get the lock queue up quietly—the application only sees "slowness", while the database sees the whole picture clearly:

```sql
-- who holds it, who is waiting
SELECT l.pid, l.granted, l.objid,
       a.query, a.wait_event_type, a.wait_event,
       pg_blocking_pids(l.pid) AS blocked_by
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.locktype = 'advisory'
ORDER BY l.granted, l.objid;
```

Rows with `granted = false` are the queue; `pg_blocking_pids()` hands you the head of it directly. A queue that grows too long means the task's concurrency design is broken—either shorten the lock-holding region, or switch to `pg_try_advisory_lock()` with a timeout and take the degraded path when you cannot get it.

## lock_timeout as a Safety Net

Waiting avalanches are often triggered by a single DDL: `ALTER TABLE` requests ACCESS EXCLUSIVE and queues behind every read transaction, while read transactions arriving during the wait then line up ahead of it—reads and writes block each other in a chain. Set a timeout on operations that risk waiting on a lock, turning "queue forever" into "fail fast + retry":

```sql
SET lock_timeout = '3s';
ALTER TABLE orders ADD COLUMN remark text;
RESET lock_timeout;
```

A more practical pattern in migration tooling is to let the program retry after a failure rather than letting one DDL stall the whole site. Distinguish carefully: `deadlock_timeout` (default 1s) is the sensitivity of deadlock detection, not a lock-wait cap—the two are not substitutes for each other.

## Wait Event Classes and Diagnosis

`pg_stat_activity.wait_event_type` groups "what a session is waiting on" into a handful of classes; when locating a bottleneck, group by class first:

```sql
SELECT wait_event_type, wait_event, count(*)
FROM pg_stat_activity
WHERE state <> 'idle' AND wait_event IS NOT NULL
GROUP BY 1, 2
ORDER BY 3 DESC;
```

- **Lock**: heavyweight lock queueing (table locks, row locks `tuple`, transaction locks `transactionid`, advisory). Many sessions means a contention point exists—follow `pg_blocking_pids()` down the chain.
- **LWLock**: lightweight locks on internal data structures (buffer mapping, the WAL insertion point, and so on). Occasional hits are normal; sustained high counts mean shared memory contention, commonly caused by too many connections or a badly low buffer hit ratio.
- **IO**: waiting on disk reads/writes. Check for missing indexes, hit ratios, and whether a checkpoint is flushing.
- **Client**: waiting for the client to send a command or fetch results—usually the application not consuming in time; the database side needs no optimization.
- **IPC / BufferPin / Timeout**: parallel query coordination, VACUUM waiting for old snapshots to exit, and the like—consult the docs for the specific wait_event.

Suggested diagnosis order: first look at the wait event distribution to pin the broad class, then narrow to specific sessions and objects with `pg_blocking_pids()` / `pg_locks`, and finally return to the application layer to read the business code behind that session. The mechanics of the lock system itself are in [The Lock System](../internals/lock-system), and lock conflicts case by case in [Lock Conflict Troubleshooting](../internals/lock-conflict-troubleshooting).

## References

- [PostgreSQL Official Documentation · 27.2. The Cumulative Statistics System](https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-ACTIVITY-VIEW)
- [PostgreSQL Official Documentation · 14.1. Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [transaction-basics](/basics/transaction-basics.md)
- [lock-conflict-troubleshooting](/internals/lock-conflict-troubleshooting.md)
- [lock-system](/internals/lock-system.md)
- [benchmark-tools](benchmark-tools.md)
- [connection-and-orm-optimization](connection-and-orm-optimization.md)
- [index](index.md)
- [schema-migration-tools](/tools/schema-migration-tools.md)- [The Lock System](../internals/lock-system)——the full mechanics of lock types and granularities.
- [Lock Conflict Troubleshooting](../internals/lock-conflict-troubleshooting)——troubleshooting paths for individual cases.
- [The pg_stat Observation System](../internals/pg-stat-observation)——the landscape of wait events and statistics views.
- [A Slow Query Governance Workflow](./slow-query-governance)——folding this page's diagnosis steps into the daily flow.

Official docs: <https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-ACTIVITY-VIEW>
