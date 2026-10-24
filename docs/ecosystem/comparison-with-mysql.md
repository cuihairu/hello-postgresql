# PostgreSQL vs MySQL

PostgreSQL and MySQL are the two most common open source choices in relational databases, and most backend teams sooner or later have to answer "which one for this business". On the trunk — basic SQL, transactions, primary/replica replication — the differences are actually small; the real divide lies in the architecture model, the ceiling of SQL capability, and how strict the type system is. Below is an engineering-decision-oriented comparison, with no marketing-style conclusions. For the decision framework of which to pick, see [Choosing PostgreSQL](./when-to-choose-postgresql).

## Architecture and Connection Model

- **PostgreSQL: one process per connection**. Each connection corresponds to a backend process, with a fairly large memory footprint (`work_mem` and the like are allocated per operation); several thousand direct connections need to be taken seriously, and you usually pair PG with a connection pool such as PgBouncer. See [Connection Management](../operations/connection-management).
- **MySQL: one thread per connection**. Threads are lighter, direct connection capacity is higher, and thread pools come as a plugin.

The operational consequence: in the PG ecosystem, "the application must go through a connection pool" is the default consensus; in MySQL setups a connection pool is still beneficial but you can run without one, and carrying MySQL's connection habits straight over to PG is a common failure point.

**Storage engines**: MySQL is pluggable — InnoDB is the default, and different tables in the same database can mix MyISAM/Memory and other engines, with features varying by engine; PostgreSQL has a single engine, so every table behaves identically and there is no "wrong engine" problem, at the cost of no engine-level freedom of choice (its layer flexibility is carried by tablespaces, partitioning, FDW, and extensions).

## SQL Capability

| Capability | PostgreSQL | MySQL |
| --- | --- | --- |
| Window functions / CTE | supported since 8.4 / 9.1 | supported since 8.0 (2018) |
| JSON | JSONB binary type, GIN indexes, `@>` containment queries, path queries | JSON type, rich functions, multi-valued indexes since 8.0.17, no equivalent containment index |
| Arrays / ranges / composite types | native, can be GIN indexed | none |
| Materialized views | native (manual / scheduled refresh) | none (plain views are virtual) |
| Partial indexes | supported | not supported (functional indexes in 8.0) |
| `RETURNING` clause | supported | not supported; getting the auto-increment ID requires another query |
| upsert | `INSERT ... ON CONFLICT` | `INSERT ... ON DUPLICATE KEY UPDATE` |
| Full-text search | tsvector/tsquery plus a tokenizing dictionary, rankable by relevance | FULLTEXT index; CJK needs the ngram plugin |

The overall pattern: after MySQL 8.0, the "trunk SQL capability" is caught up (CTE, windows, recursive queries), while PostgreSQL's advantage concentrates in the combination of "composite types + index capability" — arrays, JSONB, and range types can all be indexed and consumed directly by query operators, so a lot of application-layer data shaping can sink into SQL.

## Replication and High Availability

- **MySQL**: binlog replication (statement/row/mixed formats), asynchronous by default, semi-sync as an option, GTID to locate transactions; mature HA options include Orchestrator, InnoDB Cluster (group replication), and similar.
- **PostgreSQL**: physical streaming replication is WAL-based and replicates the whole instance; `synchronous_commit` provides a continuous spectrum of synchronous semantics from async to `remote_apply`. See [Streaming Replication and Synchronous Commit](../internals/streaming-replication-and-sync); logical replication (PG 10+) replicates table-level changes on a publish/subscribe basis, and can cross versions and converge on a target. Neither has built-in multi-master, and bidirectional logical replication only gets its infrastructure in PG 17.

The practical semantic difference: PG's `remote_apply` guarantees the replica reads the same up-to-date state as the primary (read-your-writes consistency); MySQL semi-sync only guarantees the binlog has reached the replica, not that it has been replayed. For a business that "reads in a new session right after writing", PG's configuration space is finer-grained.

## MVCC and Concurrency Behavior

- **MySQL (InnoDB)**: old versions are reconstructed from the undo log; the current row stays in place and a purge thread cleans up asynchronously. Long transactions stall purge, showing up as history list growth and undo bloat.
- **PostgreSQL**: old and new versions both stay in the heap and vacuum reclaims dead tuples; long transactions are just as dangerous — they block vacuum and cause table/index bloat. See [MVCC and Multi-Versioning](../internals/mvcc-and-multi-version) and [VACUUM and HOT](../internals/vacuum-and-hot).

The lesson is the same on both sides: **long transactions are to be eliminated**, only the symptoms differ. On locking, MySQL's default isolation level is REPEATABLE READ, using next-key locks (gap locks) to block phantom reads, and gap locks themselves are a common source of deadlocks; PG defaults to READ COMMITTED, reads via snapshots, and uses no gap locks. Phantoms can still occur under RR; when you truly need serializability, use SSI (serializable snapshot isolation). See [Transactions and Isolation Levels](../internals/transactions-and-isolation).

## Type System

