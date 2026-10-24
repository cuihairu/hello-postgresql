# psql Advanced

The basics page covers the fundamental meta-commands `\d`, `\l`, and `\copy` (see [psql basics](../basics/psql-getting-started)). This page records the capabilities I use most often when automating with psql: variables, `\gexec`, and `\watch`. They all live in the psql client, so nothing needs to be installed on the server.

## Variables: \set and :var

psql keeps a client-side variable table. You can put `SELECT` results, connection parameters, and custom values in it, then substitute them back into SQL text as `:var`:

```sql
-- Definition and use (values are plain text, no quotes needed)
\set env 'prod'
\set page_size 50
SELECT * FROM orders ORDER BY id LIMIT :page_size;
\unset page_size          -- remove the variable

-- When substituting into a string or identifier, you must use the quoted form
-- :'var'  expands to a single-quoted string literal (auto-escapes inner quotes, safe)
-- :"var"  expands to a double-quoted identifier
SELECT * FROM :"schema_name".users WHERE note = :'env';
```

`:'var'` escapes quotes correctly, so storing external input (file names, filter terms) in a variable and then referencing it is safe. Writing `:var` directly is a literal substitution, suitable only for numbers and identifiers. Built-in variables such as `:USER`, `:DBName`, and `:PORT` are available automatically once the connection is established.

### \gset: Assign query results to variables

`\gset` writes a **single-row** query result into variables by column name. This is the key to building "parameterized scripts":

```sql
-- Get a pagination cursor: which id the next page starts at
SELECT max(id) AS last_id FROM orders WHERE created_at < now() - interval '1 day' \gset

\echo Next page start: :last_id
SELECT * FROM orders WHERE id > :last_id ORDER BY id LIMIT 50;

-- Computed values can go into variables too
SELECT count(*) AS total, pg_size_pretty(pg_total_relation_size('orders')) AS size \gset
```

If the query returns 0 rows the variable is not set; if it returns multiple rows only the first is taken. Combined with `\gset` and `:'var'`, a single psql script can do a "query a step, compute a step, then execute" flow without writing Python.

## \gexec: Run query results as SQL

`\gexec` sends **every row** of the current query result as a command to execute. This is the standard way to do bulk DDL in psql — first write out the list of statements to run as SQL, then hand them to psql to execute:

```sql
-- Example 1: revoke write privileges on all tables in the business schema
SELECT format('REVOKE INSERT, UPDATE, DELETE ON TABLE %I FROM app_write', tablename)
FROM pg_tables
WHERE schemaname = 'business' \gexec

-- Example 2: add indexes to all foreign key columns (classic troubleshooting step for missing FK indexes)
SELECT format('CREATE INDEX IF NOT EXISTS idx_%s_%s ON %I(%I)',
              relname, attname, relname, attname)
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
JOIN pg_class r ON r.oid = c.conrelid
JOIN pg_namespace n ON n.oid = r.relnamespace
WHERE c.contype = 'f' AND n.nspname = 'business'
  AND NOT EXISTS (SELECT 1 FROM pg_index i
                  WHERE i.indrelid = c.conrelid AND a.attnum = ANY(i.indkey::int2[]))
\gexec
```

The safe way is **two-stage**: first run the same generating query once (with a plain `\g` or just hit Enter), visually confirm every row is a statement you actually want to execute, then add `\gexec` and rerun. If `\gexec` hits an error it stops processing subsequent rows immediately; pair it with `\set ON_ERROR_STOP on` to make the whole script fail.

## \watch: Watch a query live

`\watch` makes psql periodically resend the current query buffer and refresh the results, which is great for monitoring a live situation — watching lock queues, replication lag, or the progress of a long-running query:

```sql
SELECT pid, state, wait_event_type, wait_event,
       now() - query_start AS runtime, left(query, 60) AS query
FROM pg_stat_activity
WHERE state <> 'idle' AND backend_type = 'client backend'
\watch i=2 c=30
```

