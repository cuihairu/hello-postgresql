# Choosing PostgreSQL

This page answers "should this business use PostgreSQL". Database selection has no universal answer, but there is a reusable decision framework: first lay out the business characteristics clearly (data shape, read/write ratio, consistency requirements, team skills), then weigh the cost and benefit of each candidate. For the architectural background referenced here, see [What Is PostgreSQL](../basics/what-is-postgresql); for an item-by-item comparison with MySQL, see [PostgreSQL vs MySQL](./comparison-with-mysql).

When I make a selection decision, I first go through the two checklists below, then look at the Q&A with the concrete business questions in hand, and finally return to the three questions in the "Summary" to double-check the call. The most common failure in selection discussions is drawing a conclusion from a single dimension ("MySQL is simple", or "PG has more features") while skipping the two variables with the largest long-term weight: team and operations cost.

## When PostgreSQL Is the Right Choice

- **High query complexity**: multi-dimensional reports, windowed computation, recursive hierarchies, mixed JSON/array queries — PG's SQL capability keeps a lot of the shaping inside the database, so you do not pull data back to the application layer.
- **Data integrity first**: the constraint system (foreign keys, CHECK, exclusion constraints, deferrable constraints) plus serializable isolation suits scenarios like accounting, inventory, and orders where "one wrong row is an incident".
- **Mixed relational and document modeling**: the core is relational data with flexible fields mixed in. JSONB plus a GIN index covers most document needs, without giving up transactions and JOINs.
- **Reliance on the extension ecosystem**: vector (pgvector), spatial (PostGIS), time series (TimescaleDB), and distributed (Citus) all live inside the same engine, avoiding a separate storage system per capability.
- **License freedom**: the PostgreSQL License is permissive with no single vendor control; self-host, cloud-host, or commercial distribution, and you are never tied by license fees.

## When to Be Cautious

- **Write scale genuinely needs horizontal sharding**: the business has no natural shard key and write throughput far exceeds the single-node ceiling. The complexity of a distributed retrofit exists on any database, and PG is no exception.
- **Deep MySQL experience on the team and a simple workload**: CRUD-heavy, no complex queries, and the team's existing operational assets (monitoring, backups, rehearsal runbooks) are all on MySQL — the migration gains usually will not cover the cost.
- **Tightly bound to a specific managed product**: some "PG-compatible" services have their own storage and internal mechanisms; moving in is easy and moving out is hard, so think through the exit path first.
- **Extremely simple single-table key-value workloads**: only a few tables, pure primary-key read/write, very high peak concurrency — for these, MySQL and various KV stores have more comfortable precedents, and PG's capability goes mostly unused.
- **A hard compliance requirement to pin a specific version**: some industries must stay long-term on a particular certified version. PG's one-major-release-a-year cadence needs planning ahead, not passive following.

## Selection Q&A

### How much data can PG handle?

Single-instance TB scale is a common level, and a single table at the hundreds of millions of rows works fine with partitioning and the right indexes. The real ceiling is usually not the data volume but: whether the working set is cache-resident, the connection count and memory model, and whether vacuum can keep up with writes. The usual path as data grows is "optimize indexes and parameters first → route read traffic to replicas → partition by time or key → go distributed only when genuinely needed". For capacity planning, see [Capacity and Scaling Limits](../performance/capacity-and-scaling-limits).

Asked the other way it is more useful: what signals say "you are still in the single-node comfort zone"? — stable cache hit rates, no vacuum backlog, slow queries concentrated in a handful of SQLs, an acceptable backup window. When those indicators are all healthy, the data volume alone is not a reason to migrate.

### Do you need to split into multiple databases and tables?

Most businesses do not. The middleware-based sharding popular in the MySQL ecosystem solves a "single-machine era" problem, and PG offers an intermediate form: native partitioning handles a single table growing too large and its lifecycle management, and Citus provides distributed capability when horizontal scaling is genuinely needed while keeping single-database SQL semantics (see [Citus: Distributed PostgreSQL](./citus)). Suggested decision order: exhaust single-machine measures first, then consider partitioning, and only then cross-machine sharding — each step to the right is an order of magnitude in operational complexity.

### How do you choose a managed service?

Mainstream managed offerings such as RDS for PostgreSQL, Cloud SQL, and Alibaba Cloud RDS for PostgreSQL all work. Beyond price comparison, check four things: whether the extension allowlist includes what you need (pgvector, PostGIS, and similar), how fast it follows major versions, whether logical replication is supported (your way out for upgrades and migrations), and how the storage architecture differs from native (some compatible implementations have their own I/O model). For self-hosted containerized options, see [Cloud-Native and Containerized Deployment](../operations/cloud-native-and-containers).

### Is migrating from MySQL worth it?

