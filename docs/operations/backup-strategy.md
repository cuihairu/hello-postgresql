# Backup Strategy

Backups come in two schools: logical backups (the pg_dump family of tools, exporting data at the SQL level) and physical backups (copying the data directory + WAL archiving — see [Physical Backup and PITR](./physical-backup-and-pitr)). Logical backups restore slowly and have no point-in-time recovery, but they cross versions and platforms and can restore table by table, making them a good fit for day-to-day backups of small-to-medium databases, as a backstop for cross-version migration, and for populating test environments with data. This page records tool usage and limits, and how to combine them into a tiered strategy.

## pg_dump: single-database logical backup

```bash
# custom format -Fc: compressed, supports parallel and selective restore; the everyday first choice
pg_dump -h 127.0.0.1 -U postgres -Fc -f appdb-$(date +%F).dump appdb

# directory format -Fd: the only format that supports parallel export (-j only takes effect here)
pg_dump -Fd -j 4 -f appdb_dir appdb

# export structure and data separately (--section has three parts: pre-data / data / post-data)
pg_dump -Fc --section=pre-data --section=post-data -f appdb-schema.dump appdb
pg_dump -Fc --section=data -f appdb-data.dump appdb

# single table
pg_dump -Fc -t orders -f orders.dump appdb
```

Key points:

- **Format choice**: plain text output (the default) can only be fed to psql as a whole file; only the `-Fc`/`-Fd` archive formats can be paired with pg_restore for parallel and selective restore.
- **The `--section` split**: `pre-data` is the table structure, `post-data` is indexes, constraints, triggers, and views. This ordering means a restore can build tables first, load data, and build indexes last — pg_restore's parallel restore optimizes for this automatically.
- **Cross-environment restore** commonly uses `--no-owner --no-privileges`: no ownership or grant information, avoiding failures when roles don't exist in the target database.
- `-Z 0~9` controls the compression level; the default is moderate, and you can raise it to trade CPU for smaller files if you have headroom.

## pg_dumpall: global objects

Roles, tablespaces, and other cluster-level objects don't belong to any database, so `pg_dump` can't back them up — keep a separate copy:

```bash
pg_dumpall --globals-only -f globals.sql    # roles / password hashes / tablespaces / privileges
# restore: psql -f globals.sql (usually run before restoring the business databases into the target cluster)
```

Without arguments, `pg_dumpall` exports every database in the instance, but its output is plain text, single-connection, and cannot be parallelized — not recommended as a routine backup for large databases. For day-to-day backups, use pg_dump per database, and top up global objects with `--globals-only`.

## pg_restore: restoring

```bash
# parallel restore (supported by both -Fc and -Fd); -j is the biggest speed lever
pg_restore -h target -U postgres -j 4 -d appdb appdb.dump

# restore into a freshly created database (the archive contains CREATE DATABASE statements)
pg_restore -C -d postgres appdb.dump

# clean up existing objects before overwriting (dangerous; confirm the target database can be rebuilt)
pg_restore --clean --if-exists -d appdb appdb.dump
```

Restoring a single table is the core advantage of archive formats — generate a table of contents, filter out the target table, then restore:

```bash
pg_restore -l appdb.dump > toc.list        # generate the table-of-contents listing
# edit toc.list: delete the entry lines you don't need (lines starting with a semicolon are comments, keep or drop as you like)
pg_restore -j 2 -L toc.list -d appdb appdb.dump
```

## The limits of logical backups

- **Speed**: bounded by SQL-level export/import, so TB-scale databases routinely take hours to days. `-Fd -j` parallel export and `pg_restore -j` parallel restore help a lot, but it's still slower than a physical restore of a base backup + WAL replay.
- **No PITR**: the restore point is the moment the backup completed; the delta between two backups can't be restored, so you need WAL archiving for point-in-time recovery.
- **Version compatibility direction**: a dump exported by an older version can be restored into a newer one — this is one of the officially supported major version upgrade paths. The reverse direction (newer exported, older restored) is not supported. The `pg_dump` client version must not be lower than the version of the server being backed up — watch for this when upgrading the toolchain.
- **No cluster-level objects**: roles and tablespaces rely on `pg_dumpall --globals-only` as a separate backup; missing that copy is the most common trap at restore time.
- **Impact on the running system**: logical backups don't block DML, but exporting a large database raises IO and cache pressure — run it during the low-traffic window.

## A tiered backup strategy

No single kind of backup covers every failure scenario, so production setups combine them by "recovery goal":

