# Batching and Writes

Looping single-row `INSERT` ten thousand times versus writing ten thousand rows in one go usually differs not by a constant but by orders of magnitude — because every statement carries fixed overhead for parsing, planning, transaction commit, and WAL flushing. This page covers the division of labor between server-side `COPY` and the client `\copy`, multi-value INSERT usage and its limits, batch upsert conflict semantics, where UNLOGGED tables fit, and how to batch large-table deletions.

## Sample Table

```sql
CREATE TABLE readings (
    meter_id   bigint      NOT NULL,
    read_at    timestamptz NOT NULL,
    value      numeric(12,3) NOT NULL,
    status     text        NOT NULL DEFAULT 'ok',
    PRIMARY KEY (meter_id, read_at)
);
```

## COPY: The Main Path for Server-Side Bulk Loading

`COPY` uses the streaming protocol, parses the whole payload once, and writes WAL in blocks, bypassing the per-statement parsing and planning overhead. That is exactly why it is an order of magnitude faster than row-by-row INSERT — INSERT must amortize a share of statement processing and (under default commit mode) a WAL wait onto every row, while COPY amortizes those fixed costs over the whole batch.

```sql
-- Server-side COPY: reads a file the database process has permission to access (requires a superuser or pg_read_server_files)
COPY readings FROM '/data/readings.csv' WITH (FORMAT csv, HEADER true);

-- Export to a server-side file
COPY (SELECT * FROM readings WHERE read_at >= '2026-01-01')
TO '/data/jan.csv' WITH (FORMAT csv, HEADER true);
```

`HEADER true` means the first line of the file is column names and is skipped rather than treated as data; together with the `DELIMITER`, `QUOTE`, and `NULL 'string'` options it can handle CSV dialects of all kinds. On error handling, COPY defaults to **failing the whole operation on one bad row** — it is a single statement, and there is no official switch for "skip the bad row and continue," so files with a lot of dirty data need to be cleaned first, or loaded into a staging table and validated afterward.

## \copy: The psql Client Variant

`\copy` is a psql meta-command; data passes through the client and the files read and written are on **the machine running psql**, with no database-server permissions needed:

```plaintext
\copy readings FROM '/local/readings.csv' WITH (FORMAT csv, HEADER true)
\copy (SELECT * FROM readings WHERE meter_id = 7) TO '/local/m7.csv' WITH (FORMAT csv, HEADER true)
```

Three practical differences: `\copy`'s pairing rule with statements is "the meta-command must be completed on a single line," so the query after `\copy ... to` cannot wrap onto a newline; when it fails, psql continues with subsequent statements by default, so scripts must check with `\if` or inspect the exit code; and permissions-wise it only needs read/write on the client file plus DML rights on the target table. Most import features in GUI clients (DBeaver, pgAdmin) also go down the COPY path underneath.

## Multi-Value INSERT: Several Rows at Once

When COPY is not convenient (data sitting in program memory, or going through an ORM), at least collapse row-by-row INSERTs into multi-value form:

```sql
INSERT INTO readings (meter_id, read_at, value) VALUES
    (1, '2026-01-05 00:00:00+08', 100.500),
    (1, '2026-01-05 01:00:00+08', 101.200),
    (2, '2026-01-05 00:00:00+08',  55.010);
```

A common practical upper limit: the total length of a single statement is bounded by the parameter limit (at the protocol level a single Bind message caps at 1GB, and in practice thousands to tens of thousands of rows per statement is the steady range). The better approach is `INSERT ... SELECT` generating rows from an `unnest` array or `generate_series`, avoiding the splicing of giant SQL text:

```sql
INSERT INTO readings (meter_id, read_at, value)
SELECT m, read_at, round((random()*500)::numeric, 3)
FROM generate_series(1, 3) AS m,
     generate_series('2026-01-05'::timestamptz, '2026-01-05 05:00:00+08', interval '1 hour') AS read_at;
```

## Batch Upsert and Conflict Semantics

`ON CONFLICT` is the most used tool in bulk writes, but you must distinguish the "target of conflict detection":

```sql
INSERT INTO readings (meter_id, read_at, value, status)
VALUES
    (1, '2026-01-05 00:00:00+08', 999.999, 'corrected'),
    (3, '2026-01-05 00:00:00+08',  12.500, 'ok')
ON CONFLICT (meter_id, read_at)              -- specify the unique constraint / index columns
DO UPDATE SET value = EXCLUDED.value,
              status = EXCLUDED.status;
```

- `ON CONFLICT (cols)` only applies to a unique index matching that column set; `ON CONFLICT DO NOTHING` skips **any** unique conflict when there is no target to write.
- Conflict behavior is decided **row by row**: with `DO UPDATE`, two rows in the same batch colliding on the same key also error out (`ON CONFLICT DO UPDATE command cannot affect row a second time`), so it cannot deduplicate itself; `DO NOTHING` has no such limit and silently skips duplicate rows.
- The whole statement is atomic: if any row meets a conflict that DO UPDATE cannot absorb (for example violating another constraint at the same time), **the entire statement rolls back** — not just that one row. If you rely on this semantic for idempotent imports, the import script must be able to retry the whole thing.

