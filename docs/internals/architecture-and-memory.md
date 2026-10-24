# Architecture and Memory

PostgreSQL uses a "one connection, one process" model: postmaster listens on the port, and each client connection forks a backend process. Memory therefore naturally splits into two parts — the **shared memory** allocated once at startup and shared by all processes, and the **private memory** each backend owns on its own. Capacity planning, OOM investigation, and understanding why a parameter "doesn't take effect" all come back to this boundary. For the full classification of processes, see [Process Architecture](./process-architecture).

## Shared Memory

postmaster allocates the shared memory segment and semaphores at startup, and they are destroyed when the instance exits. Main components:

- `shared_buffers`: the data page buffer pool, through which all processes read and write table and index pages. Only 128MB by default; in production it usually gets about 25% of physical memory (past that ratio the returns diminish, and the OS page cache takes over the remaining reads).
- WAL buffers (`wal_buffers`): the buffer before a transaction writes WAL; the default `-1` means 1/32 of `shared_buffers`.
- SLRU buffers: clog (`pg_xact`, transaction commit status), subtrans, multi-xacts, etc. — visibility determination depends on it, see [Snapshots and Visibility](./snapshot-and-visibility) for details.
- The lock table, replication slots, logical decoding state, and since PG 15 the accumulated statistics (see [Observing With pg_stat](./pg-stat-observation)).

`huge_pages = try/on` makes shared memory use large page mappings; instances with large `shared_buffers` get fewer TLB misses and avoid memory being gradually swapped out. A one-line config that is a routine optimization.

## Backend Private Memory

Each backend has its own memory context tree, in which two parameters determine the bulk:

- **`work_mem`**: the upper limit of the private work area for each **operation node** — Sort, Hash, hash aggregation, window functions, and so on; when it doesn't fit, it spills to temp files. The key is that its unit is not "per query" but "per node per operation": a query with multiple sorts/hashes occupies several shares at once, and with parallel query each worker holds its own share.
- **`maintenance_work_mem`**: the per-process limit for maintenance operations such as VACUUM, CREATE INDEX, and foreign key validation. These operations usually don't run concurrently, so it can be set larger than `work_mem`; the exception is autovacuum workers — they are resident and concurrent, up to `autovacuum_max_workers` shares, and can be limited separately with `autovacuum_work_mem`.
- **`temp_buffers`**: the page buffer used for accessing temporary tables within a session, 8MB by default; only sessions using temp tables need to tune it.
- Beyond these there are fixed overheads — the relation cache (relcache), the catalog cache (catcache), plan contexts, etc. — tens of MB per process.

## The OOM Arithmetic of connections × work_mem

The classic OOM formula is not `max_connections × work_mem` but "the number of nodes in concurrently active queries × work_mem":

```plaintext
Example: max_connections = 200
   A report query with 3 hash + 2 sort nodes, work_mem = 64MB
   → single-session peak ≈ 5 × 64MB = 320MB
   → 200 connections all running ≈ 64GB, not counting each parallel worker's share and maintenance_work_mem
```

Corresponding mitigations, by priority:

1. **A connection pool** compresses actual concurrency to the order of the CPU core count (for transaction mode see [Connection and ORM Optimization](../performance/connection-and-orm-optimization)); this matters more than any memory parameter.
2. Keep `work_mem` at a conservative global value, and `SET` it separately for the **roles or sessions** that run heavy queries.
3. For highly parallel databases, add "worker count × work_mem" into the ledger.
4. Know the OOM killer's behavior: it kills the process with the largest total machine memory usage, which usually lands squarely on the backend running the big query; the whole connection (and its transaction) disappears together, and the log usually shows `server process was terminated by signal 9`.

## Frequently Misunderstood Parameters

- **`effective_cache_size` does not allocate any memory**. It only tells the optimizer "how much OS page cache + shared_buffers a query is expected to hit", influencing plan decisions such as whether to pick an index. Setting it absurdly low makes the optimizer underestimate cache hits and lean toward serial scans.
- `work_mem` is a **per-operation** limit, not a total; raising it relaxes the spill-to-disk threshold and doesn't mean that much will actually be allocated at once (allocation is on demand).
- Temp files (sort/hash spills) take neither shared memory nor the work_mem quota; they only land on the disks `temp_tablespaces` points to, monitored via `pg_stat_database.temp_bytes`.

## Observation

Session-level memory detail (PG 14+), showing at a glance who is eating memory:

```sql
SELECT name, parent, level,
       pg_size_pretty(total_bytes) AS total,
       pg_size_pretty(used_bytes)  AS used
FROM pg_backend_memory_contexts
ORDER BY total_bytes DESC
LIMIT 15;
```

On the shared memory side, the `pg_buffercache` extension can break down shared_buffers usage by database/table; the background-writer views were split up once in PG 17 — the original `pg_stat_bgwriter` spun out `pg_stat_checkpointer` (checkpoint and restartpoint statistics), while `pg_stat_bgwriter` itself keeps only the bgwriter process's buffer-write statistics. Check the new view when tuning checkpoint parameters.

For process-level memory usage, you ultimately have to look at the OS:

```bash
ps -o pid,rss,cmd -u postgres | sort -k2 -rn | head
```

## Notes and Common Pitfalls

- "I raised `work_mem` but the sort still spills": first confirm which node type in the plan is spilling (the `Sort Method` in `EXPLAIN ANALYZE`), then confirm whether the scope was set at the wrong level.
- `shared_buffers` changes require a restart; `work_mem`/`effective_cache_size` are reload-level and can be overridden at session level — when troubleshooting, first `SHOW` the actual value in the current session, don't just look at the config file.
- An idle connection takes only tens of MB; memory peaks all happen during query execution. Capacity planning based on "average connection memory × connection count" will seriously underestimate.

## References

- [PostgreSQL Official Docs · 19.4. Resource Consumption](https://www.postgresql.org/docs/current/runtime-config-resource.html)
- [PostgreSQL Official Docs · 66.6. Database Page Layout](https://www.postgresql.org/docs/current/storage-page-layout.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [checkpoint-and-buffer](checkpoint-and-buffer.md)
- [index](index.md)
- [join-implementations](join-implementations.md)
- [lock-system](lock-system.md)
- [parallel-query](parallel-query.md)
- [process-architecture](process-architecture.md)
- [query-execution-pipeline](query-execution-pipeline.md)
- [cloud-native-and-containers](/operations/cloud-native-and-containers.md)- [Process Architecture](./process-architecture) — the family portrait of postmaster/backend/worker.
- [Checkpoint and Buffer](./checkpoint-and-buffer) — the write side of shared_buffers.
- [Parameter Tuning](../performance/parameter-tuning) — where these parameters sit in overall tuning.
- [Connection and ORM Optimization](../performance/connection-and-orm-optimization) — compress the concurrency first.

Official docs: <https://www.postgresql.org/docs/current/runtime-config-resource.html> and <https://www.postgresql.org/docs/current/storage-page-layout.html>
