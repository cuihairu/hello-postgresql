# Books and Official Docs

The resource entries I reach for when writing docs, looking up problems, finding references, and revisiting how things work under the hood. Official resources come mainly from the PostgreSQL official site; the community and book listings include only long-maintained, widely known sources.

The official manual is organized by version: `docs/current` always points to the latest stable release, and when you need to match your production version exactly, replace `current` in the URL with a specific version number (such as `docs/16/`).

## By Scenario

| Scenario | Where to look |
| --- | --- |
| Syntax and semantics of a given SQL statement | [SQL Command Reference](https://www.postgresql.org/docs/current/sql-commands.html) |
| Meaning of an error code behind an error | [Error Code Appendix](https://www.postgresql.org/docs/current/errcodes-appendix.html) |
| Meaning and default value of a GUC parameter | [Configuration Reference](https://www.postgresql.org/docs/current/runtime-config.html) |
| Fields of pg_stat_* views | [Monitoring Views](https://www.postgresql.org/docs/current/monitoring-stats.html) |
| psql meta-commands and parameters | [psql Manual](https://www.postgresql.org/docs/current/app-psql.html) |
| What changed in a given version | [Release Notes](https://www.postgresql.org/docs/current/release.html) |

## Official Resources

| Resource | Link | What it is for |
| --- | --- | --- |
| PostgreSQL official manual | [postgresql.org/docs/current](https://www.postgresql.org/docs/current/) | The complete reference, organized by version; the first stop for syntax, configuration, and system views |
| SQL Command Reference | [sql-commands.html](https://www.postgresql.org/docs/current/sql-commands.html) | An index of the syntax and semantics of every SQL command |
| psql Manual | [app-psql.html](https://www.postgresql.org/docs/current/app-psql.html) | The command-line client's parameters, meta-commands, and variables |
| Error Code Appendix | [errcodes-appendix.html](https://www.postgresql.org/docs/current/errcodes-appendix.html) | The meaning and trigger scenarios of every SQLSTATE error code |
| Release Notes | [release.html](https://www.postgresql.org/docs/current/release.html) | Per-version behavior changes, new features, and incompatibilities |
| Official Wiki | [wiki.postgresql.org](https://wiki.postgresql.org/) | Community-maintained HOWTOs, migration notes, and operations experience |
| PostgreSQL Tutorial (external doc) | [tutorial.html](https://www.postgresql.org/docs/current/tutorial.html) | Official examples for setting up a database and querying it |
| Performance Tips | [performance-tips.html](https://www.postgresql.org/docs/current/performance-tips.html) | Official tuning advice for queries and configuration |
| Monitoring Views | [monitoring-stats.html](https://www.postgresql.org/docs/current/monitoring-stats.html) | Field descriptions for the pg_stat_* family of views |
| Configuration Reference | [runtime-config.html](https://www.postgresql.org/docs/current/runtime-config.html) | Values and meanings of every GUC parameter |
| Backup and Recovery | [backup.html](https://www.postgresql.org/docs/current/backup.html) | Official coverage of physical backups, logical backups, and point-in-time recovery |

## Driver and Client Documentation

| Resource | Link | What it is for |
| --- | --- | --- |
| pgjdbc | [jdbc.postgresql.org](https://jdbc.postgresql.org/) | The official Java driver |
| psycopg | [psycopg.org](https://www.psycopg.org/) | The main Python driver (psycopg 2 and 3) |
| node-postgres | [node-postgres.com](https://node-postgres.com/) | The main Node.js driver |
| Npgsql | [npgsql.org](https://www.npgsql.org/) | The .NET driver |

## Community Resources

| Resource | Link | What it is for |
| --- | --- | --- |
| PostgreSQL Weekly | [postgresweekly.com](https://postgresweekly.com/) | A weekly email newsletter tracking community news and new releases |
| Planet PostgreSQL | [planet.postgresql.org](https://planet.postgresql.org/) | An aggregation of PostgreSQL-related blogs worldwide |
| depesz's blog | [depesz.com](https://www.depesz.com/) | Hubert Lubaczewski's in-depth PostgreSQL writing |
| explain.depesz.com | [explain.depesz.com](https://explain.depesz.com/) | An online EXPLAIN plan visualization tool |
| pganalyze blog | [pganalyze.com/blog](https://pganalyze.com/blog) | Writing on query performance, indexes, and execution plan analysis |
| Use The Index, Luke | [use-the-index-luke.com](https://use-the-index-luke.com/) | Index internals and tuning, applicable across databases |
| PostgreSQL community | [postgresql.org/community](https://www.postgresql.org/community/) | Entry points to mailing lists, IRC, and local user groups |

## Chinese-Language Resources

| Resource | Link | What it is for |
| --- | --- | --- |
| PostgreSQL Chinese community | [postgres.cn](https://www.postgres.cn/) | The Chinese-language community portal, with a Chinese translation of the official manual, events, and Q&A |

## Books

| Book | Author | What it is for |
| --- | --- | --- |
| PostgreSQL 14 Internals | Egor Rogov | Published by Postgres Professional, a free official PDF that systematically covers MVCC, WAL, locks, and query execution |
| The Internals of PostgreSQL | Hironobu Suzuki | Free online (interdb.jp), source-level internals organized by subsystem |
| The Art of PostgreSQL | Dimitri Fontaine | For application developers, a practical book on writing good SQL and database design |
| PostgreSQL: Up and Running | Regina Obe, Leo Hsu | O'Reilly's practical reference for installation and administration |

## Scenario-Based Lookups

- Getting started with application development: PostgreSQL Tutorial and The Art of PostgreSQL, alongside each other for database setup, CRUD, and constraint examples.
- Day-to-day troubleshooting: look up the SQLSTATE in the [Error Code Appendix](https://www.postgresql.org/docs/current/errcodes-appendix.html) first, then cross-check the [Common Errors and Troubleshooting Reference](./common-errors-and-troubleshooting) on this site.
- Indexes and slow queries: Use The Index, Luke and the pganalyze blog, combined with `EXPLAIN ANALYZE` and explain.depesz.com to read plans.
- Going deep on internals: read the two Internals books alongside each other, using the official MVCC and WAL chapters as anchors.
- Tracking versions: Release Notes and PostgreSQL Weekly; read both before any upgrade.

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Glossary](./glossary)
- [SQL Command Reference](./sql-command-reference)
- [psql Meta-Command Reference](./psql-meta-command-reference)
- [Common Errors and Troubleshooting Reference](./common-errors-and-troubleshooting)
- [index](index.md)
- [knowledge](/knowledge.md)
