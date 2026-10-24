# Everyday psql

psql is PostgreSQL's official built-in command-line client, available after you install the server or install `postgresql-client` on its own. Beyond writing SQL, it provides a set of **meta-commands** starting with a backslash for inspecting metadata, switching databases, and controlling output format. The objects, indexes, and execution plans backend developers deal with daily are all checked with it on the fly. This article covers only the high-frequency uses; for full reference, see the official [psql manual](https://www.postgresql.org/docs/current/app-psql.html) and the in-site [psql Meta-Command Reference](/appendix/psql-meta-command-reference).

## Connecting

psql needs to know four things: host, port, user, and database. They are supplied in descending priority: command-line arguments > environment variables > defaults.

```bash
# 1) Short flags: -h host  -p port  -U user  -d database
psql -h localhost -p 5432 -U postgres -d postgres
psql -h 10.0.0.8 -p 5432 -U app -d appdb

# 2) Connection string (URI or key=value, both work)
psql "postgresql://app:secret@10.0.0.8:5432/appdb"
psql "host=10.0.0.8 port=5432 dbname=appdb user=app password=secret"

# 3) Environment variables (suitable for scripts and session-level defaults)
export PGHOST=localhost PGPORT=5432 PGUSER=postgres PGDATABASE=postgres
psql      # Connect directly, equivalent to the four variables above combined
```

Without `-h`, local connections default to a Unix socket, and the authentication method is decided by the `local` line in `pg_hba.conf` (peer on Debian/Ubuntu, which requires the system user and database user to match, which is why you often write `sudo -u postgres psql`). Once connected the prompt looks like `postgres=#`, where `#` indicates a superuser.

## Core Meta-Commands

```sql
\l                 -- List all databases (size, owner, encoding)
\c appdb           -- Switch to another database
\dt                -- List tables in the current schema
\d users           -- Inspect table structure: columns, types, constraints, indexes, foreign keys
\d+ users          -- More detail: storage, compression, comments, etc.
\dn                -- List schemas
\di                -- List indexes
\di users_pkey     -- Inspect a specific index definition
\timing            -- Toggle SQL execution time display
\x                 -- Toggle expanded display (rows go vertical; essential for wide tables)
\q                 -- Quit psql
```

`\d` can be followed by different letters to inspect different objects: `\dt` tables, `\dv` views, `\ds` sequences, `\df` functions, `\du` users/roles, `\dx` extensions. `\d+` and `\l+` append storage details and comments.

A typical session:

```text
appdb=> \timing
Timing is on.
appdb=> \x
Expanded display is on.
appdb=> SELECT * FROM users LIMIT 1;
-[ RECORD 1 ]+---------------------------
id           | 1
name         | Zhang San
email        | zhangsan@example.com
created_at   | 2026-10-12 08:00:00+08
```

## Help: \? and \h

- `\?` lists help for **all meta-commands**; flip to it when you forget the `\copy` arguments;
- `\h` lists the syntax of **SQL commands**; `\h INSERT` and `\h CREATE TABLE` give you the corresponding syntax skeleton, faster than flipping through the docs.

Both are pure client-side help and work without connecting to a server.

## Output Format: \pset

`\pset` controls how query results are rendered. A few common groups:

```sql
\pset null '(null)'     -- Render NULL as (null) to avoid confusion with empty strings
\pset format aligned    -- Default aligned format; also unaligned / csv / html
\pset border 2          -- Border style
\pset pager off         -- Turn off the pager (saves trouble for small result sets)
\pset tuples_only on    -- Output only data rows, no header and no row count
```

`\pset` only affects the current session; to make it persistent, write it into `~/.psqlrc` (next section). `psql -c "..."` combined with `\pset format csv` or `\copy` is also a common recipe for exporting data.

## History and ~/.psqlrc

psql uses GNU readline to save command history: use the Up and Down arrow keys to walk history and `Ctrl-R` for reverse search. The history file defaults to `~/.psql_history`; use the `PSQL_HISTORY` environment variable to change its location.

`~/.psqlrc` runs at every psql startup, making it a good place for personalized settings:

```text
-- ~/.psqlrc: takes effect at every startup
\set PROMPT1 '%n@%/%R%# '
\pset null '(null)'
\pset pager off
\timing on
\set ON_ERROR_STOP on
```

- `\set ON_ERROR_STOP on` makes a script stop at the first erroring statement, avoiding a half-applied migration;
- `\set PROMPT1` customizes the prompt: `%n` user, `%` database, `%#` shows `#` for a superuser;
- On Windows the corresponding file is `%APPDATA%\postgresql\psqlrc.conf`.

Note that the contents of `~/.psqlrc` must be valid psql input (SQL or meta-commands); a mistake will produce an error line at every startup.

## Import and Export: \copy

`\copy` is a psql client-side command: data flows through the psql process to read and write local files, so it **does not require server-side file permissions** and is more commonly used than the server-side `COPY` command for day-to-day import and export:

```sql
\copy users TO '/tmp/users.csv' WITH (FORMAT csv, HEADER true)
\copy users FROM '/tmp/users.csv' WITH (FORMAT csv, HEADER true)
```

The server-side `COPY ... TO '/path'` requires the postgres system user to have write permission on the target path, and is restricted to `superuser` by default; `\copy` reads and writes files as the current system user, with a friendlier permission model. For a performance comparison of bulk loading, see [psql Advanced](/tools/psql-advanced).

## Caveats and Common Pitfalls

- **Meta-commands cannot span lines**: `\d users` must be written on one line; SQL statements end with a semicolon, meta-commands end with a newline.
- **`\dt` only looks at schemas in search_path by default**: when you cannot see tables in other schemas, `SET search_path` first or use `\dt schema.*`.
- **`\timing` measures client round-trip time**: it includes network and rendering overhead; for performance analysis use `EXPLAIN ANALYZE` (see [Reading EXPLAIN](/performance/explain-basics)).
- **`\x` only affects display**: it does not change the data itself, so when copying and pasting results, do not mistake the vertical format for the table structure.

## References

- [PostgreSQL Official Docs · Part I. Tutorial](https://www.postgresql.org/docs/current/tutorial.html)
- [PostgreSQL Official Docs · The SQL Language](https://www.postgresql.org/docs/current/sql.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Installation and First Connection](/basics/install-and-quickstart)
- [Databases and Schema Objects](/basics/database-and-schema-objects)
- [psql Advanced](/tools/psql-advanced)
- [psql Meta-Command Reference](/appendix/psql-meta-command-reference)
- [psql Meta-Command Reference](/appendix/psql-meta-command-reference)
- [Databases and Schema Objects](/basics/database-and-schema-objects)
- [Basics & Core SQL](/basics/index)
- [Installation and First Connection](/basics/install-and-quickstart)
- [System Catalogs and Metadata](/basics/system-catalogs-and-metadata)
- [Transaction Basics](/basics/transaction-basics)
- [What Is PostgreSQL](/basics/what-is-postgresql)
- [Local Dev Environment](/tools/local-dev-environment)
- [psql Advanced](/tools/psql-advanced)
