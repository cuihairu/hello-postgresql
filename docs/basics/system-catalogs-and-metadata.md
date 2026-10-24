# System Catalogs and Metadata

PostgreSQL stores metadata such as "which tables, columns, and indexes exist" as ordinary data in the system catalogs. They are plain tables at heart: you can `SELECT`, `JOIN`, and `WHERE` them directly, and even build views on top of them. The catalogs come up all the time when troubleshooting, generating code, and writing ops scripts — psql metacommands like `\d` and `\dt` are just wrapped catalog queries under the hood. Below are three commonly used quick-lookup views, then the OID worldview of `pg_class` / `pg_attribute` / `pg_namespace`, followed by `information_schema`, table-size statistics, and `COMMENT ON`.

## Quick-lookup views: pg_tables / pg_indexes / pg_sequences

These three views wrap `pg_class` in a human-friendly way with straightforward column names, and are the most used entry points day to day:

```sql
-- plain tables in the current database (visible in search_path) and row-count estimates
SELECT schemaname, tablename, tableowner, hasindexes
FROM   pg_tables
WHERE  schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER  BY schemaname, tablename;

-- index listing for each table
SELECT schemaname, tablename, indexname, indexdef
FROM   pg_indexes
WHERE  schemaname = 'public'
ORDER  BY tablename, indexname;

-- a sequence's current value, increment, and bounds
SELECT sequencename, data_type, increment_by, min_value, max_value, last_value
FROM   pg_sequences
WHERE  schemaname = 'public';
```

The `last_value` in `pg_sequences` is the **highest value handed out so far**, and `next_value` is the one that will be assigned next. In troubleshooting it is often used to check whether "the sequence has fallen behind existing data" or "is close to the integer limit".

## pg_class / pg_attribute / pg_namespace: the OID worldview

Every object inside PostgreSQL has a unique identifier, the `OID` (Object Identifier), and the system catalogs reference each other by OID rather than by name. This is the key to understanding catalog queries:

- `pg_class`: all "relation" objects — tables, indexes, views, materialized views, sequences, and TOAST tables live in this single table, distinguished by `relkind` (`r` plain table, `i` index, `v` view, `m` materialized view, `S` sequence, `p` partitioned table, `t` TOAST).
- `pg_attribute`: column definitions. **System columns are in there too**, so a column listing must filter `attnum > 0 AND NOT attisdropped`.
- `pg_namespace`: schema (namespace). Tables and functions both hang off some namespace.
- `pg_type`, `pg_proc`, `pg_constraint`, `pg_index`, `pg_description` and the rest are likewise catalogs linked by OID.

The standard query pattern tying the three together:

```sql
SELECT n.nspname        AS schema,
       c.relname        AS table_name,
       a.attname        AS column_name,
       format_type(a.atttypid, a.atttypmod) AS data_type,
       a.attnotnull     AS not_null
FROM   pg_class      c
JOIN   pg_namespace  n ON n.oid = c.relnamespace
JOIN   pg_attribute  a ON a.attrelid = c.oid
WHERE  c.relkind = 'r'                 -- plain tables
  AND  n.nspname = 'public'
  AND  a.attnum > 0                    -- exclude system columns
  AND  NOT a.attisdropped              -- exclude dropped columns
ORDER  BY c.relname, a.attnum;
```

