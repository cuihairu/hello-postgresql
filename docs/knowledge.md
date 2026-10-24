# Dev Notes

This page is my personal PostgreSQL cheat sheet: concepts, reading list, official docs, use cases, and common pitfalls in one place. Links into the site go to the long-form notes; here I keep the conclusions I reach for and their sources.

## 1. Core Concepts

1. **Process model: one backend process per connection**: the postmaster listens on the port and forks a backend process for every client connection; parsing, planning, and execution all happen inside that process. Shared memory and signals are the glue between processes. This is the root reason PostgreSQL's connection cost is higher than MySQL's thread model, and why connection pooling is standard practice. [Process Architecture](./internals/process-architecture), [Connection Management](./operations/connection-management)
2. **MVCC: multi-version tuples + snapshot visibility**: every row carries xmin/xmax transaction ids, a transaction decides which version is visible to it by consulting a snapshot, and reads and writes never block each other. An UPDATE is "insert a new version + mark the old one stale", and a DELETE only sets a marker. [MVCC and Multi-Versioning](./internals/mvcc-and-multi-version), [Snapshots and Visibility](./internals/snapshot-and-visibility)
3. **The default isolation level is READ COMMITTED**: each statement takes a fresh snapshot, so non-repeatable reads and phantoms are permitted at this level. REPEATABLE READ uses a transaction-level snapshot for snapshot isolation, and SERIALIZABLE uses SSI predicate lock detection. The difference from MySQL's default REPEATABLE READ is a frequent exam trap. [Transactions and Isolation](./internals/transactions-and-isolation)
4. **WAL: write the log, then write the data**: changes are appended to the WAL in order and flushed at commit according to the `synchronous_commit` policy, while data pages may be written later. Crash recovery replays the WAL. Streaming replication ships exactly this stream of WAL bytes. [The WAL Mechanism](./internals/wal-mechanism), [Setting Up Streaming Replication](./operations/streaming-replication-setup)
5. **VACUUM is the bill for MVCC**: dead tuples do not disappear on their own. VACUUM reclaims space, freezes transaction ids, and updates the visibility map; a HOT update completes within the same page and skips index maintenance. If autovacuum cannot keep pace with writes, the table bloats. [VACUUM and HOT](./internals/vacuum-and-hot), [Tuning autovacuum](./internals/autovacuum-tuning)
6. **Pick an index by the shape of the data**: B-tree is the default and the general-purpose answer. GIN serves jsonb, arrays, and full-text inverted indexes. GiST serves ranges, spatial, and proximity. BRIN serves time-series append-only tables. SP-GiST and Hash cover the long tail. [B-tree Structure](./indexing/btree-structure), [The Index Selection Decision Tree](./indexing/index-selection-decision-tree)
7. **`EXPLAIN (ANALYZE, BUFFERS)` is the first stop for tuning**: when estimated rows diverge sharply from actual rows, check the statistics first, then the access method, the join method, and whether the sort spilled to disk. The planner's entire cost model rests on the statistics in pg_statistic. [Reading EXPLAIN](./performance/explain-basics), [The Planner Cost Model](./internals/optimizer-cost-model)
8. **Statistics drive plans; ANALYZE keeps them fresh**: autovacuum triggers the analyze by default, but run a manual `ANALYZE` after a bulk load into a large table. Extended statistics handle correlations between columns. [Statistics and ANALYZE](./performance/statistics-and-analyze)
9. **Replication splits into two tracks, physical and logical**: streaming replication ships WAL byte by byte, the standby is a hot standby that is a full replica, and synchronous commits are supported. Logical replication ships row changes via publications and subscriptions, can cross versions, and can subscribe to a subset of tables. [Streaming and Synchronous Replication](./internals/streaming-replication-and-sync), [Logical Replication Internals](./internals/logical-replication-internals)
10. **Backups and PITR: logical plus physical as belt and braces**: pg_dump produces a logical copy that is portable across versions. pg_basebackup plus WAL archiving underpins point-in-time recovery, to a given timestamp or LSN. [Backup Strategy](./operations/backup-strategy), [Physical Backups and PITR](./operations/physical-backup-and-pitr)
11. **A role is a user is a group**: a role with the LOGIN attribute is a login user, and nesting roles gives you groups. Privileges are granted in layers from database down to schema, table, and column, and default privileges set the initial grants on newly created objects. [Roles and the Permission Model](./security/roles-and-permissions), [The Object Grant Hierarchy](./security/object-grant-hierarchy)
12. **RLS pushes filter conditions down into the kernel**: a policy defines USING for reads and WITH CHECK for writes and is applied per role. The owner bypasses it by default; only `FORCE` binds the owner too. This is the kernel-level answer for multi-tenant isolation. [Row Level Security](./security/row-level-security)
13. **JSONB is a first-class type**: GIN indexes support containment queries, and the `@>`, `?` operators plus jsonpath expressions cover structured queries. But its foreign keys, statistics, and partial-field update story are weaker than a real relational column. [Working With jsonb](./advanced-sql/jsonb-operations), [jsonb Design Patterns](./advanced-sql/jsonb-design-patterns)
14. **Extensions are the ecosystem's core form**: `CREATE EXTENSION` is plug and play. pgvector does vector search, TimescaleDB does time series, PostGIS does spatial, Citus does distribution, and FDWs do cross-database federation. [Extension Management](./ecosystem/extension-management), [FDW and Foreign Data](./ecosystem/fdw-and-foreign-data)

## 2. Key Books

