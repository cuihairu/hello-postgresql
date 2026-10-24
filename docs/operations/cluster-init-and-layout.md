# Cluster Init and Directory Layout

In PostgreSQL, a "cluster" refers to a group of server processes and data that share the same data directory (PGDATA) — not a cluster made up of multiple machines. Multiple clusters can coexist on a single machine (different versions, different ports, different data directories). Understanding what `initdb` initializes and what each subdirectory under PGDATA holds is a prerequisite for diagnosing startup failures, planning disk usage, and doing backup migrations.

> This article targets PostgreSQL 16/17; package paths are shown for Debian/Ubuntu (`/usr/lib/postgresql/<version>`) and RHEL-family (`/usr/pgsql-<version>`) distributions.

## Key `initdb` parameters

`initdb` creates the initial cluster in an empty directory: it generates the template databases and system catalogs, creates the initial role `postgres`, and writes out the initial configuration files. It runs only once at the start of a cluster's lifetime, and options like encoding and locale — the "set it and you can't change it" kind — must be right the first time.

```bash
sudo -u postgres initdb -D /var/lib/postgresql/17/main \
  --encoding=UTF8 \
  --locale=C.UTF-8 \
  --auth-local=peer \
  --auth-host=scram-sha-256 \
  --data-checksums \
  --wal-segsize=64 \
  --pwfile=/tmp/pgpass
```

| Parameter | Effect and caveats |
| --- | --- |
| `-D` | Data directory (PGDATA). Must be empty, owned by the system user that runs postgres, and must not be run as root |
| `--encoding` | Default encoding for newly created databases; a cluster-level default that cannot be changed afterward (individual databases can specify their own at creation time) |
| `--locale` | Affects sorting and case comparisons. Under a libc locale, indexes depend on the collation rules at creation time; changing the locale means rebuilding indexes. If unsure, use `C` or `C.UTF-8` |
| `--auth-local` / `--auth-host` | Sets the initial local/remote authentication values in `pg_hba.conf`; the production recommendation is `peer` + `scram-sha-256` |
| `--data-checksums` | Data page checksums, used to detect storage-level corruption. Disabled by default; enabling it later requires downtime and `pg_checksums` (PG 12+); from PG 18 on, new clusters enable it by default |
| `--wal-segsize` | WAL segment size, default 16MB; raising it on high-write instances reduces segment switches (PG 11+, a power of 2 between 1 and 1024, in MB) |
| `--pwfile` | Sets an initial password for the `postgres` user non-interactively; essential for scripted initialization |

From PG 15 you can also use `--locale-provider=icu` to switch to ICU collation rules, with more consistent behavior across platforms.

## PGDATA directory structure

```plaintext
PGDATA/
├── PG_VERSION            # major version number (contents are literally "17"); refuses to start if the version doesn't match
├── postgresql.conf       # main configuration (Debian packages move this to /etc; see below)
├── postgresql.auto.conf  # where ALTER SYSTEM writes; loaded last, highest priority
├── pg_hba.conf           # client authentication rules
├── postmaster.pid        # exists only while the instance is running: PID, port, start time
├── base/                 # one subdirectory per database (directory name = database OID); tables and index files live here
├── global/               # cluster-level shared metadata (pg_database, pg_authid, etc.)
├── pg_wal/               # WAL segment files — the lifeline for crash recovery and replication
├── pg_xact/              # transaction commit status (called pg_clog before PG 10)
├── pg_stat/              # persisted statistics files; the adjacent pg_stat_tmp/ holds runtime temporary statistics
├── pg_replslot/          # replication slot metadata, one directory per slot
├── pg_tblspc/            # tablespace symlinks pointing to the actual directories outside PGDATA
└── pg_multixact/, pg_subtrans/ etc.
```

A few key points:

- `base/<database-OID>/<relfilenode>` are the physical files for tables and indexes; a single file over 1GB is split into multiple segment files with suffixes. To find where a given table actually lands on disk:

```sql
SELECT pg_relation_filepath('orders');
```

- Reserve ample space for `pg_wal`, or mount it on a separate disk: a disconnected replication slot or a stuck WAL archive lets `pg_wal` grow without bound — the most common cause of a full disk.
- Copying a running PGDATA directly with `cp` yields an unusable copy; a complete directory-level copy must go through physical backup + WAL archiving — see [Physical Backup and PITR](./physical-backup-and-pitr).
- Backing up PGDATA itself is the idea behind a physical backup, but a manual copy doesn't substitute for archiving, for the reasons above.

## Multi-version coexistence and package layout

Debian/Ubuntu manage multiple versions via postgresql-common; each version can have multiple "cluster instances" (default instance name `main`):

