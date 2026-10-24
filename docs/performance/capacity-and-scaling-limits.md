# Capacity and Scaling Limits

PostgreSQL's theoretical ceilings are high (a single table can reach 32TB, and the B-tree of a few billion rows is still only 4-5 levels tall); what usually runs out first is WAL bandwidth, checkpoint cadence, and connection memory. This page records how to estimate the single-node boundary, and when read replicas, partitioning, and sharding each apply—choosing the order of scaling steps correctly means most scenarios never need sharding.

## The Single-Node Write Boundary: WAL Bandwidth and Checkpoints

Every commit means at least one WAL flush, so **sustained write throughput's ceiling ≈ the fsync bandwidth of the WAL device ÷ the WAL bytes per row of data**. Row WAL includes index maintenance and page overhead, so wide tables with many indexes see significant WAL amplification. Group commit (which happens automatically under concurrency, or can be tuned with `commit_delay`) spreads out the fsync count, but it cannot amortize the WAL bytes themselves.

The second constraint is checkpoints: continuous writes trigger a checkpoint for every `max_wal_size` worth of WAL produced, flushing all dirty pages in one burst, and the p95 jitter of write peaks mostly comes from here. Observe the two together:

```sql
-- WAL byte rate (PG 14+): divide between two snapshots
SELECT wal_bytes FROM pg_stat_wal;

-- checkpoints requested proactively (many req means max_wal_size is too small)
SELECT checkpoints_timed, checkpoints_req FROM pg_stat_bgwriter;
-- since PG 17:
SELECT num_timed, num_requested FROM pg_stat_checkpointer;
```

Decision signals: `checkpoints_req` taking a high share, WAL rate close to the disk's sequential write bandwidth, and write-peak latencies coinciding with checkpoint times—these mean you are heading into the single-node write boundary. Load-test methods are in [Benchmark Tools](./benchmark-tools); WAL mechanics in [WAL Mechanics](../internals/wal-mechanism).

## The Arithmetic of Connection Counts and Memory

Each connection is a separate process: a few MB of base memory, plus one `work_mem` per active sort/hash node, plus temporary objects. The worst-case formula:

```plaintext
memory ceiling ≈ max_connections × (base memory + work_mem × average sort node count)
```

Example: 500 connections × (5MB + 64MB × 2) ≈ 67GB—a 64GB machine is theoretically breached already, and business peaks really do turn "worst case" into "average". The engineering conclusions:

- **Keep active connections at 2-4 times the core count** and let everything else queue at the application side or in the connection pool;
- Connection count is a demand, not a capacity—converge it with transaction-level pooling like PgBouncer, see [Connection and ORM Optimization](./connection-and-orm-optimization);
- max_connections and work_mem must be evaluated together; raising either alone is an OOM trap.

## The Boundary of Table Size

The official theoretical limits (<https://www.postgresql.org/docs/current/limits.html>):

- A single table tops out at 32TB (32-bit block number × 8KB pages);
- A single row can reach about 1.6TB (large values go to TOAST), with at most 1600 columns;
- Each B-tree level fans out to a few hundred, so the index of a few billion rows is still only 4-5 levels tall—point lookups do not gain levels because a table is big; this is not the bottleneck.

What runs out first is **operational time**, not engine capability: a full VACUUM takes hours, how long a REINDEX holds locks, how long a backup restore takes, how long it takes to fix an accidental column drop. Practical conclusion: a single table in the several-hundred-GB range and row counts in the billions are still fine to serve; once maintenance windows and bloat management start eating engineering time, partition by time or tenant—see [Table Inheritance and Partitioning Design](../database-design/table-inheritance-and-partitioning-design).

## When to Add Read Replicas, Partitioning, or Sharding

Match the bottleneck type, cheapest first:

- **Read throughput is short** → streaming replication read replicas to spread the read load (watch the replication lag's impact on read-after-write), see [High Availability Architecture](../operations/high-availability-architecture);
- **A single table is too large, painful to maintain, old data is cold** → declarative partitioning; queries carrying the partition key get pruning, see [Partition Pruning](./partition-pruning);
- **Write throughput has genuinely hit the single-node WAL limit** → write sharding, splitting data across machines by shard key. Citus is the standard answer on this path: an extension that splits a PG table by distribution column across nodes for parallel processing, see [Citus](../ecosystem/citus).

## When to Change the Approach Rather Than Scale the Database

Sharding is a heavy decision: cross-shard transactions, resharding, and cross-shard joins will follow the team for a long time. Before acting, rule out "fake write bottlenecks":

- Are the top write queries in pg_stat_statements just missing batching (see [Write Throughput Optimization](./write-throughput-optimization)) or carrying extra indexes?
- Can high-frequency small transactions be peak-shaved with a queue and written asynchronously?
- Can hot reads be offloaded to a cache?
- Is the bottleneck lock queueing (hot rows) rather than IO? That is an application design problem; more machines will not help.

Suggested decision order: confirm the hotspot with pg_stat_statements → SQL and index optimization → offload to cache and queues → read/write splitting → partitioning → and only last, write sharding. Most businesses stop at "read/write splitting + partitioning".

## The Capacity Planning Checklist

Walk through it periodically (or before big promotions / new business launches):

```plaintext
- hourly WAL generation (pg_stat_wal deltas) versus remaining WAL disk space;
- disk backstop for lagging replication slots: whether max_slot_wal_keep_size is set;
- annual growth estimates for tables and indexes, mapped to the duration of one VACUUM / REINDEX;
- recalculate the memory ceiling: max_connections × (base + work_mem × node count);
- target active connection count and pooling plan;
- measure backup and restore time at the target capacity by rehearsal, not by estimate;
- p95 latency headroom: current peak latency ÷ target utilization, keeping at least 2x headroom.
```

## References

- [PostgreSQL Official Documentation · Appendix K. PostgreSQL Limits](https://www.postgresql.org/docs/current/limits.html)
- [PostgreSQL Official Documentation · 14.1. Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [pgvector](/ecosystem/pgvector.md)
- [when-to-choose-postgresql](/ecosystem/when-to-choose-postgresql.md)
- [checkpoint-and-buffer](/internals/checkpoint-and-buffer.md)
- [connection-and-orm-optimization](connection-and-orm-optimization.md)
- [index](index.md)- [Write Throughput Optimization](./write-throughput-optimization)——squeeze single-node write capability before hitting the ceiling.
- [Connection and ORM Optimization](./connection-and-orm-optimization)——engineering the connection arithmetic.
- [Table Inheritance and Partitioning Design](../database-design/table-inheritance-and-partitioning-design)——the first step of splitting a large table.
- [Citus](../ecosystem/citus)——the reference solution when real write sharding is needed.

Official docs: <https://www.postgresql.org/docs/current/limits.html>