1. **PostgreSQL 14 Internals (Egor Rogov, Postgres Professional)**: free official PDF, with implementation-level coverage of MVCC, snapshots, the WAL, locks, and vacuum. This site's internals section is aligned to it.
2. **The Art of PostgreSQL (Dimitri Fontaine)**: SQL capability for application developers; the hands-on material on window functions, CTEs, and jsonb matches this site's advanced SQL section.
3. **PostgreSQL: Up and Running (Regina Obe & Leo Hsu)**: an overview of installation, configuration, and operations, matching this site's basics and architecture sections.
4. **Designing Data-Intensive Applications (DDIA)**: a systems view of storage, replication, and consistency that frames this site's chapters on replication, backups, and high availability.

All of these are catalogued at [Reference Books and Official Docs](./appendix/references-and-docs).

## 3. Official Docs

1. **PostgreSQL Documentation (current)**: the authoritative source quoted throughout the site. Syntax, parameters, and internal mechanisms defer to it: <https://www.postgresql.org/docs/current/>.
2. **Release Notes**: the only authoritative source for version changes. Use them to verify the scope of [What Is New in PostgreSQL 16](./ecosystem/postgresql-16-features) and [What Is New in PostgreSQL 17](./ecosystem/postgresql-17-features).
3. **PostgreSQL Wiki**: accumulated community experience on parameter tuning, vacuum, and performance diagnosis.
4. **The pg_stat view documentation**: the source behind the queries in [Observing with pg_stat](./internals/pg-stat-observation) and the troubleshooting toolbox.
5. **The EXPLAIN documentation and explain.depesz.com**: tools for reading plans, behind [EXPLAIN ANALYZE and BUFFERS](./performance/explain-analyze-buffers).

## 4. Use Cases

1. **Multi-tenant SaaS**: shared tables plus a tenant column plus RLS, or schema-per-tenant. The modeling tradeoffs are at [Modeling Multi-Tenancy](./database-design/multi-tenant-modeling).
2. **Vector search / AI applications**: pgvector stores embeddings, with HNSW or IVFFlat approximate search combined with filtering. [Vector Search With pgvector](./ecosystem/pgvector)
3. **Time series and monitoring data**: start with native partitioning, then move to TimescaleDB compression and continuous aggregates at scale. [The TimescaleDB Extension](./ecosystem/timescaledb), [Partition Pruning](./performance/partition-pruning)
4. **Location services**: PostGIS geometry and geography plus GiST spatial indexes. [The PostGIS Extension](./ecosystem/postgis)
5. **Heterogeneous federated queries**: postgres_fdw queries MySQL or another PostgreSQL database as a foreign table, while continuous synchronisation goes through logical replication. [FDW and Foreign Data](./ecosystem/fdw-and-foreign-data)
6. **High availability and disaster recovery**: Patroni plus etcd for automatic failover, streaming replication plus synchronous commits as the safety net for data. [High Availability Architectures](./operations/high-availability-architecture), [Disaster Recovery Drill Checklist](./operations/disaster-recovery-drills)

## 5. Common Pitfalls

1. **Long transactions are the root of most evil**: they pin vacuum's cleanup, raise the snapshot xmin horizon, and pile up the WAL. An idle replication slot blocks reclaim too. [VACUUM Stalls and Performance](./performance/vacuum-stall-and-performance)
2. **"It is still slow after I added an index" — check for a disable pattern first**: a function applied to the column, an implicit type cast, a leading-wildcard LIKE, and mixed OR conditions all kill the B-tree. [When Indexes Do Not Work](./indexing/index-failure-and-misuse)
3. **Raising max_connections is not a fix**: one process per connection, so memory and scheduling cost grow linearly. Put pgbouncer in front as a transaction pool. [Connection Management](./operations/connection-management)
4. **Deep OFFSET pagination is fake pagination**: a larger offset means more rows scanned. Keyset pagination (`WHERE id > $1`) is the real answer. [Pagination and Sorting](./advanced-sql/pagination-and-sorting)
5. **pg_hba matches the first rule**: a wrong order produces "nothing I change takes effect" or "every connection is refused". After a change, run `pg_reload_conf()` and verify with pg_hba_file_rules. [pg_hba and Authentication](./security/pg-hba-and-authentication)
6. **RLS does not apply to the owner by default**: you spend an afternoon wondering why the policy is not working, but you were connected as the owner. `FORCE ROW LEVEL SECURITY` is what binds the owner. [Row Level Security](./security/row-level-security)
7. **Moving from MySQL is not a syntax port**: permissive GROUP BY, quote semantics, case folding, implicit casts, and date formatting functions all differ. [PostgreSQL vs MySQL](./ecosystem/comparison-with-mysql)
8. **Skipping ANALYZE after a bulk load guarantees a bad plan**: the statistics are still empty or stale, so the planner is guessing blind. Run `ANALYZE` right after the load. [Statistics and ANALYZE](./performance/statistics-and-analyze)

## Sources

- [S1] PostgreSQL Documentation — <https://www.postgresql.org/docs/current/>
- [S2] PostgreSQL Release Notes — <https://www.postgresql.org/docs/release/>
- [S3] PostgreSQL Wiki — <https://wiki.postgresql.org/>
- [S4] PostgreSQL 14 Internals, free official PDF — <https://postgrespro.com/community/books/internals>
- [S5] use-the-index-luke.com — <https://use-the-index-luke.com/>
- [S6] explain.depesz.com — <https://explain.depesz.com/>

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Appendix](/appendix/index.md)
- [Basics & Core SQL](/basics/index.md)