It depends on whether the pain exists: being repeatedly drained by JSON handling, complex reports, and type holes means migration has a clear payoff; if everything is fine, do not touch it. The real cost of migration is in rewriting SQL (see the syntax differences checklist in [PostgreSQL vs MySQL](./comparison-with-mysql)), introducing a connection pool, and retraining the team — not in the installation itself. The safest path is a dual-track transition: new services go straight to PG, legacy systems keep running on MySQL, FDW provides a read-only joined query as a safety net, and you switch service by service rather than moving everything at once.

### Does high-concurrency writing hurt?

Simple high-concurrency point writes (identity primary keys, short transactions) are a traditional MySQL/InnoDB strength, and PG is adequate on the same kind of workload (thousands of TPS per node is common). But you need to understand its MVCC cost: updates produce a new version, and reclaim depends on vacuum. Get the write path right — bulk writes, HOT updates, controlling long transactions, sensible fillfactor — and PG's write throughput satisfies most OLTP businesses. At the extreme end of write throughput, both databases need architecture-level splitting. See [Write Throughput Optimization](../performance/write-throughput-optimization).

One frequently cited failure mode: updating the same row at high frequency (seckill-style hot counters) forms a row lock queue plus version pileup on PG. For those hotspots, either change the data structure (a queue, or a Redis counter backfilled later) or flatten them with partitioning — grinding on at the row level is not recommended on either side.

### For JSON document scenarios, should you just use a document database?

If documents need to transact, JOIN, and be constraint-checked together with relational data, PG's JSONB is the easier option: one storage, one backup, one permission system. When the document count reaches hundreds of millions, the access pattern is fully key-value, and the team already operates MongoDB with the matching operational capability, a dedicated document database is the reasonable choice. The criterion is how strongly related the data is, not "whether there is JSON".

### How risky is a major version upgrade?

PG ships one major version a year, and minor versions only fix bugs without changing behavior. There are two mature paths for a major upgrade: `pg_upgrade` (a minute-scale downtime window) and a logical-replication cutover (near-zero downtime). See [Version Upgrade](../operations/version-upgrade). Managed services usually offer one-click minor upgrades. Compared with some databases' major-version breaks, PG's upgrade cost is controllable — do not stay on an old version out of "fear of upgrading", because losing security fixes is the real risk.

### What if the team has no PG experience?

The learning curve from MySQL to PG is gentle: the SQL trunk is the same, and the four things to shore up are the connection pool and process model, vacuum and bloat, reading EXPLAIN, and MVCC isolation behavior. The [internal mechanics](../internals/process-architecture) and [performance diagnosis](../performance/explain-basics) sections of this site cover those topics. An ORM hides most dialect differences; the real pitfalls concentrate on the operations side, so I make sure someone on the team owns the operations track.

### What should you watch in the first month after launch?

After the selection lands, the habits worth building in the first few weeks (much cheaper than firefighting later):

- **Connection pool first**: wire the application straight to PgBouncer or a managed connection proxy; do not wait for the connection count alarm before adding it;
- **Watch autovacuum**: confirm the single-round vacuum duration and dead tuple level for high-update tables; see [Autovacuum Tuning](../internals/autovacuum-tuning) for baseline data;
- **Install pg_stat_statements**: accumulate SQL time-to-execute data from day one so there is evidence to govern by later. See [pg_stat_statements](../performance/pg-stat-statements);
- **Backups must be rehearsed for restore**: periodically restore a backup to a scratch instance and spot-check the data. A backup whose restore has never been verified is not a backup. See [Backup Strategy](../operations/backup-strategy);
- **Alert on long transactions**: set an alert for transactions running beyond the minutes. This is one of the few items in the PG world that "should be treated as a red line from the start".

## Summary

Compress the decision into three questions: does the business need PG's SQL depth and extension ecosystem? Can the team take on switching operational models? Does the existing MySQL solution have real pain points? If two of the three are "yes", migrating to and choosing PG is worth doing. Otherwise, MySQL continuing to serve this workload is entirely defensible. Both are systems proven at large production scale, and the cost of the selection disagreement is usually smaller than the cost of not operating well after the choice.

## References

- [wiki.postgresql.org/wiki/Foreign_data_wrappers](https://wiki.postgresql.org/wiki/Foreign_data_wrappers)
- [GitHub · pgvector/pgvector](https://github.com/pgvector/pgvector)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [PostgreSQL vs MySQL](./comparison-with-mysql)
- [What Is PostgreSQL](../basics/what-is-postgresql)
- [Citus: Distributed PostgreSQL](./citus)
- [Capacity and Scaling Limits](../performance/capacity-and-scaling-limits)
- [citus](citus.md)
- [comparison-with-mysql](comparison-with-mysql.md)
- [index](index.md)
- [pgvector](pgvector.md)
- [timescaledb](timescaledb.md)