One more point that is often misunderstood: the `DO UPDATE` branch always executes one "attempted update" whether or not anything actually changes, so if the table has update triggers or you want "do not touch it when the value is unchanged," add a condition with `DO UPDATE SET ... WHERE readings.value IS DISTINCT FROM EXCLUDED.value`, or check whether PG 15+'s `MERGE` fits the semantics better. See [MERGE and Write Amplification Optimization](../performance/write-throughput-optimization).

## A Look at UNLOGGED Tables

Tables that write no WAL have write speeds close to memory speed, at the cost of data being cleared on crash and not participating in streaming replication:

```sql
CREATE UNLOGGED TABLE staging_readings (LIKE readings INCLUDING ALL);
```

The typical use is an "import staging table": COPY into an unlogged staging table first, validate, then move into the real table in batches with `INSERT INTO ... SELECT`. It is not a way of skipping the real table's WAL and only suits rebuildable temporary data. For the detailed trade-offs, see [Write Throughput Optimization](../performance/write-throughput-optimization).

## Batching Bulk Deletes

The problem with a single `DELETE FROM readings WHERE read_at < '2025-01-01'` over tens of millions of rows: long transactions, huge WAL volume, index bloat, and replication lag. Break it into small batches:

```sql
-- Approach one: a LIMIT subquery, driven by the primary key (the most general)
DELETE FROM readings
WHERE (meter_id, read_at) IN (
    SELECT meter_id, read_at
    FROM readings
    WHERE read_at < '2025-01-01'
    LIMIT 10000
);
-- In psql, loop with \watch 1, or loop in an application/script until it returns 0 rows

-- Approach two: batch by ctid (ctid is only stable within a single statement, so the subquery and DELETE must be in the same statement)
DELETE FROM readings
WHERE ctid IN (SELECT ctid FROM readings WHERE read_at < '2025-01-01' LIMIT 10000);
```

Leave a gap between batches so autovacuum gets a chance to clean up dead tuples and avoid continuous table and index bloat; for partitioned tables prefer `DROP PARTITION` to skip row-by-row deletion altogether. See [Table Inheritance and Partitioning Design](../database-design/table-inheritance-and-partitioning-design).

## Caveats and Common Traps

- The syntax differences between server-side `COPY ... FROM` and the client `\copy` are easy to mix up: the file path after `\copy` is always relative to the psql client process.
- In a batch upsert, `EXCLUDED` refers to "the new value this row tried to insert," so when comparing it against the old value in `DO UPDATE SET`, use `IS DISTINCT FROM` for correct NULL semantics.
- With tens of thousands of rows in a single multi-value INSERT, statement parsing time and lock hold time both grow, and the granularity of a failed retry gets coarser; slicing into chunks of a few thousand rows is steadier.
- If a bulk-delete loop uses `OFFSET` pagination, it gets slower the more it deletes (rescanning the same prefix); use the primary key or ctid to locate the start of the next batch.
- When COPYing into a table with triggers or generated columns, generated columns must not appear in the column list — it errors out immediately.

## References

- [PostgreSQL official documentation · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL official documentation · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [CRUD and ON CONFLICT](../basics/crud-and-on-conflict)
- [Write Throughput Optimization](../performance/write-throughput-optimization)
- [Table Inheritance and Partitioning Design](../database-design/table-inheritance-and-partitioning-design)
- [psql Advanced Usage](../tools/psql-advanced)
- [cte-and-non-recursive-with](cte-and-non-recursive-with.md)
- [index](index.md)
- [sql-functions-advanced](sql-functions-advanced.md)
- [crud-and-on-conflict](/basics/crud-and-on-conflict.md)
- [anti-patterns](/database-design/anti-patterns.md)
- [soft-delete-and-tombstone](/database-design/soft-delete-and-tombstone.md)
- [postgresql-17-features](/ecosystem/postgresql-17-features.md)
- [logical-replication-ops](/operations/logical-replication-ops.md)
- [connection-and-orm-optimization](/performance/connection-and-orm-optimization.md)
- [write-throughput-optimization](/performance/write-throughput-optimization.md)
- [client-drivers](/tools/client-drivers.md)
- [real-world-cases](/tools/real-world-cases.md)
Official documentation: [COPY](https://www.postgresql.org/docs/current/sql-copy.html), [The ON CONFLICT clause of INSERT](https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT), [CREATE UNLOGGED TABLE](https://www.postgresql.org/docs/current/sql-createtable.html#SQL-CREATETABLE-UNLOGGED).
