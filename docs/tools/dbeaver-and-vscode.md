# DBeaver and VS Code Extensions

Database clients serve two kinds of use case: administration and exploration (viewing structure, editing data, drawing ER diagrams) and opportunistic queries while coding (verifying a piece of SQL while you build the feature). DBeaver is the representative of the former; VS Code extensions are the vehicle for the latter. This page collects the connection setup for both, plus each one's pitfalls.

## DBeaver connection setup

When you create a new connection (Databases → New Connection → PostgreSQL), four fields are required: Host, Port, Database, and username/password. Before connecting you can click "test connection"; DBeaver will prompt you to download the JDBC driver, and you just follow the prompt to install it.

Connecting to an internal-network database usually doesn't go straight over the public internet — it goes through an SSH tunnel via a bastion host. Enable it on the SSH tab of the connection settings:

```plaintext
Tick "Use SSH tunnel"
  Host/IP:   bastion.example.com    -- bastion host
  Username:  cui                    -- bastion host system user
  Auth:      key (point to ~/.ssh/id_ed25519) or password
The database connection's own Host should be the internal address as seen from the bastion, e.g. 10.0.0.8
```

The traffic path is: DBeaver → SSH to the bastion host → the bastion host connects to 10.0.0.8:5432. The database sees the source as the bastion host's IP, so your [pg_hba](../security/pg-hba-and-authentication) rules have to cover it. For connection strings and parameterized usage when writing code, see [client drivers](./client-drivers).

## Metadata browsing and ER diagrams

DBeaver's database navigation tree expands in layers: database → schema → tables/views/indexes/functions. Open any table and you can see its columns, constraints, and DDL (the DDL tab lets you copy the create-table statement directly). The search box at the top supports fuzzy object-name search across databases; when you pick up an unfamiliar database, start by searching table and column names.

ER diagrams: right-click a table → View Diagram to see that table's surrounding relationships, or right-click a schema → View Diagram to see the whole database. It infers relationships from foreign key constraints — a database with no foreign keys renders as a pile of islands, which incidentally validates how complete your constraint design is.

## SQL editor and execution plans

Beyond writing queries, DBeaver's SQL editor has a few features worth knowing:

- Table names, column names, and keywords support auto-completion (`Ctrl+Space`), which saves a lot of time flipping through structure when you write long SQL against an unfamiliar database;
- You can switch `EXPLAIN ANALYZE` results to a plan diagram, similar to pgAdmin's plan visualization, and the bar chart makes the biggest cost driver obvious at a glance;
- Frequently used scripts (DDL, bulk cleanup statements) can be saved as SQL templates (`Ctrl+Shift+T` opens the template browser), then selected and executed — good for periodic maintenance work.

## Data editing and commit modes

DBeaver's data grid lets you edit query results directly: double-click a cell to modify it, and `Ctrl+S` automatically generates the `UPDATE` statement. The pitfall here is the **transaction mode** — the toolbar defaults to Auto-commit, but as soon as you switch to Manual Commit mode:

- After saving, the statement is only sent out; the **transaction isn't committed**, so other sessions can't see your changes;
- The connection holds an unfinished transaction, producing `idle in transaction` on the database. Leaving it uncommitted for a long time can even block vacuum;
- Forgot which mode you're in? Look at the commit icon state in the toolbar, or the "Auto/Manual" text in the status bar.

The principle: after editing data, confirm immediately that it's been committed. For bulk edits, prefer writing an explicit `UPDATE ... WHERE` script rather than clicking through the grid — grid editing can't tell you which rows changed, while a script is reviewable and replayable. Separately, the result set fetches only the first 200 rows by default (fetch size), so raise that or add a filter before editing a very large dataset.

## VS Code extensions: no window switching while coding

VS Code's PostgreSQL client extensions (Microsoft's official PostgreSQL extension vscode-pgsql, or similar ones like Database Client) embed "connect and run queries" inside the editor: add a connection in the sidebar (the same host/port/user/password four-piece set), select a statement in your SQL file to execute it, and the result table shows in the panel below.

The loop it fits is: change code → verify one SQL statement → keep changing code. The trade-offs:

- The query result panel is plainer than DBeaver's; complex filtering and comparing multiple result sets is inconvenient;
- There's no data grid editing or ER diagrams and other management features;
- Connection settings follow the workspace (settings), so check before committing to the repo that you haven't written a password in there.

## Division of labor

| Scenario | Tool |
| --- | --- |
| Looking up tables and verifying SQL while writing business code | VS Code extension |
| Viewing database structure, generating DDL, drawing ER diagrams | DBeaver |
| Bulk data edits, CSV export | DBeaver (or psql `\copy`) |
| Watching active sessions and backups/restore on call | pgAdmin 4 or psql |

The tool is just a front end; behavior is ultimately decided by the database: how transactions commit, whether you have enough privileges, and how long a timeout is all follow the server's rules. When you switch tools to troubleshoot a problem, first confirm the connection string and role match, then compare the behavioral differences.

## Frequently asked questions

- **SSL settings**: DBeaver's SSL Mode in the connection properties (disable/require/verify) is the same parameter with the same meaning as the driver parameter. Use disable for direct internal connections; across the public network, at least require.
- **Result set truncated**: by default it fetches only the first 200 rows (smart fetch size). To get the full data, set the connection's Rows count to unlimited or raise the fetch size. For CSV export, right-click the result grid → Export Data; for large exports, still prefer running psql `\copy` directly.
- **"no active connection"**: the server closed the connection. Common causes include `idle_in_transaction_session_timeout` reclaiming a session with a hanging transaction, or a connection pool not cleaning up after a network interruption. Check the connection string parameters and the database-side timeout settings.
- **Insufficient privilege errors**: first look at the connection list to see which user you're connected as. In many cases you ended up on the default user rather than the application account. For the role and permission model, see [roles and permissions](../security/roles-and-permissions).

## References

- [PostgreSQL official docs · psql](https://www.postgresql.org/docs/current/app-psql.html)
- [PostgreSQL official docs · F.32. pg_stat_statements — track statistics of SQL planning and execution](https://www.postgresql.org/docs/current/pgstatstatements.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [pgAdmin 4](./pgadmin-4)
- [client drivers](./client-drivers)
- [psql advanced](./psql-advanced)
- [pg_hba and authentication](../security/pg-hba-and-authentication)
- [index](index.md)
- [pgadmin-4](pgadmin-4.md)
Official docs: [DBeaver website](https://dbeaver.com/), [VS Code PostgreSQL extension repo](https://github.com/microsoft/vscode-pgsql).