Parameter forms: `i=` interval in seconds, `c=` number of iterations (PG 16+). PG 17 added `m=` (stop when the result has fewer rows than this value, suitable for "wait for some event then exit" scenarios). `Ctrl-C` aborts at any time. Variables like `:auto` are unaffected. If the `\watch` interval is shorter than the query's runtime, queries will queue up, so don't set the interval too low.

## \copy and Large Objects

The privilege model and usage of `\copy` (client-side export/import) are recorded in [psql basics](../basics/psql-getting-started). This adds a query-level export form — exporting an arbitrary result set rather than a whole table:

```sql
\copy (SELECT id, user_id, amount FROM orders WHERE created_at >= '2026-01-01')
      TO '/tmp/orders_2026.csv' WITH (FORMAT csv, HEADER true)
```

Binary large objects (LOBs) have their own family of meta-commands. Files like images and PDFs can be stored in `pg_largeobject` and moved between client and server:

```sql
\lo_import '/tmp/manual.pdf' 'Product Manual v2'  -- import; returns an oid, may carry a comment
\lo_list                                         -- list existing large objects
\lo_export 16420 '/tmp/manual.pdf'               -- export to local by oid
```

Large object writes must be committed in a transaction. For single files over 1 GB, consider bytea chunking or object storage first — don't use the database as a file server.

## Output control: \timing, \x, and \pset

Three switches cover all the everyday output scenarios:

```sql
\timing on                -- show client round-trip time for each statement
\x auto                   -- extended display: auto mode rotates wide tables vertically
\pset null '(null)'       -- display NULL as (null), distinct from empty string
\pset format csv          -- output CSV, easy to pipe into other programs
\pset pager off           -- disable the pager, essential in scripts
\pset linestyle unicode   -- use Unicode characters for table borders, more readable
```

When running one-off execution with `-c`, combining `\pset format csv` with `\g` produces pipe-friendly output directly: `psql -c '\pset format csv' -c 'SELECT ...'`. `\timing` measures total time including network round-trips; to analyze execution details you still need `EXPLAIN (ANALYZE)` (see [EXPLAIN basics](../performance/explain-basics)).

## The psqlrc startup file

Every time psql starts it executes `~/.psqlrc` (on Windows, `%APPDATA%\postgresql\psqlrc.conf`). Bake the switches above into it:

```text
-- ~/.psqlrc
\set ON_ERROR_STOP on
\pset null '(null)'
\pset pager off
\timing on
\set PROMPT1 '%n@%/> '
```

When running SQL from ops scripts or CI, skip it with the `-X` flag: `psql -X -f job.sql` — any output-affecting setting in psqlrc will pollute the script's output, a common source of accidents in automated setups. In reverse, put the aliases and prompts you need for interactive work in psqlrc. Just keep the two use cases distinct.

## References

- [PostgreSQL official docs · psql](https://www.postgresql.org/docs/current/app-psql.html)
- [PostgreSQL official docs · F.32. pg_stat_statements — track statistics of SQL planning and execution](https://www.postgresql.org/docs/current/pgstatstatements.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [psql basics](../basics/psql-getting-started)
- [troubleshooting toolbox](./troubleshooting-toolbox)
- [local development environment](./local-dev-environment)
- [EXPLAIN basics](../performance/explain-basics)
- [batch-and-write](/advanced-sql/batch-and-write.md)
- [psql-meta-command-reference](/appendix/psql-meta-command-reference.md)
- [psql-getting-started](/basics/psql-getting-started.md)
- [plan-cache-and-generic-plan](/internals/plan-cache-and-generic-plan.md)
- [dbeaver-and-vscode](dbeaver-and-vscode.md)
- [index](index.md)
- [local-dev-environment](local-dev-environment.md)
- [pgadmin-4](pgadmin-4.md)
- [troubleshooting-toolbox](troubleshooting-toolbox.md)
Official docs: [psql command reference](https://www.postgresql.org/docs/current/app-psql.html), [large objects](https://www.postgresql.org/docs/current/largeobjects.html).
