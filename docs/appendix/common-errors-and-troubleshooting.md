# Common Errors and Fixes

Error messages are given verbatim as PostgreSQL actually reports them (with the `ERROR: ` / `FATAL: ` prefix on the error string); the right-hand side gives the usual cause and remedy. The three highest-frequency errors below have a full troubleshooting path.

## Error Message Reference Table

| Error message (verbatim) | Common cause | Fix |
| --- | --- | --- |
| `ERROR:  duplicate key value violates unique constraint "users_pkey"` + `DETAIL:  Key (id)=(1) already exists.` | Duplicate submissions, sequence out of sync with max(id), concurrent writes without ON CONFLICT | Find the duplicate data; use `ON CONFLICT` for idempotent writes; sync the sequence with `setval` |
| `ERROR:  relation "users" does not exist` | Misspelled table name, schema not in search_path, connected to the wrong database, unquoted mixed case | `\dt`, `SET search_path TO app, public;`, verify the connection string |
| `ERROR:  permission denied for table users` | The current role lacks the relevant privilege on that table | Check the grants with `\dp users`, then add privileges with GRANT |
| `ERROR:  permission denied for schema public` | From PG 15 on, the public schema no longer allows ordinary users to CREATE by default | `GRANT CREATE ON SCHEMA public TO app;` or use a dedicated schema instead |
| `ERROR:  syntax error at or near "SELEC"` | A reserved word used as an identifier, dialect differences, typo | Locate the offending token by `LINE`; rename the keyword or quote it |
| `ERROR:  column "nosuchcol" of relation "users" does not exist` | Misspelled column name, the column was renamed, model and database structure out of sync | Compare against the real column names with `\d users` |
| `ERROR:  deadlock detected` + `DETAIL:  Process 313 waits for ShareLock on transaction 760; blocked by process 306.` | Two transactions locking multiple tables in opposite order | Use a consistent locking order, shrink transactions, and retry after catching the error |
| `ERROR:  canceling statement due to statement timeout` | `statement_timeout` elapsed, so a slow query was canceled | Optimize the SQL or the index; split long and short queries and set timeouts separately |
| `FATAL:  sorry, too many clients already` | Connection count has reached `max_connections` | Look for leaked connections, add a connection pool, and raise the limit if necessary |
| `ERROR:  out of shared memory` + `HINT:  You might need to increase max_locks_per_transaction.` | Object locks held by a single transaction (partitioned tables, large batch DDL) exceed the shared lock table | Split transactions to reduce the object count per transaction; raise `max_locks_per_transaction` (takes effect on restart) |
| `ERROR:  could not serialize access due to concurrent update` | Read/write conflict under repeatable read or serializable | Catch it at the application layer and retry the whole transaction |
| `ERROR:  operator does not exist: text + integer` | Operand types do not match and there is no implicit cast | Cast explicitly with `::`, or fix the column type |
| `ERROR:  invalid input syntax for type integer: "abc"` | String-to-number or string-to-timestamp conversion failed | Clean the data; validate with `NULLIF` or a regular expression before converting |
| `FATAL:  password authentication failed for user "postgres"` | Wrong or unset password, or pg_hba authentication method does not match | Reset with `ALTER ROLE ... PASSWORD`; check pg_hba.conf |
| `ERROR:  tuple concurrently updated` | Concurrent modification of the same system catalog row (the same function CREATE OR REPLACE'd at once, or concurrent DDL on the same object) | Stagger the operations or retry |
| `ERROR:  invalid byte sequence for encoding "UTF8": 0x80` | The byte stream sent by the client is not valid UTF-8 | Check the client encoding setting and the source data encoding |
| `psql: error: connection to server at "localhost", port 5432 failed: Connection refused` | Service not started, wrong port, blocked by the firewall | Verify with `pg_isready -h host -p port`; check the service status and the listening address |

## Troubleshooting 1: permission denied

First confirm "who am I, and who owns it":

```sql
SELECT current_user, session_user;          -- the currently effective role and the login role
SELECT current_database(), current_schema();
```

Then look at the existing grants on the object:

```sql
-- Command line: \dp users
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_name = 'users';
```

If the grant record is missing, check whether the current role acquires the privilege indirectly through role inheritance:

```sql
SELECT rolname
FROM pg_roles
WHERE pg_has_role(current_user, oid, 'member');
```

Once confirmed, add the grants. From PG 15 on, application accounts cannot create tables in `public` by default and need an explicit grant:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO app;
GRANT USAGE ON SCHEMA public TO app;
GRANT CREATE ON SCHEMA public TO app;        -- only if you really need to create tables in that schema
```

## Troubleshooting 2: duplicate key value violates unique constraint

Query the duplicate row directly using the key value from `DETAIL:  Key (id)=(1) already exists.`:

```sql
SELECT * FROM users WHERE id = 1;
```

Confirm where the constraint comes from (primary key or a business unique index):

```text
postgres=> \d users
```

The most common cause is "ids were inserted explicitly and the sequence did not keep up"; align it with `setval`:

```sql
SELECT setval(pg_get_serial_sequence('users', 'id'), (SELECT max(id) FROM users));
```

In concurrent or retry scenarios, switch to an idempotent form:

```sql
INSERT INTO users (id, name) VALUES (1, 'Zhang San')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
```

## Troubleshooting 3: sorry, too many clients already

First tally the connection distribution by state:

```sql
SELECT state, count(*) FROM pg_stat_activity GROUP BY state ORDER BY count(*) DESC;
```

Locate connections that have been idle for a long time or idle inside a transaction, and their origin:

```sql
SELECT pid, usename, application_name, client_addr, state,
       now() - xact_start AS xact_age, left(query, 60) AS query
FROM pg_stat_activity
WHERE state LIKE 'idle%'
ORDER BY xact_age NULLS FIRST;
```

The fix comes in three layers:

1. Immediate intervention: `SELECT pg_terminate_backend(pid);` to disconnect connections you have confirmed are leaked;
2. Short-term defense: set `idle_in_transaction_session_timeout` and `statement_timeout` so idle connections exit automatically;
3. Root fix: connect a connection pool (such as PgBouncer), review your ORM's pooling parameters, and only then consider raising `max_connections` (takes effect on restart; watch the shared memory cost, and leave a comfortable `superuser_reserved_connections`).

## Further Reading

- [PostgreSQL official docs · 27.2. The Cumulative Statistics System](https://www.postgresql.org/docs/current/monitoring-stats.html)
- [PostgreSQL official docs · SQL Commands](https://www.postgresql.org/docs/current/sql-commands.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Lock Conflict Troubleshooting](../internals/lock-conflict-troubleshooting)
- [Connection and ORM Optimization](../performance/connection-and-orm-optimization)
- [Troubleshooting Toolbox](../tools/troubleshooting-toolbox)
- [Common Mistakes](../basics/common-beginner-mistakes)
- [index](index.md)
- [psql-meta-command-reference](psql-meta-command-reference.md)
- [references-and-docs](references-and-docs.md)
- [common-beginner-mistakes](/basics/common-beginner-mistakes.md)
- [crud-and-on-conflict](/basics/crud-and-on-conflict.md)
- [parameter-tuning](/performance/parameter-tuning.md)
- [pg-hba-and-authentication](/security/pg-hba-and-authentication.md)
Official docs: [Error Code Appendix](https://www.postgresql.org/docs/current/errcodes-appendix.html), [pg_stat_activity View](https://www.postgresql.org/docs/current/monitoring-stats.html)
