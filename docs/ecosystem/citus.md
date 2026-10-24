# Citus: Distributed PostgreSQL

Citus is the extension that turns PostgreSQL into a distributed cluster: data is hashed across multiple workers by a shard key, the coordinator holds metadata and plans, and a query is either routed whole to a single node or executed in parallel across nodes. It is an extension rather than a fork, so SQL compatibility, drivers, and the toolchain stay native. The project is open source (all features open source since Citus 11, AGPL license); the source is at [github.com/citusdata/citus](https://github.com/citusdata/citus).

## Coordinator and Worker Architecture

A Citus cluster has two kinds of nodes:

- **coordinator**: ordinary PostgreSQL plus the citus extension. It stores metadata (shard distribution, node list), accepts all client connections, rewrites SQL into shard-targeted subqueries, dispatches execution, and assembles results. DDL (table creation, sharding) is also initiated here.
- **worker**: a PostgreSQL node holding shard data. Each shard is just an ordinary PG table (in partition form), and high availability comes from the worker's own streaming replication. See [Streaming and Synchronous Replication](../internals/streaming-replication-and-sync).

All traffic passes through the coordinator, so the coordinator's connection count and aggregate throughput are one of the cluster's ceilings (since Citus 11, read-only failover patterns and similar are supported to ease this).

## Three Kinds of Tables: Distributed, Reference, Local

```sql
CREATE EXTENSION citus;

-- Add workers to the cluster
SELECT citus_add_node('10.0.0.11', 5432);
SELECT citus_add_node('10.0.0.12', 5432);

-- Distributed table: sharded by hash on tenant_id
SELECT create_distributed_table('orders', 'tenant_id', shard_count => 32);

-- Reference table: a small dimension table, replicated in full to every worker
SELECT create_reference_table('countries');

-- Local table: not distributed, exists only on the coordinator
CREATE TABLE ops_log (id bigint GENERATED ALWAYS AS IDENTITY, msg text);
```

- **Distributed table**: split into 32 shards by default (`shard_count` is adjustable; take a several-fold multiple of the worker count so rebalancing has room), with each shard landing on some worker.
- **Reference table**: small tables like countries, currencies, and config are replicated to all workers, so a transaction on any node can JOIN against them locally and take a foreign key on them.
- **Local table**: an ordinary table left on the coordinator, suitable for small or operations-only tables.

## Colocation: the Key to Joins and Foreign Keys

Hash sharding cuts the key space into a fixed number of "buckets"; tables whose shard key hashes fall in the same bucket range get their corresponding shards placed on the same worker. That is colocation. Colocating all tenant-related tables on the same key buys three direct benefits:

- JOINs between colocated tables finish on a single node, with no data moved across the network;
- colocated tables can have foreign keys between them, with referential integrity guaranteed by local constraints;
- a query carrying the shard key is routed whole to a single node (see the next section), with latency no different from a single machine.

```sql
SELECT create_distributed_table('tenants',  'id');
SELECT create_distributed_table('orders',   'tenant_id', colocate_with => 'tenants');
SELECT create_distributed_table('payments', 'tenant_id', colocate_with => 'tenants');
```

Remember the limits too: unique constraints and primary keys must include the shard column (otherwise uniqueness cannot be guaranteed globally); non-colocated distributed tables cannot have a direct foreign key between them; cross-shard queries use two-phase commit (`citus.multi_shard_commit_protocol = '2pc'`) for atomicity, but isolation levels and latency should not be expected to match a single machine.

## Query Routing and Distributed Execution

```sql
-- With shard key: the whole SQL is routed to the worker holding that tenant, single-node speed
SELECT * FROM orders WHERE tenant_id = 42 AND status = 'pending';

-- Without shard key: split into one subquery per shard, run in parallel, then the coordinator merges
SELECT count(*) FROM orders WHERE created_at > now() - interval '1 day';

-- Colocated JOIN: each worker finishes the JOIN locally, the coordinator only merges
SELECT t.name, count(*) FROM orders o JOIN tenants t ON t.id = o.tenant_id GROUP BY t.name;
```

In `EXPLAIN` output you will see `Custom Scan (Citus ...)`, which states whether it is a router or a multi-shard plan. Look at that line first when hunting down slow queries, to judge whether the SQL carried the shard key. Colocated JOIN plans and the single-node algorithms in [Join Implementations](../internals/join-implementations) are two separate paths; do not mix the tuning experience between them.

## When It Fits and When It Does Not

Shapes that fit Citus:

- **Multi-tenant SaaS**: naturally has tenant_id, and after colocation each tenant is a "small database" on one machine. Tenant-scoped routed queries and cross-tenant aggregation both work well — this is Citus's most mature use;
- **Real-time analytics / high-throughput write OLAP**: events, logs, and metrics distributed by time + key, with multi-node parallel aggregation;
- a single table already at the TB scale, single-node writes truly maxed out, and the business can live with organizing data by shard key.

Signals that it does not fit:

- the core transaction flow is heavy, cross-shard, strongly transactional OLTP (such as globally unique users transferring to each other with no natural shard key); two-phase commit latency and failover complexity will bite the business back;
- the data volume fits comfortably on one machine — do indexes, parameters, and hardware optimization first, see [Choosing PostgreSQL](./when-to-choose-postgresql);
- you need many global point lookups with no shard key; each of those scans every shard.

## Relationship to Native Partitioning

Citus sharding is essentially "partitioning + putting it on other machines": a distributed table is logically a partitioned table, each shard is a physical partition, except that the partition can live on a remote node. So the two concepts stack — a common approach is to distribute by shard key hash first, then partition inside the shard by time range, so that cleanup and archival of time series data still follow the approach in [Table Inheritance and Partitioning](../database-design/table-inheritance-and-partitioning-design). Once you understand that, Citus's `citus_tables` and the rebalancer and other metadata operations map easily back to the partitioned table mental model.

## Status on Azure

Citus Data was acquired by Microsoft in 2019, and its managed service Azure Cosmos DB for PostgreSQL (formerly Hyperscale/Citus) has been announced by Microsoft as entering retirement (planned for March 2029, and no longer recommended for new projects); Citus itself continues to be open source and maintained, and self-hosted or third-party managed deployments are unaffected.

## References

- [wiki.postgresql.org/wiki/Foreign_data_wrappers](https://wiki.postgresql.org/wiki/Foreign_data_wrappers)
- [GitHub · pgvector/pgvector](https://github.com/pgvector/pgvector)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Table Inheritance and Partitioning](../database-design/table-inheritance-and-partitioning-design)
- [Streaming and Synchronous Replication](../internals/streaming-replication-and-sync)
- [FDW and Foreign Data](./fdw-and-foreign-data)
- [Choosing PostgreSQL](./when-to-choose-postgresql)
- [index](index.md)
- [when-to-choose-postgresql](when-to-choose-postgresql.md)
- [capacity-and-scaling-limits](/performance/capacity-and-scaling-limits.md)