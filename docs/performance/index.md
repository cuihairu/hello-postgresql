# Query Performance

How to read EXPLAIN, statistics, pg_stat_statements, the slow-query governance loop, and parameter tuning — from spotting a problem to verifying the fix.

- [How to Read EXPLAIN](explain-basics.md) — what cost/rows and the fields mean, the plan tree inside out.
- [EXPLAIN (ANALYZE, BUFFERS, WAL)](explain-analyze-buffers.md) — real execution, cache hits, IO counts.
- [Common Bad Plans](common-bad-plans.md) — full scans on big tables, rows mis-estimated, nested loop blowups.
- [Statistics and ANALYZE](statistics-and-analyze.md) — sample rate, bumping it manually, stale statistics.
- [pg_stat_statements](pg-stat-statements.md) — top SQL, normalization, resets.
- [The Slow-Query Governance Loop](slow-query-governance.md) — collect to reproduce to rewrite to verify with A/B.
- [Connection and ORM Optimization](connection-and-orm-optimization.md) — N+1, batching, prepared statements.
- [Write Throughput Optimization](write-throughput-optimization.md) — batched inserts, unlogged tables, commit frequency.
- [Parameter Tuning](parameter-tuning.md) — shared_buffers, work_mem, effective_cache_size.
- [Partition Pruning and Pruning Failures](partition-pruning.md) — constraint exclusion, runtime pruning, partition key design.
- [Locking and Concurrency Bottlenecks](lock-and-concurrency-bottlenecks.md) — long transactions, hot rows, advisory-lock queues.
- [How VACUUM Stalls Affect Performance](vacuum-stall-and-performance.md) — IO contention, the age threshold, monitoring.
- [Benchmarking Tools](benchmark-tools.md) — custom pgbench scripts, metric definitions.
- [Capacity and Scaling Limits](capacity-and-scaling-limits.md) — single-node ceilings, when to shard.

---

- [Internals](../internals/) · [Indexing](../indexing/) — the principles behind the tuning.

<!-- BACKLINKS-AUTO -->
## Related Pages

- [index](/indexing/index.md)
- [index](/internals/index.md)
- [index](/tools/index.md)
