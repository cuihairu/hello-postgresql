# Auditing

Auditing answers the question: who did what, to which kind of object, and when. PostgreSQL has two implementation routes: kernel logging parameters (zero dependencies, coarse granularity) and the pgaudit extension (fine-grained, structured output). Both only "produce logs" — what actually determines audit quality is how the logs are collected and retained. This page walks through parameters, the extension, collection, and compliance combinations in that order.

## Two routes first

- **Logging parameters**: built into the kernel; turning on `log_statement` records statements immediately, but there is no structured session metadata, no object-level filtering, and the overhead becomes significant at volume.
- **pgaudit extension**: records at fine granularity by session or object, emits standardized AUDIT lines that are easy to parse and archive — the de facto standard for compliance scenarios (not in the kernel; shipped with the various distributions).

The two routes complement each other rather than being an either/or: use `log_min_duration_statement` for slow-query troubleshooting, pgaudit for compliance auditing; do not keep `log_statement = all` on year-round for the sake of auditing.

## Built-in logging parameters and their cost

```plaintext
# postgresql.conf
log_connections = on                 # one line per connection: source IP, user, database
log_disconnections = on              # one line per disconnect: includes session duration
log_duration = off                   # per-statement duration only, no text; noisy, usually off
log_min_duration_statement = 500ms   # statements over the threshold are logged with text and parameters
log_statement = none                 # none / ddl / mod / all
```

What the `log_statement` levels mean: `none` logs errors only; `ddl` logs CREATE/ALTER/DROP; `mod` additionally logs INSERT/UPDATE/DELETE/TRUNCATE/COPY; `all` logs every statement. Cost rises in order — on high-frequency OLTP, `all` noticeably drags throughput and fills up disk, and it **does not record bound parameter values** (the text contains only placeholders). `log_min_duration_statement = 0` is equivalent to logging every statement (with parameters); running it alongside `log_statement = all` logs each statement twice — pick one route.

## pgaudit: session auditing and object auditing

```plaintext
# postgresql.conf; changing shared_preload_libraries requires a restart
shared_preload_libraries = 'pgaudit'
pgaudit.log = 'write, ddl, role'    # writes + DDL + role changes
pgaudit.log_catalog = off           # skip access to pg_catalog to cut noise
pgaudit.log_parameter = on          # log bound parameters (logs then contain business data; enable with care)
```

```sql
CREATE EXTENSION pgaudit;   -- object-level auditing requires the extension; session-level auditing works without it
```

Session auditing records by category; a log line looks like (illustrative):

```plaintext
AUDIT: SESSION,1,1,WRITE,UPDATE,TABLE,public.orders,
  UPDATE orders SET status = 'paid' WHERE id = 42,<not logged>
```

The fields in order: audit class (SESSION/OBJECT), statement number, sub-statement number, command class, command, object type, object name, parameters, statement text. Object-level auditing uses a "grant is audit" pattern: grant the sensitive object to a dedicated role, point `pgaudit.role` at it, and access to that object is recorded as OBJECT:

```sql
CREATE ROLE auditor NOLOGIN;
ALTER DATABASE appdb SET pgaudit.role = 'auditor';
GRANT SELECT ON payment_cards TO auditor;   -- reads of payment_cards are now audited
```

The value of object auditing is "log only the tables that matter" — an order of magnitude less storage and retrieval cost than full SESSION logging.

## Log format and collection: csvlog and jsonlog

Plain-text logs are hard to parse reliably, so emit audit logs in structured form from the start:

```plaintext
logging_collector = on
log_destination = 'csvlog'     # 'jsonlog' is available from PG 15+; friendlier to collection pipelines
log_directory = 'log'
log_rotation_age = 1d
log_rotation_size = 100MB
```

Each csvlog / jsonlog line carries a fixed set of fields — timestamp, session ID, PID, user, database, client address, statement text — that collectors like filebeat / vector / fluent-bit can map straight onto search-engine fields. The **session ID** threads "connection established → several statements → disconnect" into one complete trail; cross-line tracking relies on it, and the lines written by `log_connections`/`log_disconnections` carry the same session ID.

## Suggested combinations for compliance scenarios

| Scenario | Suggested combination |
| --- | --- |
| Routine inspection / troubleshooting | `log_connections = on` + `log_min_duration_statement = 500ms`, no pgaudit |
| MLPS / ISO 27001 baseline requirements | pgaudit `write, ddl, role` + `log_connections/disconnections` + remote archiving |
| Highly sensitive data (payments / healthcare) | pgaudit all categories + `pgaudit.log_parameter = on` + object-level auditing over sensitive tables + evaluate log redaction |

## Retention and tamper resistance: hand it to external archiving

Local log files are written by the postgres process and give little protection if the instance is compromised or the files deleted. The anti-tamper idea is "**off this machine as fast as possible**": the collector pushes to a remote target near-real-time (seconds); the remote side keeps them in append-only object storage (such as S3 Object Lock / WORM) or a dedicated log platform; set the retention period to what your compliance regime requires (commonly 6 months to 3 years), and make sure the deletion at expiry leaves its own trace. Treat local logs purely as a buffer: confirm `log_truncate_on_rotation = on`, and monitor "when a log file was last uploaded" — an audit hole from a broken collection link is more dangerous than having no logs at all. This part shares the same collection infrastructure as [Monitoring and Alerting](../operations/monitoring-and-alerting).

## Caveats and common pitfalls

- Changing `shared_preload_libraries` requires a restart, so schedule a downtime window for the pgaudit rollout; with only `CREATE EXTENSION` and no preload, object auditing does not work.
- `pgaudit.log_parameter = on` writes query parameters (possibly personal data) into audit logs, so tighten log access accordingly, or run a redaction assessment first.
- `log_statement = all` is a double trap for performance and disk; leave long-term auditing to pgaudit or an object-level scheme.
- jsonlog is a `log_destination` option only from PG 15+; older versions use csvlog. Both require `logging_collector = on`.
- `log_min_duration_statement` logs on completion; canceled queries never reach the log, so it cannot serve as complete auditing.
- Run it in a test environment before rollout, confirm the audit output (especially parameters and statement text) matches expectations, then set the collection and redaction policy.

## References

- [PostgreSQL official docs · 5.9. Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [PostgreSQL official docs · 20.3. Authentication Methods](https://www.postgresql.org/docs/current/auth-methods.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [pg_hba and Authentication](./pg-hba-and-authentication)
- [Hardening Checklist](./hardening-checklist)
- [Monitoring and Alerting](../operations/monitoring-and-alerting)
- [pg_stat observation](../internals/pg-stat-observation)
- [extension-management](/ecosystem/extension-management.md)
- [data-encryption-at-rest](data-encryption-at-rest.md)
- [hardening-checklist](hardening-checklist.md)
- [index](index.md)
Official docs: [Error reporting and logging](https://www.postgresql.org/docs/current/runtime-config-logging.html), [Log file formats (csvlog/jsonlog)](https://www.postgresql.org/docs/current/runtime-config-logging.html#RUNTIME-CONFIG-LOGGING-CSVLOG), [pgaudit](https://github.com/pgaudit/pgaudit).