```plaintext
/usr/lib/postgresql/17/bin/        # binaries for each version
/etc/postgresql/17/main/           # configuration files (postgresql.conf, pg_hba.conf, conf.d/)
/var/lib/postgresql/17/main/       # PGDATA
/var/log/postgresql/               # default log directory
```

```bash
pg_lsclusters                      # list all versions and instances with their status, port, and data directory
pg_ctlcluster 17 main start        # start/stop by version + instance name
sudo -u postgres /usr/lib/postgresql/17/bin/psql   # use a specific version's client directly

# /usr/bin/psql is a wrapper that defaults to the newest installed version; watch version matching when using multiple versions
psql --version
```

Note that Debian's layout moves the configuration out of PGDATA into `/etc`. During streaming replication, `pg_basebackup` only copies PGDATA, so you must prepare the standby's `postgresql.conf`/`pg_hba.conf` yourself (`postgresql.auto.conf` lives inside PGDATA and comes along with the backup).

RHEL-family (PGDG packages) does not split the configuration; the layout is closer to the upstream default:

```plaintext
/usr/pgsql-17/bin/                 # binaries, not in PATH by default
/var/lib/pgsql/17/data/            # PGDATA; configuration files are in here
```

The service name is `postgresql-17`; multiple versions coexist through different service names and ports.

## `postgresql.conf` and the `conf.d` split

PGDG-family distribution packages include a line `include_dir = 'conf.d'` at the end of `postgresql.conf` by default (Debian: `/etc/postgresql/17/main/conf.d/`). Put all of your tuning in separate files under conf.d rather than editing the main file directly — the main file may be overwritten or conflict when you upgrade the package.

```plaintext
# /etc/postgresql/17/main/conf.d/99-tuning.conf
max_connections = 200
shared_buffers = '4GB'
effective_cache_size = '12GB'
work_mem = '32MB'
```

```bash
# reload after editing to apply (only parameters with context "postmaster" need a restart)
sudo systemctl reload postgresql@17-main

# confirm the current value, source file, and source type of a parameter
sudo -u postgres psql -c "SELECT name, setting, source, sourcefile
  FROM pg_settings WHERE name IN ('shared_buffers','max_connections');"
```

Priority: `postgresql.auto.conf` (written by `ALTER SYSTEM`) is always loaded last and overrides everything it includes. If you changed a parameter under conf.d but it "doesn't take effect," it's usually an old value left by `ALTER SYSTEM` overriding it — query the `source` column of `pg_settings` as above to pinpoint it.

## systemd units and logging

```bash
# Debian/Ubuntu: one unit per instance, plus an aggregate unit
systemctl status postgresql@17-main
journalctl -u postgresql@17-main -n 100
tail -f /var/log/postgresql/postgresql-17-main.log   # default log file from the package

# RHEL-family
systemctl status postgresql-17
tail -f /var/lib/pgsql/17/data/log/postgresql-*.log  # default logging_collector=on
```

In production, make the logging outlet explicit: either hand logs to journald for centralized collection, or turn on `logging_collector` to write to disk and have filebeat/vector collect them; also set `log_min_duration_statement` (e.g. `1s`) to record slow queries in the log — an important complement beyond `pg_stat_statements`.

## Caveats and common pitfalls

- **Running initdb as root fails outright**: switch to the postgres system user (or the corresponding user inside a container).
- **Changing locale after creation is expensive**: a libc locale change requires `REINDEX` on all affected indexes; when problems arise, first check `SELECT datcollate FROM pg_database;`.
- **Checksums are off by default**: if you don't enable `--data-checksums` at creation time, you have to enable it later with downtime — many teams therefore never enable it.
- **Bumping `PG_VERSION` is not an upgrade**: major version upgrades go through pg_upgrade / logical replication / dump-restore — see [Version Upgrades](./version-upgrade).
- **Stale postmaster.pid**: after a machine power loss, an old pid file may remain in the directory; a normal start cleans it up on its own. If you get a "pre-existing shared memory block" error, confirm first that no old process is actually running before you touch anything — don't just delete the file.
- **psql and server version mismatch under multiple versions**: a client older than the server is missing features and can even behave differently; in scripts, prefer the full path or use the wrapper to confirm the version.

## Further reading

- [PostgreSQL official docs · Chapter 25. Backup and Restore](https://www.postgresql.org/docs/current/backup.html)
- [PostgreSQL official docs · Chapter 19. Server Configuration](https://www.postgresql.org/docs/current/runtime-config.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Install and First Connection](../basics/install-and-quickstart)
- [Process Architecture](../internals/process-architecture)
- [Physical Backup and PITR](./physical-backup-and-pitr)
- [Version Upgrades](./version-upgrade)
- [backup-strategy](backup-strategy.md)
- [cloud-native-and-containers](cloud-native-and-containers.md)
- [index](index.md)
- [version-upgrade](version-upgrade.md)
