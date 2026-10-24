# Process Architecture

PostgreSQL uses a one-process-per-connection model: the postmaster process listens on the port, and once a client has authenticated it forks a dedicated backend process to serve that connection; when the connection drops, the process exits. Processes talk to each other only through shared memory and signals, with no shared heap memory — which is what shapes PostgreSQL's fundamentals of isolation, stability, and connection cost.

## postmaster and backend

postmaster (the `postgres` executable running as the main process) does only three things:

- listens on the TCP port and the Unix socket, and forks a backend process for each new connection after authentication passes;
- manages the lifecycle of all child processes: when one backend crashes, postmaster terminates the rest of the processes and enters crash recovery (replaying WAL);
- does not participate in SQL parsing, planning, or execution.

Each backend completes all the work of its own session independently: parsing, optimizing, executing, and returning results. The upside of process isolation is that a memory error in one connection is unlikely to directly pollute another; the price is that process creation and context switching are heavier than threads, so once connection counts grow, memory and scheduling pressure become obvious.

## Comparison with MySQL's "one thread per connection"

| Dimension | PostgreSQL | MySQL (InnoDB) |
| --- | --- | --- |
| Connection carrier | One independent OS process per connection | One thread per connection, all sharing the same process address space |
| Connection cost | fork is heavy; even an idle backend holds a few MB of memory | Thread creation is light, and stack memory is controllable |
| Isolation | Process-level isolation, exchanging data through shared memory | Threads share heap memory, managed by a unified executor |
| Crash impact | A crash in any one backend restarts the entire instance | Ordinary query errors do not affect other connections; fatal errors restart the instance the same way |

The conclusion is the same for both: connections themselves are expensive, so in production both kinds of database should use a connection pool rather than creating a new connection per request.

## The auxiliary process list

After the instance starts, postmaster forks a set of resident auxiliary processes. `pg_stat_activity.backend_type` lets you tell them apart from client connections:

| Process | Responsibility |
| --- | --- |
| checkpointer | Performs checkpoints: flushes dirty pages in bulk and advances the recovery point. See [Checkpoints and Buffers](./checkpoint-and-buffer) |
| background writer | Flushes dirty buffers ahead of time between two checkpoints, smoothing IO |
| walwriter | Flushes WAL buffers to disk, spreading out the fsync pressure on the commit path |
| autovacuum launcher / worker | The launcher schedules periodically; the worker actually does the cleanup. See [Autovacuum Tuning](./autovacuum-tuning) |
| WAL sender | One walsender process per downstream of streaming replication or logical replication |
| archiver | Copies a full WAL segment to the archive location (archive_command / archive_library) |
| logical replication launcher / worker | The launcher and apply processes on a logical replication subscriber |
| stats collector | Collects runtime statistics. **Removed from PG 15 on**; statistics are now written directly into shared memory |

## Private memory of a backend

Each backend process has a private memory area all to itself, which mainly includes:

- `work_mem`: working memory for sort, hash join, aggregation, and other nodes. Note that one query can have several nodes each requesting their own, and in parallel execution every worker gets its own copy too;
- `maintenance_work_mem`: used by maintenance operations such as VACUUM, CREATE INDEX, and ALTER TABLE; autovacuum workers are separately governed by `autovacuum_work_mem` (default -1, which takes maintenance_work_mem);
- `temp_buffers`: buffers for temporary table pages;
- relcache / catcache: the in-process cache of system catalogs (pg_class, pg_attribute, and so on), which stays resident after first access — this is one reason a long-lived connection is usually faster than opening a new one each time.

What all processes share is shared memory such as shared_buffers, WAL buffers, the lock table, and the transaction status (clog) cache. For the full memory picture see [Architecture and Memory](./architecture-and-memory).

## Why connections are expensive, and why connection pooling is necessary

- Each backend is an independent process: fork, page-table copying, and catalog cache initialization all happen at connection time, and a storm of short-lived connections pays these costs over and over;
- Each connection holds a few MB to tens of MB of memory (caches grow with usage), so a thousand idle connections can eat several GB;
- Too many active connections amplify the overhead of process scheduling, the lock table, and snapshot management; `max_connections` (default 100) often falls far short of the machine's real capacity, and performance collapses first.

So the standard practice is to deploy a connection pool (PgBouncer, or a driver/gateway with session pooling) and serve thousands of client sessions with a few dozen to a hundred real backends. Under transaction-level pooling, session-level features (prepared statements, advisory locks, SET session variables) need extra handling. See [Connection Management](../operations/connection-management) for details.

## Observability SQL

```sql
-- All server-side processes and their role distribution in the current instance
SELECT backend_type, count(*)
FROM pg_stat_activity
GROUP BY backend_type
ORDER BY backend_type;
```

```sql
-- Client connection details: who, where from, waiting on what, how long the transaction has been open
SELECT pid, usename, datname, client_addr, state,
       wait_event_type, wait_event,
       now() - xact_start AS xact_age, query
FROM pg_stat_activity
WHERE backend_type = 'client backend'
ORDER BY backend_start;
```

```sql
-- The backend process number for the current session, so you can match it up against ps / top
SELECT pg_backend_pid();
```

On the operating system side you can look at the process tree directly:

```plaintext
# $PGDATA points at the data directory
pstree -p $(head -1 $PGDATA/postmaster.pid)
```

## Notes and common pitfalls

- Do not ride out a connection storm by raising `max_connections`; put a connection pool in first. The memory and scheduling cost of backends is real, and blindly raising the limit just postpones the problem until OOM.
- An OOM or assertion failure in a single backend takes down the entire instance and triggers crash recovery — this is inherent in the shared-memory design and must not be treated as "one connection went bad". When investigating, check the instance logs first, then look at whether a large query or a connection pool setting is the cause.
- `pg_stat_activity` reflects only a snapshot of the present; for historical problems combine the instance logs with [pg_stat_statements](../performance/pg-stat-statements).

## References

- [PostgreSQL official documentation · 1.2. Architectural Fundamentals](https://www.postgresql.org/docs/current/tutorial-arch.html)
- [PostgreSQL official documentation · 27.2. The Cumulative Statistics System](https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-STATS-ACTIVITY-VIEW)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [when-to-choose-postgresql](/ecosystem/when-to-choose-postgresql.md)
- [architecture-and-memory](architecture-and-memory.md)
- [index](index.md)
- [parallel-query](parallel-query.md)
- [knowledge](/knowledge.md)
- [cluster-init-and-layout](/operations/cluster-init-and-layout.md)
- [connection-management](/operations/connection-management.md)
- [client-drivers](/tools/client-drivers.md)- [Architecture and Memory](./architecture-and-memory) — the complete layout of shared and private memory.
- [Connection Management](../operations/connection-management) — connection count control and pooling practice.
- [pg_stat Observability](./pg-stat-observation) — systematic use of the pg_stat family of views.

Official docs: <https://www.postgresql.org/docs/current/tutorial-arch.html> and <https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-STATS-ACTIVITY-VIEW>
