# pgAdmin 4

pgAdmin 4 is the GUI administration tool in PostgreSQL's official ecosystem. It has a web architecture (you access it from a browser, while the server side can run on any machine) and covers querying, object management, backup and restore, and activity monitoring. Developers don't necessarily use it every day, but DBAs on call and anyone giving a business demo reach for it often.

## Docker deployment

pgAdmin provides an official container image `dpage/pgadmin4`; one command gets it running:

```bash
docker run -d --name pgadmin \
  -p 5050:80 \
  -e PGADMIN_DEFAULT_EMAIL=admin@example.com \
  -e PGADMIN_DEFAULT_PASSWORD='change-me' \
  dpage/pgadmin4
```

Browse to `http://localhost:5050` and log in with the email and password above. On first login, go into Servers and Register → Server, then fill in the target database's Host, Port, Username, and Password. Note that this connection is initiated by the pgAdmin server side: `localhost` inside the container refers to the container itself. To reach a database on the host machine, use `host.docker.internal` (Windows/macOS) or the host's internal IP.

For production, keep pgAdmin on the internal network and add access control. It stores credentials to every environment.

## Query Tool and EXPLAIN visualization

The Query Tool is the main workbench. Select some SQL and press `F5` to run it; the result appears in the data grid below. Its advantage with `EXPLAIN` is the **graphical execution plan**: after running `EXPLAIN ANALYZE ...`, switch to the Explan chart tab and the plan tree renders as a bar chart by node cost and row count. You can spot the most expensive node at a glance, much faster than reading a text plan.

Two things to know:

- Running `EXPLAIN (ANALYZE)` in the Query Tool also **actually executes** the statement, so think before you change data;
- The result grid truncates long text by default and limits the number of rows fetched. A "truncated" notice doesn't mean that's all the data — verify the exact row count with `SELECT count(*)`;
- Distinguish **Execute** (sends the selected statement to the server for normal SQL execution) from **Execute as SQL script** (sends the whole block as a batched script). Use the latter when writing functions or stored procedures if you need a transaction and multiple statements in one round trip.

## Order for troubleshooting connection failures

```plaintext
Authentication failed for user      → wrong password, or the user has no matching allow rule in pg_hba
no pg_hba.conf entry for ...        → the source address isn't in pg_hba.conf; add the rule first, then connect
SSL error: certificate verify failed → SSL mode is set to verify-ca/verify-full but the certificate chain is incomplete;
                                        either switch to require or add the CA certificate
timeout / connection refused         → the port isn't listening or the firewall is blocking it; try nc -vz host 5432 first
```

pgAdmin lets you set the SSL mode separately on the server registration screen (Preferences → Servers → SSL). The semantics match the `sslmode` parameter of command-line drivers. For the logic behind authentication rules and allowed source determination, see [pg_hba and authentication](../security/pg-hba-and-authentication).

## Dashboard and activity monitoring

Select a Server and the Dashboard panel on the right shows three blocks of information: a connection activity chart (transactions per second, tuple reads/writes), and Server Activity (the current session list, locks, and the predefined "long-running transaction" and "idle connection" views). When troubleshooting "the database suddenly got slow," start here to confirm how many sessions are active and whether any transaction has been running for tens of minutes, then switch to psql and use [pg_stat_activity](./troubleshooting-toolbox) to dig into details. The Dashboard data is just a graphical view over system views like `pg_stat_activity`, and the refresh interval is adjustable under File → Preferences.

## Object maintenance and query history

Right-click an object (database, schema, table) to open the **Maintenance** dialog. You can run VACUUM on a database or ANALYZE on a table without typing anything at the command line. This is handy for running `ANALYZE` right after creating an index so the optimizer picks up the statistics.

`VACUUM FULL` and `REINDEX`, which lock writes and consume space, aren't exposed in the GUI. Run them yourself at the command line during off-peak hours — see [vacuum and dead tuples](../internals/vacuum-and-hot).

The Query Tool keeps query history locally, so when troubleshooting you can pull up the statement you ran last time and keep editing it instead of rewriting from scratch.

## Backup and restore interface

Right-click any object (database, schema, table) → Backup/Restore. Under the hood it calls `pg_dump`/`pg_restore`/`psql`, and the interface lets you pick the format and options:

- For backup, choose Format **Custom**: at restore time you can selectively restore individual objects, and parallel restore is supported;
- Before restoring, confirm how the target object should be handled (Data-only / Schema-only / whether to clean up existing objects);
- The bottom-left of the dialog shows the actual command line that will run. For complex scenarios it's more reliable to copy that command and run it directly on the server.

Backups of large databases through the web UI are limited by the browser and the pgAdmin server. For large backups, run `pg_dump` directly on the server.

## Common settings and pitfalls

- **Auto commit**: the Query Tool auto-commits by default, so a single DML takes effect immediately. If you turn it off, remember to click Commit manually, otherwise the transaction stays open and leaves `idle in transaction` sessions behind.
- **Query timeout**: pgAdmin itself doesn't limit how long a statement runs; timeouts are controlled on the database side — either `SET statement_timeout = '30s'` in the session, or per role `ALTER ROLE analyst SET statement_timeout = '30s'`.
- **Read-only needs**: pgAdmin has no "read-only mode" toggle. Connections for analysts should use a read-only role outright (grant only SELECT, or set `default_transaction_read_only = on`) — see [roles and permissions](../security/roles-and-permissions).
- **A guard against mistakes**: under Preferences → Query Tool you can enable "confirm closing tabs with uncommitted transactions." Worth turning on if you're used to committing manually.
- **Garbled Chinese text**: first check the session encoding with `SHOW client_encoding;` to see whether it's UTF8. When the client and database encodings disagree, CSV exports come out garbled. Fix the connection settings rather than the data.

pgAdmin's role is a "graphical management console": creating tables, checking dependencies, running backups, and triaging on call are all comfortable in it. For a high-frequency SQL development flow, an IDE plugin or DBeaver is lighter and faster (see [DBeaver and VS Code plugins](./dbeaver-and-vscode)).

## References

- [PostgreSQL official docs · psql](https://www.postgresql.org/docs/current/app-psql.html)
- [PostgreSQL official docs · F.32. pg_stat_statements — track statistics of SQL planning and execution](https://www.postgresql.org/docs/current/pgstatstatements.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [psql advanced](./psql-advanced)
- [DBeaver and VS Code plugins](./dbeaver-and-vscode)
- [troubleshooting toolbox](./troubleshooting-toolbox)
- [roles and permissions](../security/roles-and-permissions)
- [dbeaver-and-vscode](dbeaver-and-vscode.md)
- [index](index.md)
Official docs: [pgAdmin 4 documentation](https://www.pgadmin.org/docs/pgadmin4/latest/).
