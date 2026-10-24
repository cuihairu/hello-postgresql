# Troubleshooting Toolbox

When a production database slows down, capture the scene first, then hunt for the root cause. Three tools: **pg_stat_activity to capture the scene** (who is running right now), **auto_explain to log plans automatically** (why a slow statement is slow), and **log_min_duration_statement plus log_lock_waits to leave evidence** (for post-mortem review). The first two are about "this moment"; the latter two are about "the past."

## One: pg_stat_activity — capturing the scene

One row per backend process. The most commonly used columns are `pid`, `usename`, `application_name`, `state` (active / idle / idle in transaction), `wait_event_type` and `wait_event`, `xact_start`, `query_start`, and `query`. `application_name` is worth setting in your application's connection string — see [client drivers](./client-drivers).

### Who is running: ordered by duration

```sql
SELECT pid, usename, application_name, client_addr, state,
       wait_event_type, wait_event,
       now() - query_start AS stmt_age,
       left(query, 100) AS query
FROM pg_stat_activity
WHERE backend_type = 'client backend'
ORDER BY stmt_age DESC NULLS LAST;
```

Rows with `state = active` and a large `stmt_age` are the priority targets. When `wait_event` is non-empty, look at it first: type `Lock` means it's stuck on a lock, `Client` means it's waiting for the client to fetch data, and `IO` means it's stuck on disk.

### Who is waiting on a lock

`pg_blocking_pids()` gives you the list of blockers directly, which is faster than matching against `pg_locks` by hand:

```sql
SELECT a.pid AS blocked_pid,
       b.pid AS blocking_pid,
       now() - a.query_start AS waiting_ms,
       left(a.query, 80) AS blocked_query,
       left(b.query, 80) AS blocking_query
FROM pg_stat_activity a
JOIN LATERAL unnest(pg_blocking_pids(a.pid)) AS t(pid) ON true
JOIN pg_stat_activity b ON b.pid = t.pid
WHERE cardinality(pg_blocking_pids(a.pid)) > 0;
```

The blocker is often `idle in transaction` — a transaction opened but never committed, holding row locks it won't release. For complete lock contention troubleshooting, see [lock conflict troubleshooting](../internals/lock-conflict-troubleshooting).

### Long transactions and remediation actions

```sql
SELECT pid, usename, application_name, state,
       now() - xact_start AS xact_age,
       left(query, 80) AS last_query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY xact_age DESC;
```

Remediation from light to heavy: `pg_cancel_backend(pid)` only cancels the current statement, while `pg_terminate_backend(pid)` drops the connection outright (the uncommitted transaction is rolled back). Before interrupting, confirm the session's origin and the business impact — killing an active business connection by mistake is worse than leaving it alone.

## Two: auto_explain — automatically logging slow plans

A manual `EXPLAIN` only works for statements you already know about, and slow queries are usually "unexpected." `auto_explain` writes the plan of any statement that exceeds a threshold into the log when the statement finishes:

```bash
# 1) Load the module first (after modifying shared_preload_libraries you must restart, not just reload)
ALTER SYSTEM SET shared_preload_libraries = 'auto_explain';
SELECT pg_reload_conf();   -- this does not take effect here; the instance must be restarted

# 2) Configure thresholds and output content (these two can be applied with a reload)
ALTER SYSTEM SET auto_explain.log_min_duration = '500ms';
ALTER SYSTEM SET auto_explain.log_analyze = on;
ALTER SYSTEM SET auto_explain.log_parameter_max_length = 64;
SELECT pg_reload_conf();
```

Parameter semantics:

