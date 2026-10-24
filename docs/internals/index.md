# Internals

Process model, MVCC, WAL, locking, TOAST, executor and optimizer — the part that explains why PostgreSQL runs the way it does.

- [Process Architecture](process-architecture.md) — postmaster, backends, autovacuum, background workers.
- [MVCC and Multi-Versioning](mvcc-and-multi-version.md) — tuple headers, xmin/xmax, snapshots.
- [Transactions and Isolation Levels](transactions-and-isolation.md) — READ COMMITTED as the default, RR/SSI, read-anomaly comparison.
- [VACUUM and HOT](vacuum-and-hot.md) — dead tuples, the visibility map, HOT updates, fillfactor.
- [autovacuum Tuning](autovacuum-tuning.md) — thresholds and scale factors, cost delay, diagnosing stalls.
- [WAL Mechanics](wal-mechanism.md) — WAL records, LSN, crash recovery.
- [Checkpoints and Buffers](checkpoint-and-buffer.md) — shared_buffers, bgwriter/checkpointer.
- [The Lock System](lock-system.md) — table lock modes, row locks via FOR UPDATE, advisory locks.
- [Diagnosing Lock Conflicts](lock-conflict-troubleshooting.md) — pg_locks, pg_blocking_pids, retrying deadlocks.
- [TOAST](toast.md) — external storage and compression for large fields, the effect on DML behavior.
- [Snapshots and Visibility Decisions](snapshot-and-visibility.md) — command id, clog, transaction states.
- [The Query Execution Pipeline](query-execution-pipeline.md) — parse to rewrite to plan to execute.
- [The Optimizer Cost Model](optimizer-cost-model.md) — cost estimation, pg_statistic, histograms.
- [Join Implementations](join-implementations.md) — when to pick nested loop, merge, or hash.
- [Parallel Queries](parallel-query.md) — parallel workers, cost thresholds, cases that will not parallelize.
- [Plan Cache and Generic Plans](plan-cache-and-generic-plan.md) — prepared-statement plan drift.
- [Logical Replication Internals](logical-replication-internals.md) — wal_level, logical decoding, publications/subscriptions.
- [Streaming Replication and Synchronization](streaming-replication-and-sync.md) — primary/standby, synchronous_commit.
- [Architecture and Memory](architecture-and-memory.md) — work_mem, maintenance_work_mem, OOM risk.
- [Observing with pg_stat](pg-stat-observation.md) — stat_activity, stat_statements, stat_io.

---

- [Indexing](../indexing/) · [Query Performance](../performance/) — where internals knowledge gets applied.

<!-- BACKLINKS-AUTO -->
## Related Pages

- [index](/operations/index.md)
- [index](/performance/index.md)
