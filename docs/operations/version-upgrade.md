# Version Upgrades

Minor version (bug fix) upgrades in PostgreSQL only require swapping binaries; major version upgrades (e.g. 15 → 16) have incompatible data file formats, so the data must be moved from the old instance into a new one. There are three main routes: logical export/import, in-place upgrade with `pg_upgrade`, and cutover via logical replication. Which one you pick depends on how long your maintenance window is, how big the database is, and whether you can accept dual-running during the cutover.

## Comparing the three routes

| Route | Downtime | Rough cost | Suitable for |
| --- | --- | --- | --- |
| pg_dumpall / pg_dump export then import | Proportional to database size; hours once you're in the tens of GB | Simple to operate, mature scripts | Small databases, generous downtime windows, and as a chance to clean up table bloat |
| pg_upgrade --link in-place upgrade | Minutes (mainly checks + analyze) | Requires binaries for both old and new versions plus disk space; hard links reuse files | Medium-to-large databases, a brief read-only window is acceptable |
| Logical replication cutover (dual-run) | Seconds to switch | Requires standing up a new instance and waiting for it to catch up; DDL is restricted | Requirements near-zero RTO, cannot tolerate long write outages |

An empirical rule of thumb for choosing: if the database isn't big, dump/restore; if you can stand a few minutes down, pg_upgrade; if the business must not notice, go with a logical replication cutover.

## pg_upgrade: --check and the in-place upgrade

The prerequisite is that binaries for both major versions are installed (for example `postgresql-15` and `postgresql-17` coexisting — see [Cluster Init and Directory Layout](./cluster-init-and-layout)).

```bash
# 0. stop both the old and the new instance
pg_ctl -D /var/lib/postgresql/15/main stop
pg_ctl -D /var/lib/postgresql/17/main stop

# 1. run --check first as a dry run: checks only, no changes
/usr/lib/postgresql/17/bin/pg_upgrade \
  --old-datadir /var/lib/postgresql/15/main \
  --new-datadir /var/lib/postgresql/17/main \
  --old-bindir /usr/lib/postgresql/15/bin \
  --new-bindir /usr/lib/postgresql/17/bin \
  --link --check

# 2. once the check passes, run the real upgrade; --link reuses old data files via hard links, saving both space and time
/usr/lib/postgresql/17/bin/pg_upgrade \
  --old-datadir /var/lib/postgresql/15/main \
  --new-datadir /var/lib/postgresql/17/main \
  --old-bindir /usr/lib/postgresql/15/bin \
  --new-bindir /usr/lib/postgresql/17/bin \
  --link
```

A few hard requirements:

- **Both instances must be stopped first** — pg_upgrade does not support online upgrades.
- The locale and encoding used by the new cluster's `initdb` must match the old cluster, or the check phase will fail.
- **Extensions must be installed in the new cluster first** (`CREATE EXTENSION`, with a version matching the new release), otherwise pg_upgrade errors out and exits. Extensions with C code like `postgis` and `pgvector` in particular need the corresponding new-version .so installed first.
- Once `--link` mode finishes, the old data directory is no longer usable (hard links share inodes); after the upgrade the old directory can only be archived or deleted as a whole — it can't be started up again as a rollback point.

Run `ANALYZE` on the new cluster immediately after the upgrade (pg_upgrade already prompts you to), otherwise statistics are empty and execution plans will be terrible.

## Pre-upgrade checklist

- Extension compatibility: list the extensions to install in the new cluster and their target versions, and confirm the new-version .so files exist.
- Deprecated parameters: check the release notes against `postgresql.conf` for GUCs that were removed or renamed (e.g. PG 12 removed `recovery.conf`, PG 14 renamed `wal_keep_size`).
- Authentication methods: whether the methods in `pg_hba.conf` are still supported by the new version (e.g. `md5` is deprecated and not recommended as a default from PG 18).
- Backup: a successful base backup + archiving must be completed before upgrading (see [Physical Backup and PITR](./physical-backup-and-pitr)).
- Disk: non-`--link` mode needs free space of at least 1.2× the old database for the new directory; `--link` mode still needs headroom for temporary files.
- Statistics rebuild: run `vacuumdb --all --analyze-in-stages` as soon as the upgrade is done, spreading statistics out in stages.

## Rolling cutover: dual-running on logical replication

The zero-downtime route is to build a new instance of the new version first, sync the data over with logical replication, and do a single cutover during the window.

```sql
-- old database (publisher, PG 10+)
CREATE PUBLICATION app_pub FOR ALL TABLES;

-- new database (subscriber)
CREATE SUBSCRIPTION app_sub
  CONNECTION 'host=old-host dbname=app user=repl'
  PUBLICATION app_pub WITH (copy_data = true);
```