`format_type()` translates an internal type OID into a readable string (including length modifiers such as `varchar(50)`). Once you know this OID linkage, queries over `pg_constraint` and `pg_index` follow the same pattern. The full catalog listing is in the [pg_catalog documentation](https://www.postgresql.org/docs/current/catalogs.html).

## information_schema: a cross-database standard, but slow and thin

`information_schema` is the set of metadata views defined by the SQL standard, with the same names and structure in MySQL, SQL Server and other databases, which makes it good for writing portable cross-database code:

```sql
SELECT table_schema, table_name, table_type
FROM   information_schema.tables
WHERE  table_schema = 'public'
ORDER  BY table_name;

SELECT column_name, data_type, is_nullable, column_default
FROM   information_schema.columns
WHERE  table_schema = 'public' AND table_name = 'users'
ORDER  BY ordinal_position;
```

Its limitations are equally clear:

- **Thin on information**: PostgreSQL-specific concepts (partitioning, TOAST, `relkind`, parallelism and statistics) have no corresponding field in the standard, so when you cannot find it you fall back to `pg_catalog`.
- **Slow**: the views stack multiple layers of privilege filtering and type expansion, and on a large database they are an order of magnitude slower than querying `pg_catalog` directly.
- **Privilege filtering**: only objects visible to the current user are shown, so a DBA troubleshooting should generally go straight to `pg_catalog`.

## \d+ versus catalog queries

psql metacommands are "sugar" over catalog queries, and the two give equivalent results. Starting psql with `psql -E` makes it print the SQL it actually issues, which helps you learn catalog queries:

```plaintext
\d+ users                          -- table structure + comments + storage + compression
\dt+ public.*                      -- list tables with sizes
\di+ users_*                       -- list indexes with sizes
\dn+                               -- list schemas
\df+ deduct                        -- function definition (including the body)
\l+                                -- database list with sizes
\dT+ text                          -- types and operators
```

An example of the correspondence: `\d+ users` is underneath one multi-table JOIN over `pg_class` + `pg_attribute` + `pg_type` + `pg_constraint`, while `\dt+` is `pg_class relkind='r'` plus `pg_total_relation_size()`. Keep this mapping in mind and you know which catalog to query when `\d` is not enough.

## Checking table size: pg_total_relation_size

A table's on-disk footprint has three layers, and the functions come in three granularities:

```sql
-- needs the table definition
CREATE TABLE demo (id int PRIMARY KEY, payload text);
INSERT INTO demo SELECT g, repeat('x', 100) FROM generate_series(1, 10000) g;

SELECT pg_total_relation_size('demo')          AS total_bytes,   -- table + indexes + TOAST
       pg_relation_size('demo')                AS heap_bytes,    -- main table (heap) only
       pg_indexes_size('demo')                 AS index_bytes,   -- all indexes
       pg_size_pretty(pg_total_relation_size('demo')) AS pretty;  -- human-readable
```

- `pg_total_relation_size()`: main table + all indexes + TOAST, the most common one for troubleshooting.
- `pg_relation_size()`: heap data only, used to analyze the ratio of "the table itself versus its indexes".
- `pg_size_pretty()`: turns bytes into `MB/GB`, usually wrapped around the outermost layer for display.

To rank every table in the database by size:

```sql
SELECT n.nspname                AS schema,
       c.relname                AS table_name,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
       c.reltuples::bigint      AS est_rows          -- estimated row count from statistics
FROM   pg_class c
JOIN   pg_namespace n ON n.oid = c.relnamespace
WHERE  c.relkind = 'r' AND n.nspname = 'public'
ORDER  BY pg_total_relation_size(c.oid) DESC
LIMIT  20;
```

Note that `reltuples` is an estimate taken at `ANALYZE` time, not an exact row count; use `count(*)` for the exact value, though it is expensive on large tables, see [Observing pg_stat](../internals/pg-stat-observation).

## Column comments: COMMENT ON

PostgreSQL has no separate "table comment" syntax (unlike MySQL's `COMMENT '...'` written inside the DDL); instead it uses a standalone `COMMENT ON` statement, the comment is stored in the `pg_description` catalog, and `\d+` displays it:

```sql
COMMENT ON TABLE  demo                 IS 'Demo table: bulk insert and catalog-query example';
COMMENT ON COLUMN demo.payload         IS 'Simulated large field, for observing TOAST behavior';
COMMENT ON COLUMN demo.id              IS 'Primary key, business-irrelevant auto increment';
COMMENT ON INDEX  demo_pkey            IS 'Primary key index';

SELECT c.relname, d.description
FROM   pg_description d
JOIN   pg_class c ON c.oid = d.objoid
WHERE  c.relname = 'demo';
```

Coding standards usually require comments on all key business tables, maintained through migration scripts, so that `pg_dump` keeps comments by default (unless `--no-comments` is passed), and code generators can keep ORM field descriptions in sync automatically.

## Gotchas and common pitfalls

- System catalogs are plain tables, but **do not UPDATE/DELETE them directly**, and do not create indexes inside them — read-only is the rule. Change structure through DDL such as `ALTER`.
- `pg_class.relnatts` records the column count, but **excludes** columns removed by `ALTER TABLE DROP COLUMN`; to judge "how many columns actually exist", filter `pg_attribute.attisdropped`.
- `pg_stat_user_tables` is a statistics view whose counters restart from 0 after a restart; and `pg_class.reltuples` may be `-1` or stale when there has been no `ANALYZE`, so do not take it as fact when judging row counts.
- `pg_total_relation_size()` counts only the object itself and excludes the child partitions of a **partitioned table**. For a partitioned table's total size, `SUM` each partition's `pg_total_relation_size()`, or aggregate recursively through `pg_partition_tree()`.
- `information_schema.columns.data_type` shows only `USER-DEFINED` for user-defined types; fall back to `pg_attribute` + `pg_type` to get the real type name.

## References

- [PostgreSQL official documentation · Part I. Tutorial](https://www.postgresql.org/docs/current/tutorial.html)
- [PostgreSQL official documentation · The SQL Language](https://www.postgresql.org/docs/current/sql.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [psql Metacommand Reference](../appendix/psql-meta-command-reference)
- [Databases and Schema Objects](./database-and-schema-objects)
- [Common psql operations](./psql-getting-started)
- [The pg_stat Observation System](../internals/pg-stat-observation)
- [index](index.md)
- [naming-and-style-conventions](naming-and-style-conventions.md)
- [views-and-updatable-views](/database-design/views-and-updatable-views.md)
- [extension-management](/ecosystem/extension-management.md)