- `log_min_duration`: only statements exceeding this many milliseconds are logged. `-1` disables it (the default, so you must enable it explicitly even after installing the module);
- `log_analyze = on`: the plan carries `actual time`/`rows`, which is what lets you judge whether the estimates drifted;
- `log_parameter_max_length`: the maximum length for logging parameter values. `-1` records the full value;
- `sample_rate` (default 1.0): only log a specified proportion of statements. High-frequency statements like full table scans can be set to `0.01` to cut noise;
- `log_buffers = on`: adds buffer hit-rate information, best read together with [EXPLAIN's BUFFERS option](../performance/explain-analyze-buffers).

A real output and how to read it:

```plaintext
2026-10-12 07:04:19.594 UTC [147] LOG:  duration: 400.193 ms  plan:
	Query Text: SELECT pg_sleep(0.4) IS NULL AS slept;
	Result  (cost=0.00..0.01 rows=1 width=1) (actual time=400.178..400.179 rows=1 loops=1)
```

- `duration: 400.193 ms` is the total time for the statement. It's only logged because it exceeded `log_min_duration`;
- `Query Text:` is the original statement (parameter values are governed by `log_parameter_max_length`);
- Because `log_analyze` is on, plan lines carry `(actual time=... rows=...)`. If `cost` and `actual time` differ by orders of magnitude, the statistics are stale or the estimate is off — that's your signal to run `ANALYZE` next;
- `loops=1` means the node executed once. A child node whose `loops` is far larger than its parent's is the classic signature of nested-loop amplification.

One limitation: auto_explain only records **after a statement finishes**, so a running query has no plan to look at. A mechanism for "periodically emitting an intermediate plan while a long query runs" has been discussed in the community for years but had not landed in a release as of PG 17. For a running query you can only judge from `pg_stat_activity`'s `state` and `wait_event`; to reproduce the plan you have to wait for it to finish or `EXPLAIN` it manually.

## Three: log_min_duration_statement and log_lock_waits

`log_min_duration_statement` is the core slow-statement switch. It logs only the original statement and its duration, with no plan:

```bash
ALTER SYSTEM SET log_min_duration_statement = '500ms';   -- -1 disables, 0 logs everything
ALTER SYSTEM SET log_parameter_max_length = 128;         -- controls the length of logged parameter values
SELECT pg_reload_conf();
```

`log_lock_waits` logs sessions that wait past a threshold without acquiring the lock. It's key to locating the lock chain:

```bash
ALTER SYSTEM SET log_lock_waits = on;
ALTER SYSTEM SET deadlock_timeout = '1s';   -- how long to wait before emitting the log (also the deadlock detection threshold)
SELECT pg_reload_conf();
```

A real output (reproducing an uncommitted transaction blocking a later update):

```plaintext
2026-10-12 07:05:59.889 UTC [201] LOG:  process 201 still waiting for ShareLock on transaction 771 after 200.119 ms
2026-10-12 07:06:01.859 UTC [201] LOG:  process 201 acquired ShareLock on transaction 771 after 2170.628 ms
```

`still waiting for ShareLock on transaction 771` tells you it's waiting on **some uncommitted transaction**, not a lock on a particular table. `deadlock_timeout` is the threshold for "how long to wait before emitting this line" (set to 200ms here for easier observation) and also the trigger period for deadlock detection. The second line, `acquired ... after 2170.628 ms`, means the lock was eventually obtained, with a total wait of 2.17 seconds — when these logs appear in volume, go to pg_stat_activity and search by `xact_start` for that transaction that never commits.

## Using them together

First use `pg_stat_activity` to establish who is running and what `wait_event` they're stuck on. For `Lock` types, dig into `log_lock_waits` to find the blocker. For `CPU`/`IO` types, dig into the `auto_explain` logs to read the plan and judge whether it's a missing index or stale statistics causing a bad estimate. Chaining these three lines is what closes the slow-query governance loop — see [slow query governance](../performance/slow-query-governance).

## References

- [PostgreSQL official docs · psql](https://www.postgresql.org/docs/current/app-psql.html)
- [PostgreSQL official docs · F.32. pg_stat_statements — track statistics of SQL planning and execution](https://www.postgresql.org/docs/current/pgstatstatements.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [pg_stat observation views](../internals/pg-stat-observation)
- [lock conflict troubleshooting](../internals/lock-conflict-troubleshooting)
- [slow query governance](../performance/slow-query-governance)
- [psql advanced](./psql-advanced)
- [common-errors-and-troubleshooting](/appendix/common-errors-and-troubleshooting.md)
- [client-drivers](client-drivers.md)
- [index](index.md)
- [pgadmin-4](pgadmin-4.md)
- [psql-advanced](psql-advanced.md)
Official docs: [monitoring and statistics](https://www.postgresql.org/docs/current/monitoring-stats.html), [auto_explain](https://www.postgresql.org/docs/current/auto-explain.html), [logging configuration](https://www.postgresql.org/docs/current/runtime-config-logging.html).
