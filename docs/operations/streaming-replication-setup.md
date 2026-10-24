# Setting Up Streaming Replication

The streaming replication transport path, the semantics of `synchronous_commit`, and conflict handling on standbys are covered in the internals chapter ([Streaming Replication and Synchronous Replication](../internals/streaming-replication-and-sync)). Here is a reusable setup procedure: allow replication on the primary, bring up the standby with `pg_basebackup`, use replication slots to govern WAL retention, and finally read the two observability views.

## Preparing the primary

```sql
-- wal_level defaults to replica already; just confirm it; max_wal_senders defaults to 10 in PG 16/17
SHOW wal_level;
SHOW max_wal_senders;

-- dedicated replication account: least privilege, REPLICATION + LOGIN only
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'use a strong password';
```

```plaintext
# /etc/postgresql/17/main/conf.d/99-replication.conf (or postgresql.conf)
wal_level = replica
max_wal_senders = 10        # shared quota for streaming replication connections + concurrent basebackups
max_replication_slots = 10
listen_addresses = '*'

# pg_hba.conf: allow physical replication connections by subnet (the replication pseudo-database)
host  replication  replicator  10.0.0.0/24  scram-sha-256
```

```bash
# the above parameters and pg_hba all take effect on reload, no restart needed
sudo systemctl reload postgresql@17-main
```

## Bringing up the standby with pg_basebackup

Run this on the standby machine (it must already have the same or a higher minor version installed, with an empty data directory):

```bash
sudo -u postgres pg_basebackup \
  -h 10.0.0.11 -p 5432 -U replicator \
  -D /var/lib/postgresql/17/main \
  -X stream -C -S standby_1 -P -R
# it will prompt for the replicator password; in automated environments use ~/.pgpass instead
```

What the options mean:

- `-X stream`: pull WAL in streaming fashion during the backup rather than relying on complete archiving on the primary (this has been the default since PG 13).
- `-C -S standby_1`: also create a physical replication slot named `standby_1` on the primary.
- `-R`: write a `standby.signal` marker file on the standby and record the connection information in `postgresql.auto.conf`.
- `-P`: show progress.

Once it completes, the key contents in the standby's PGDATA:

```plaintext
standby.signal              # empty marker file; its presence means start in standby mode (PG 12+, replacing the old recovery.conf)
postgresql.auto.conf        # pg_basebackup -R writes the following two lines automatically:
#   primary_conninfo = 'host=10.0.0.11 port=5432 user=replicator ... application_name=standby_1'
#   primary_slot_name = 'standby_1'
```

```bash
sudo systemctl start postgresql@17-main
# once the log shows "database system is ready to accept read-only connections", it's ready
```

The password is left in plaintext in `postgresql.auto.conf`, so watch that file's permissions (default 0600); a cleaner approach is to put the password in `~postgres/.pgpass` and omit the password entry from `primary_conninfo`. Versions before PG 12 put this configuration in `recovery.conf`, so watch out for that when reading older material.

## Replication slots and WAL retention

- **Physical replication slots**: the primary remembers "how far each standby has acknowledged," and never deletes unacknowledged WAL. A briefly disconnected standby can resume and catch up after restarting — this is the production standard.
- **The cost**: while a standby is unreachable, the primary's `pg_wal` keeps accumulating until the disk fills up and the primary's writes crash. This is the most common incident in streaming replication operations.
- **The backstop**: `max_slot_wal_keep_size` (PG 13+) caps the WAL retained per slot; past the limit the slot is marked `lost` and the standby must be rebuilt — the disk is safe, at the cost of redoing a standby that was unreachable for too long.
- **Alternative without slots**: `wal_keep_size` (how much extra WAL the primary keeps unconditionally; default 0). Simple to configure but a weaker guarantee: under write spikes the standby may not have caught up before old WAL is already recycled, leaving only archiving recovery or a rebuild.

```sql
-- primary side: slot state and health
SELECT slot_name, active, restart_lsn,
       retained_wal, wal_status
FROM pg_replication_slots;

-- after fully decommissioning a standby, remember to drop the slot, or WAL is never reclaimed
SELECT pg_drop_replication_slot('standby_1');
```

## Observability views

**`pg_stat_replication` on the primary side**: one row per walsender connection, and the first observation point for primary-standby lag.

```sql
SELECT client_addr, application_name, state, sync_state,
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS replay_lag_bytes,
       write_lag, flush_lag, replay_lag
FROM pg_stat_replication;
```

- `state = streaming` is normal; `replay_lag_bytes` is a byte difference (relative to `pg_current_wal_lsn()`), and `replay_lag` is a time difference.
- `sync_state` shows `sync` / `quorum` / `potential` / `async` when `synchronous_standby_names` is configured.

**`pg_stat_wal_receiver` on the standby side**: the receiver process's viewpoint; `status = streaming` is normal, and `last_msg_send_time` not updating for a long time means the upstream heartbeat is broken. On both sides, build monitoring and alerting on `pg_wal_lsn_diff` and lag time rather than only on whether a connection exists.

## A glimpse at cascading replication

A standby can act as the upstream for lower-level standbys: allow `replication` connections in the middle-tier standby's `pg_hba.conf` as well, and point the downstream `pg_basebackup -h` straight at the standby — WAL is forwarded by the upstream standby's walsender. Use cases: when there are multiple standbys, shift fan-out pressure away from the primary onto a middle tier; when deploying across data centers, use a local relay to cut private-line traffic. Note that the replication slot is created on the direct upstream (an upstream standby can also hold physical slots), and a middle tier going unreachable blocks its own upstream just as much — the `max_slot_wal_keep_size` backstop logic applies at every tier.

## Caveats and common pitfalls

- **A lost slot is the number-one cause of a full `pg_wal` disk**: decommissioning a standby requires dropping its slot; monitor `retained_wal` and disk watermarks for long-lived standbys.
- **Standbys are read-only**: running a write operation on a standby and getting `cannot execute INSERT in a read-only transaction` is normal behavior — read-write splitting has to be routed at the application or middleware layer.
- **Version direction**: a standby's version must not be lower than the primary's; for minor version upgrades, upgrade the standby first and the primary second. Major version upgrades take a different path — see [Version Upgrades](./version-upgrade).
- **`synchronous_commit = on` without `synchronous_standby_names`** configured won't wait for any standby at all — don't assume you've turned on synchronous replication.
- **Firewall direction**: the standby is the one initiating connections to the primary's 5432, so security groups must allow traffic in the standby → primary direction.
- **Set `application_name`** (include it in `primary_conninfo`): it's what `synchronous_standby_names` and monitoring use to identify a standby, and the default value carries no instance identifier.

## Further reading

- [PostgreSQL official docs · Chapter 25. Backup and Restore](https://www.postgresql.org/docs/current/backup.html)
- [PostgreSQL official docs · Chapter 19. Server Configuration](https://www.postgresql.org/docs/current/runtime-config.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Streaming Replication and Synchronous Replication](../internals/streaming-replication-and-sync)
- [WAL Mechanics](../internals/wal-mechanism)
- [High Availability Architectures](./high-availability-architecture)
- [Physical Backup and PITR](./physical-backup-and-pitr)
- [streaming-replication-and-sync](/internals/streaming-replication-and-sync.md)
- [knowledge](/knowledge.md)
- [high-availability-architecture](high-availability-architecture.md)
- [index](index.md)
- [ops-sop](ops-sop.md)