| Tier | Mechanism | Scenarios covered | Reference retention |
| --- | --- | --- | --- |
| Daily logical backup | `pg_dump -Fc` per database | Accidental deletion of a single table/database, cross-version backstop, test data | 7~30 days |
| Weekly physical base backup + continuous WAL archiving | pgBackRest / Barman / WAL-G | Point-in-time recovery (PITR) after an entire database is dropped, whole-machine failure | 14~30 days |
| Global objects | `pg_dumpall --globals-only` daily | Rebuilding roles and privileges in a new environment | Kept in sync with the logical backups |

Companion principles:

- **3-2-1**: at least 3 copies, on 2 media, with 1 off-site (object storage or another data center).
- **Backups must not live on the database host**: if the backup files and the data directory share a disk, the backup dies with the machine.
- Set retention by compliance requirements and storage cost; purge expired base backups and archived WAL.
- For production, prefer pgBackRest or WAL-G over raw cron scripts: concurrency, compression, checksums, and S3-compatible storage are all built in.

```bash
# cron example for a simple setup (daily logical backup + 14-day retention)
0 2 * * * pg_dump -h 127.0.0.1 -U postgres -Fc \
  -f /backup/appdb-$(date +\%F).dump appdb \
  && find /backup -name 'appdb-*.dump' -mtime +14 -delete
```

## Backups must be restore-drilled

A backup whose restore path has never been verified isn't really a backup — corrupt files, missing parameters, and overlooked global objects only show up at a real restore. A drill has to answer three numbers: **how far back can you get (RPO), how long does it take (RTO), and is the data correct**.

```bash
# monthly drill: restore into an isolated environment (test machine/container) and verify
pg_restore -C -h localhost -d postgres appdb-2026-10-01.dump
psql -d appdb -c "SELECT count(*) FROM orders;"          # row count check
psql -d appdb -c "SELECT max(updated_at) FROM orders;"   # data freshness check
```

- Script the drill and record the measured RTO each time; if restore time exceeds the business tolerance, adjust the tiers (for example, raise physical backup frequency or switch to incremental).
- The restore drill for physical backups (PITR to a specific point in time) has more steps — see [Disaster Recovery Drills](./disaster-recovery-drills) separately.
- Keep the drill environment's version as close to production as possible: restoring across major versions is an upgrade scenario, and should be verified via the [Version Upgrades](./version-upgrade) path.

## Caveats and common pitfalls

- **Only the business database was backed up, globals were missed**: after restoring, users and privileges are all gone and the application can't connect.
- **A full-text pg_dumpall treated as the only backup**: restore times for large databases are unacceptable, and there's no PITR.
- **`--clean --if-exists` pointed at the wrong environment**: it drops same-named objects in the target database first, so pointing it at production is an incident.
- **Single-table restore without its dependents**: restoring only one table's data can fail at the post-data stage because of foreign key constraints — work out the restore order first.
- **Sequence values in logical replication / migration scenarios**: dump-restore restores sequences, but logical replication doesn't move them, so manually `setval` before the cutover.
- **No monitoring on the backup itself**: a backup job failing for a week with nobody noticing is equivalent to running bare — alert on the existence, size, and freshness of backup files.

## Further reading

- [PostgreSQL official docs · Chapter 25. Backup and Restore](https://www.postgresql.org/docs/current/backup.html)
- [PostgreSQL official docs · Chapter 19. Server Configuration](https://www.postgresql.org/docs/current/runtime-config.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Physical Backup and PITR](./physical-backup-and-pitr)
- [Disaster Recovery Drills](./disaster-recovery-drills)
- [Version Upgrades](./version-upgrade)
- [Cluster Init and Directory Layout](./cluster-init-and-layout)
- [common-beginner-mistakes](/basics/common-beginner-mistakes.md)
- [install-and-quickstart](/basics/install-and-quickstart.md)
- [multi-tenant-modeling](/database-design/multi-tenant-modeling.md)
- [soft-delete-and-tombstone](/database-design/soft-delete-and-tombstone.md)
- [postgresql-17-features](/ecosystem/postgresql-17-features.md)
- [when-to-choose-postgresql](/ecosystem/when-to-choose-postgresql.md)
- [knowledge](/knowledge.md)
- [cloud-native-and-containers](cloud-native-and-containers.md)
- [disaster-recovery-drills](disaster-recovery-drills.md)
- [high-availability-architecture](high-availability-architecture.md)
- [index](index.md)
- [logical-replication-ops](logical-replication-ops.md)
- [ops-sop](ops-sop.md)
- [physical-backup-and-pitr](physical-backup-and-pitr.md)
- [data-encryption-at-rest](/security/data-encryption-at-rest.md)
