# psql Meta-Command Reference

In psql, commands that start with a backslash are meta-commands. They skip the SQL parser and act directly on the client, the connection, and the output. When you cannot remember one, `\?` lists every meta-command, and `\h command` shows the syntax help for a given SQL statement. Below they are grouped by purpose into five sections, one line each.

## Connecting and Switching

| Meta-command | Purpose |
| --- | --- |
| `\c[onnect] db [user]` | Switches database; can also switch user and connection string at the same time, e.g. `\c appdb app` |
| `\l[+]` | Lists all databases; `+` appends encoding, size, and tablespace |
| `\conninfo` | Shows the host, port, user, and database of the current connection |
| `\encoding [name]` | Shows or sets the client encoding |
| `\password [user]` | Interactively changes a role's password |
| `\q` | Exits psql |

## Inspecting Objects

| Meta-command | Purpose |
| --- | --- |
| `\d [name]` | With no argument, lists the relations in the current database (tables, views, materialized views, sequences); with an argument, shows that object's structure |
| `\d+ [name]` | Same as `\d` but adds details such as storage, compression, and comments |
| `\dt[S+] [pattern]` | Lists tables (`S` includes system tables) |
| `\di[S+] [pattern]` | Lists indexes; `\di idx_name` shows a specific index definition |
| `\dv[S+] [pattern]` | Lists views |
| `\ds[S+] [pattern]` | Lists sequences |
| `\df[S+] [pattern]` | Lists functions; `+` shows parameters and where they are defined |
| `\dn[S+] [pattern]` | Lists schemas |
| `\du[S+] [pattern]` | Lists roles and their attributes |
| `\dp [pattern]` / `\z` | Lists the access privileges (grant state) on objects |
| `\dx [pattern]` | Lists installed extensions |
| `\sf func_name` | Shows a function's full definition |

`\d` followed by different letters inspects different objects, and `pattern` supports filters such as `schema.*`:

```text
postgres=> \d+ users
                              Table "public.users"
   Column   |            Type             | Nullable | Default
------------+-----------------------------+----------+---------
 id         | bigint                         | not null| nextval(...)
 name       | text                        | not null|
Indexes:
    "users_pkey" PRIMARY KEY, btree (id)
```

## Output and Formatting

| Meta-command | Purpose |
| --- | --- |
| `\x [on\|off\|auto]` | Toggles expanded display: wide tables are rendered one attribute per line; affects display only, not the data |
| `\timing [on\|off]` | Turns on or off per-statement execution timing |
| `\pset option [value]` | Sets the output format, e.g. `\pset pager off`, `\pset null '(null)'` |
| `\o [file]` | Redirects the results of subsequent queries to a file or pipe |
| `\copy ... {from\|to} ...` | Client-side data import and export, with a friendlier permission model than server-side COPY |
| `\g [file\|command]` | Executes the current query buffer; results can be written to a file or pipe |

## Editing and History

| Meta-command | Purpose |
| --- | --- |
| `\e [file]` | Edits the query buffer (with no argument) or a given file in your `EDITOR` editor |
| `\watch [seconds]` | Repeats the current query buffer on an interval, once every 2 seconds by default; handy for watching `pg_stat_activity` |
| `\p` | Prints the current query buffer |
| `\r` | Clears (resets) the current query buffer |
| `\s [file]` | Shows or saves the command history |
| `\w file` | Writes the current query buffer to a file |

## Variables and Execution

| Meta-command | Purpose |
| --- | --- |
| `\set name [value]` | Sets a psql variable, referenced in SQL as `:name` or `:'name'` |
| `\unset name` | Unsets a variable |
| `\gset [prefix]` | Stores a single-row query result in a psql variable; a prefix can be specified |
| `\gexec` | Treats every row of the query result as a new SQL statement and sends it to the server for execution |
| `\echo text` | Prints text to psql; commonly used when debugging scripts |
| `\warn text` | Prints text to standard error, for warnings inside scripts |

`\gexec` fits repetitive operations such as batch index creation or privilege changes driven by a query result:

```text
postgres=> SELECT format('CREATE INDEX ON t (c%1$s)', i) FROM generate_series(1, 3) i \gexec
CREATE INDEX
CREATE INDEX
CREATE INDEX
```

How `\copy` and `COPY` divide the work: `COPY` reads and writes files on the server side (limited by `superuser` and directory permissions), while `\copy` reads and writes on the client side as the current system user:

```text
postgres=> \copy users TO '/tmp/users.csv' WITH (FORMAT csv, HEADER)
COPY 120
postgres=> \copy users FROM '/tmp/users_new.csv' WITH (FORMAT csv, HEADER)
COPY 5
```

## Quick Troubleshooting Combos

**Check the version and connection right after logging in** (confirm the version in a new environment first — much syntax and behavior varies by version):

```bash
psql -h localhost -p 5432 -U postgres -d appdb -c "SELECT version();" -c "SELECT current_user, current_database();"
```

**Find tables and table structure** (confirm where a table lives and whether its indexes are right):

```text
appdb=> \dt+ public.*
appdb=> \d+ users
appdb=> \di users*
```

**See who is running and who is holding resources** (first distinguish idle, idle in transaction, and active):

```sql
SELECT pid, state, wait_event_type, wait_event,
       now() - xact_start AS xact_age, left(query, 60) AS query
FROM pg_stat_activity
WHERE datname = current_database()
ORDER BY state, xact_start;
-- To intervene: SELECT pg_cancel_backend(pid);  cancels that query
-- If it still won't exit: SELECT pg_terminate_backend(pid);  disconnects that connection
```

## Further Reading

- [PostgreSQL official docs · psql](https://www.postgresql.org/docs/current/app-psql.html)
- [PostgreSQL official docs · SQL Commands](https://www.postgresql.org/docs/current/sql-commands.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Common psql Operations](../basics/psql-getting-started)
- [psql Advanced Usage](../tools/psql-advanced)
- [Common Errors and Troubleshooting Reference](./common-errors-and-troubleshooting)
- [Monitoring and Alerting](../operations/monitoring-and-alerting)
- [index](index.md)
- [references-and-docs](references-and-docs.md)
- [psql-getting-started](/basics/psql-getting-started.md)
- [system-catalogs-and-metadata](/basics/system-catalogs-and-metadata.md)
Official docs: [psql Manual](https://www.postgresql.org/docs/current/app-psql.html)