Cutover steps:

1. Create the new subscription and wait for initial sync + incremental catch-up (compare `latest_end_lsn` in `pg_stat_subscription` against the publisher's LSN).
2. Pick a low-traffic window and briefly stop the application's write traffic (or lock the old database into read-only mode: `ALTER SYSTEM SET default_transaction_read_only = on` then reload).
3. Wait for the subscription to fully catch up, then confirm data consistency on the new database.
4. Point the application connection string at the new database (DNS, config center, or a PgBouncer backend — any of those works).
5. Observe for a while, then stop the subscription; keep the old database around for a time as a rollback option, but do not allow writes to it.

Rollback: if problems show up right after the cutover, just point the application connection string back at the old database (the precondition being that the old database received no writes after the cutover — so once you switch away, the old database must be set read-only or the replication direction must be stopped). Before switching back, work out whether the old database has already lost writes that happened on the new one after the cutover.

Think through logical replication's limits in advance: DDL is not replicated, so you can't run half the DDL on each side during the cutover window; large object types beyond `bytea` are not replicated; and sequence current values are not copied automatically, so align them explicitly on the new database before the cutover (`setval` to the old database's current values, one sequence at a time).

## Minor version upgrades

Within the same major version (e.g. 17.2 → 17.4) the data format is compatible, so the approach is to swap binaries:

```bash
# Debian/Ubuntu family
apt-get update && apt-get install --only-upgrade postgresql-17
# RHEL family
yum update postgresql17-server

# stop the database → swap the package → start the database (minor version upgrades require an instance restart)
pg_ctl -D $PGDATA stop
# the package manager replaces the binaries under /usr/lib/postgresql/17/bin
pg_ctl -D $PGDATA start
```

Key points:

- Minor versions also require a restart — it's not "just do a reload." Plan a maintenance window ahead of time or rely on an HA switchover (see [High Availability Architectures](./high-availability-architecture)).
- Install only security-fix minor versions; don't skip ahead, follow the official release notes order.
- In a primary-standby setup, upgrade the standbys first, then switch the primary, then upgrade the original primary, to reduce total write outage time.

## Caveats and common pitfalls

- Forgetting to install extensions in the new cluster first is the most common cause of pg_upgrade failure — `--check` reports it, so don't skip the dry run.
- After a `--link` upgrade the old data directory can't be started up and used directly, and many teams fall into this trap when trying to roll back. If you want to keep a rollback-capable state, don't use `--link`; use a full `pg_dumpall` export instead.
- Statistics are empty after pg_upgrade, so day-one performance will be off — run `vacuumdb --analyze-in-stages` first.
- During a logical replication dual-run, both sides may have business writes (e.g. a forgotten scheduled job), which produces primary key conflicts. The cutover window has to account for every write entry point.
- On day one after the upgrade, watch `pg_stat_statements` (see [pg_stat_statements](../performance/pg-stat-statements)) and the slow query log closely: changes to the new version's optimizer cost model can make individual SQL statements pick the wrong plan — bridge with `plan_cache_mode` or explicit hints.

## Further reading

- [PostgreSQL official docs · pg_upgrade](https://www.postgresql.org/docs/current/pgupgrade.html)
- [PostgreSQL official docs · 18.6. Upgrading a PostgreSQL Cluster](https://www.postgresql.org/docs/current/upgrading.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [install-and-quickstart](/basics/install-and-quickstart.md)
- [extension-management](/ecosystem/extension-management.md)
- [postgresql-16-features](/ecosystem/postgresql-16-features.md)
- [postgresql-17-features](/ecosystem/postgresql-17-features.md)
- [when-to-choose-postgresql](/ecosystem/when-to-choose-postgresql.md)
- [logical-replication-internals](/internals/logical-replication-internals.md)
- [backup-strategy](backup-strategy.md)
- [cloud-native-and-containers](cloud-native-and-containers.md)
- [cluster-init-and-layout](cluster-init-and-layout.md)
- [index](index.md)
- [logical-replication-ops](logical-replication-ops.md)
- [streaming-replication-setup](streaming-replication-setup.md)- [Cluster Init and Directory Layout](./cluster-init-and-layout) — multi-version coexistence and initdb parameters.
- [Physical Backup and PITR](./physical-backup-and-pitr) — the mandatory backup safety net before an upgrade.
- [High Availability Architectures](./high-availability-architecture) — using switchover to cut upgrade downtime.
- [Logical Replication Operations](./logical-replication-ops) — dual-run cutover details and conflict handling.

Official docs: <https://www.postgresql.org/docs/current/pgupgrade.html> and <https://www.postgresql.org/docs/current/upgrading.html>