PostgreSQL is strictly typed, MySQL is permissive with implicit conversions — the difference most easily underestimated in migration and audit work:

```sql
-- MySQL: an implicit conversion happens between a string and a number
SELECT * FROM users WHERE phone = 13800138000;   -- index not used, and '13800138000abc' may also match
-- PostgreSQL: errors out directly with operator does not exist, so the type mismatch surfaces during development
```

- MySQL has `UNSIGNED` types and allows `0000-00-00` dates (in non-strict mode); PG accepts neither, replaced with `CHECK (col >= 0)` and constraints.
- MySQL `TIMESTAMP` is limited to the 1970–2038 range and carries time-zone conversion behavior; PG `timestamptz` has no such limit. See [Data Types Overview](../basics/data-types-overview) for choosing types.
- A boolean in MySQL is `tinyint(1)`, in PG a real `boolean`; mind the ORM mapping.

## Migrating from MySQL: Syntax Differences Checklist

| MySQL style | PostgreSQL equivalent |
| --- | --- |
| `` `col` `` backticks | `"col"` double quotes; prefer lowercasing identifiers and not quoting at all |
| `LIMIT 5, 10` | `LIMIT 10 OFFSET 5` (`LIMIT n OFFSET m` works on both sides) |
| GROUP BY with non-aggregated columns (permissive mode) | not allowed; use `any_value()` (PG 16+), `max()`, or `DISTINCT ON` |
| `AUTO_INCREMENT` | `GENERATED ALWAYS AS IDENTITY` |
| `INSERT IGNORE` | `INSERT ... ON CONFLICT DO NOTHING` |
| `ON DUPLICATE KEY UPDATE` | `INSERT ... ON CONFLICT (col) DO UPDATE ...` |
| `REPLACE INTO` | `ON CONFLICT DO UPDATE` (REPLACE is delete-then-insert, different side effects) |
| `LAST_INSERT_ID()` | `INSERT ... RETURNING id` |
| `DATE_FORMAT(d, '%Y-%m')` | `to_char(d, 'YYYY-MM')` |
| `DATEDIFF(a, b)` / `TIMESTAMPDIFF` | `a::date - b::date` / `age()`, `extract(epoch from ...)` |
| `UNIX_TIMESTAMP()` / `FROM_UNIXTIME(n)` | `extract(epoch from now())` / `to_timestamp(n)` |
| `IFNULL(a, b)` | `coalesce(a, b)` (both sides support COALESCE) |
| `a || b` string concatenation | in PG `||` is concatenation; MySQL's `\|\|` defaults to logical OR, use `CONCAT` |
| `#` line comment | only `--` is supported |
| `UNSIGNED` / `ENGINE=InnoDB` / `CHARSET=utf8mb4` table options | remove; unsigned becomes a CHECK constraint, and encoding is set at the database level |

`LIMIT n, m` and date functions are the two highest-error categories in migration scripts; permissive GROUP BY mode is the classic "MySQL has been running sick all along, PG rejects it outright" case — before migrating, turn on `ONLY_FULL_GROUP_BY` in MySQL and let it soak for a while.

## Ecosystem and Managed Services

The mainstream managed offerings on both sides are mature: AWS RDS/Aurora, GCP Cloud SQL, and Alibaba Cloud RDS all provide both. The differences are in the long tail: PostgreSQL managed services usually come with an extension allowlist (pgvector, PostGIS, and similar are increasingly standard), while the advantage of MySQL hosting, for some domestic teams, is toolchain familiarity and existing operational assets. Team-side weight often outweighs the product side: existing DBA skills, monitoring and alerting templates, and rehearsed backup runbooks are all real costs — do not evaluate on the feature table alone.

## Running Both Side by Side

In a large organization, the two coexisting long-term is normal, and a more realistic constraint than "unify onto one" is:

- **One business picks exactly one primary database**, avoiding double-writing the same data into two databases;
- when cross-database queries are genuinely needed, use [FDW](./fdw-and-foreign-data) for read-only joined queries instead of syncing full data both ways;
- make the migration call on pain: when a MySQL team is repeatedly hand-handling JSON, arrays, and complex reports, PG's SQL capability pays off in developer efficiency; conversely, if the team has zero PG experience and the business is plain CRUD, the migration gains will not cover the learning and operations cost.

## References

- [wiki.postgresql.org/wiki/Foreign_data_wrappers](https://wiki.postgresql.org/wiki/Foreign_data_wrappers)
- [GitHub · pgvector/pgvector](https://github.com/pgvector/pgvector)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Choosing PostgreSQL](./when-to-choose-postgresql)
- [MVCC and Multi-Versioning](../internals/mvcc-and-multi-version)
- [Data Types Overview](../basics/data-types-overview)
- [FDW and Foreign Data](./fdw-and-foreign-data)
- [what-is-postgresql](/basics/what-is-postgresql.md)
- [index](index.md)
- [when-to-choose-postgresql](when-to-choose-postgresql.md)
- [knowledge](/knowledge.md)