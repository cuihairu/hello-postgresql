# Glossary

A quick-reference term sheet in Chinese and English, grouped by topic. Each term gets a one-line definition; a few core concepts get an expanded note right after. Look here first when you hit an unfamiliar word, then move on to the corresponding chapter when you need the underlying details. Appendix navigation is at [Appendix Overview](/appendix/). (2026-10-14 batch: each of the four glossary sections gained one clickable citation row, all pointing at PostgreSQL official documentation pages; every link was verified reachable before being written in.)

## MVCC, WAL, VACUUM, Transactions and Locks

> Source: PostgreSQL official docs: [Concurrency Control (MVCC)](https://www.postgresql.org/docs/current/mvcc.html) · [Transaction Isolation Levels](https://www.postgresql.org/docs/current/transaction-iso.html) · [Routine Vacuuming (VACUUM)](https://www.postgresql.org/docs/current/routine-vacuuming.html) · [Write-Ahead Logging (WAL)](https://www.postgresql.org/docs/current/wal.html) · [Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)


| Term | English | One-line explanation |
| --- | --- | --- |
| Multi-Version Concurrency Control | MVCC (Multi-Version Concurrency Control) | Keeps multiple historical versions of each row so reads and writes never block each other. |
| Snapshot | Snapshot | The basis for a transaction's decision of "which row versions are visible to me", taken at statement or transaction start. |
| Transaction ID | XID (Transaction ID) | The number a writing transaction receives, stored in the row header and used for multi-version visibility comparisons. |
| xmin / xmax | xmin / xmax | Two fields in a row version header: the XID that created the version, and the XID that deleted or updated it. |
| Dead Tuple | Dead Tuple | A row version invisible to all transactions after being updated or deleted, waiting for VACUUM to reclaim it. |
| Write-Ahead Log | WAL (Write-Ahead Log) | Writes changes sequentially to a log before writing data pages; underpins crash recovery and replication. |
| Log Sequence Number | LSN (Log Sequence Number) | A byte position within the WAL stream; recovery and replication progress are both tracked against it. |
| Checkpoint | Checkpoint | Periodically flushes dirty pages back to data files and records a recovery starting point, shortening replay time after a crash. |
| Full Page Write | Full Page Write | On the first modification of a page after a checkpoint, the whole page is written into WAL to guard against torn pages. |
| Vacuuming | VACUUM | A maintenance operation that reclaims dead tuple space and keeps the visibility map current. |
| Autovacuum | Autovacuum | A background process group that triggers VACUUM and ANALYZE automatically when a table's dead tuple threshold is reached. |
| Table Bloat | Table Bloat | Dead tuples and old versions accumulating until the table and indexes are much larger than the actual data. |
| Freeze | Freeze | Replaces a row's XID with a special value so it no longer participates in old/new comparisons. |
| XID Wraparound | XID Wraparound | The risk that new/old comparisons break once XIDs run out, avoided by freezing in time to prevent data loss. |
| HOT Update | HOT (Heap-Only Tuple) Update | An optimized path taken when the updated columns involve no index and both versions live on the same page, so the index needs no update. |
| Isolation Level | Isolation Level | How much concurrent transactions can see of each other: read committed, repeatable read, serializable. |
| Deadlock | Deadlock | Multiple transactions waiting on each other's locks; once detected, one of them is forcibly rolled back. |

### MVCC

Writes do not overwrite the old row in place; they write a new version and mark the old row as expired. Reads pick the version visible to them according to a snapshot, so reads are not blocked by writes and writes are not blocked by reads. The cost is that dead tuples keep being produced and must be reclaimed by VACUUM. This is also the main difference in implementation philosophy between PostgreSQL and MySQL InnoDB (the undo log approach).

### WAL

Before a transaction commits, its changes must first land in WAL and be flushed according to your settings; data pages can be written a little later. Crash recovery replays WAL from the last checkpoint to restore a consistent state. Replication to a standby is essentially sending that same WAL stream to another machine to replay.

### VACUUM and Table Bloat

UPDATE and DELETE do not release space immediately; they leave behind dead tuples. VACUUM marks that space as reusable (it is generally not returned to the operating system), and ANALYZE updates statistics along the way. When autovacuum falls far behind you will see table bloat and slower queries; see the on-site vacuuming chapter for details.

## Indexes and Query Execution

> Source: PostgreSQL official docs: [Index Overview](https://www.postgresql.org/docs/current/indexes.html) · [Index Types](https://www.postgresql.org/docs/current/indexes-types.html) · [Operator Classes and Operator Families](https://www.postgresql.org/docs/current/indexes-opclass.html) · [Reading the Execution Plan (EXPLAIN)](https://www.postgresql.org/docs/current/using-explain.html)


| Term | English | One-line explanation |
| --- | --- | --- |
| B-tree Index | B-tree | The default index type; supports equality and range conditions on a multi-way balanced tree structure. |
| GIN Index | GIN (Generalized Inverted Index) | An inverted index suited to "contains" queries over arrays, jsonb, and full-text search. |
| GiST Index | GiST (Generalized Search Tree) | A general search tree framework, commonly used for geography, range types, and nearest-neighbor sorting. |
| BRIN Index | BRIN (Block Range Index) | Records extreme values per block range; tiny in size and suited to large tables whose physical order matches their logical order. |
| Covering Index | Covering Index | The index holds every column the query needs, so no trip back to the table for data. |
| Partial Index | Partial Index | An index built only over rows satisfying a WHERE condition, reducing size and maintenance cost. |
| Expression Index | Expression Index | An index on the result of a function or expression, such as `lower(email)`. |
| Query Plan | Query Plan | The combination of operators and access paths the optimizer chooses for a SQL statement; inspect it with EXPLAIN. |
| Sequential Scan | Sequential Scan (Seq Scan) | Reads the whole table from start to finish; frequent appearance on large tables usually means a missing index or stale statistics. |
| Index Scan | Index Scan | Locates the row via the index, then goes back to the table for the remaining columns. |
| Index Only Scan | Index Only Scan | When every needed column is in the index and page visibility is confirmed, the scan never goes back to the table. |
| Bitmap Scan | Bitmap Scan | Generates a bitmap from the index first, then fetches from the table in physical order; sits between a sequential and an index scan. |
| Selectivity | Selectivity | The share of rows remaining after a condition filters, which decides whether the optimizer uses an index. |
| Statistics | Statistics | The sampled outline of data distribution gathered by ANALYZE; the input to cost estimation. |
| Join Method | Join Method | Three physical implementations: Nested Loop, Hash Join, and Merge Join. |

### Index Only Scan

PostgreSQL indexes do not store row version information, so an index only scan must also confirm that the row is visible to the current snapshot. That check relies on the visibility map: the scan can skip the table lookup only when the page is marked "all visible". So the payoff of an index only scan depends heavily on whether VACUUM has kept up.

## Replication and High Availability

> Source: PostgreSQL official docs: [Streaming and Synchronous Replication (warm-standby)](https://www.postgresql.org/docs/current/warm-standby.html) · [WAL Archiving and Continuous Archiving](https://www.postgresql.org/docs/current/continuous-archiving.html) · [Logical Decoding and Logical Replication](https://www.postgresql.org/docs/current/logicaldecoding.html) · [Monitoring Statistics](https://www.postgresql.org/docs/current/monitoring-stats.html)


| Term | English | One-line explanation |
| --- | --- | --- |
| Streaming Replication | Streaming Replication | Physical replication in which the primary sends WAL to the standby in real time to be replayed. |
| Primary / Standby | Primary / Standby | The instance that handles writes, and the replica that stays in sync by continuously replaying WAL. |
| Hot Standby | Hot Standby | A standby that accepts read-only queries while it replays WAL. |
| Synchronous Replication | Synchronous Replication | Waits for the standby to acknowledge receipt of the WAL before returning a successful commit to the client. |
| Asynchronous Replication | Asynchronous Replication | The primary commits without waiting for the standby; a failover may lose the most recent small number of transactions. |
| Replication Slot | Replication Slot | An anchor that prevents the primary from discarding WAL still needed while the standby falls behind. |
| WAL Archiving | WAL Archiving | Saves filled WAL segments to archive storage for point-in-time recovery. |
| Replication Lag | Replication Lag | How far the standby trails the primary, measured in WAL bytes or replay time difference. |
| Failover | Failover | The process of promoting a standby to a new primary after the primary fails. |
| Promote | Promote | The action of a standby stopping replay and becoming a writable primary. |
| RPO / RTO | Recovery Point / Time Objective | The maximum amount of data loss you can tolerate, and the longest service interruption you can tolerate. |

## Objects and Privileges

> Source: PostgreSQL official docs: [Instances, Databases, and Schemas](https://www.postgresql.org/docs/current/ddl-schemas.html) · [Roles](https://www.postgresql.org/docs/current/database-roles.html) · [Privilege Management (GRANT/REVOKE)](https://www.postgresql.org/docs/current/ddl-priv.html) · [Row-Level Security (RLS)](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)


| Term | English | One-line explanation |
| --- | --- | --- |
| Instance | Instance / Cluster | A PostgreSQL service process together with its shared memory, managing multiple databases; note this is not a distributed cluster. |
| Database | Database | An independent namespace inside an instance; connections are made per database, and there is no direct cross-database querying. |
| Schema | Schema | A namespace within a database holding tables, views, functions, and other objects; the default search path is `"$user", public`. |
| Tablespace | Tablespace | Specifies the on-filesystem directory where data files for database objects are stored. |
| Sequence | Sequence | An object that generates monotonically increasing values; both serial and identity columns rely on it underneath. |
| Extension | Extension | A packaged add-on feature module, such as pg_stat_statements or PostGIS. |
| Role | Role | PostgreSQL's unified privilege holder; a role with the LOGIN attribute is what is usually called a user. |
| Privilege | Privilege | Permission to perform an operation on an object (SELECT, INSERT, and so on), managed by GRANT/REVOKE. |
| Ownership | Ownership | The role that created an object is its owner, and inherently holds all privileges on it and may grant them on. |
| Access Control | pg_hba.conf | A configuration file that decides whether a connection may be established based on "source host + user + database + authentication method". |

### The Hierarchy of Instance, Database, and Schema

A PostgreSQL service on a machine is an instance (the official docs also call it a cluster). You create multiple databases inside an instance, and they are isolated from one another. Each database is in turn divided into multiple schemas, and only under a schema do you find objects such as tables, views, and functions. The everyday phrasing "connect to a database, find a table" corresponds to the full path: instance → database → schema → object.

<!-- BACKLINKS-AUTO -->
## Related Pages

- [MVCC and Multi-Version Implementation](../internals/mvcc-and-multi-version)
- [WAL Mechanism](../internals/wal-mechanism)
- [VACUUM and HOT Updates](../internals/vacuum-and-hot)
- [Lock System](../internals/lock-system)
- [What Is PostgreSQL](../basics/what-is-postgresql)
- [index](index.md)
- [references-and-docs](references-and-docs.md)
- [sql-command-reference](sql-command-reference.md)
