# Physical Backup and PITR

A physical backup is "copy the entire data directory," and combined with WAL archiving it can restore the cluster to any given second in the past — that's PITR (Point-In-Time Recovery). Because it restores the data itself, it holds up against dropped tables, accidental DROPs, and logical errors; the cost is that you need dedicated archive storage and you have to drill it regularly. A logical backup (pg_dump) can only restore to "the complete state at the moment of the backup" and cannot be rewound to an arbitrary point in between.

## Base backups with pg_basebackup

`pg_basebackup` connects to the primary over the replication protocol, replicating WAL in streaming fashion while it copies the data directory; the end point lands on a single consistent position, which makes it a natural fit for physical backups.

```bash
# routine backup: pull WAL via streaming, do a fast checkpoint at the end, and write out standby.signal-related config automatically
pg_basebackup -h db-host -U repuser -D /backup/full/20261012 \
  -X stream --checkpoint=fast -P -v \
  --no-slot

# use a replication slot to prevent WAL from being cleaned up during archiving (recommended for production)
pg_basebackup -h db-host -U repuser -D /backup/full/20261012 \
  -X stream --checkpoint=fast --slot basebackup_slot -P -v

# -R: write out standby.signal and the backup-related replication parameters into the backup directory, so it can be used directly as a replica or a restore starting point
pg_basebackup -h db-host -U repuser -D /backup/full/20261012 \
  -X stream -R
```

Key points:

- `-X stream` pulls WAL in real time over the replication stream, avoiding fetching segment files out of the `pg_wal` directory (segments may have just been written and not yet archived). The alternative spelling `-X fetch` copies completed segments from `pg_wal`, which suits environments where WAL archiving is already stable.
- `--checkpoint=fast` triggers a checkpoint before and after the backup, shrinking the amount of WAL one backup has to replay. The cost is a synchronous I/O spike during the checkpoint; during peak traffic you can use `--checkpoint=spread` or omit it (default spread behavior differs slightly between versions, and from PG 17 `pg_basebackup` defaults to spread checkpoints).
- The config written by `-R` lets the restored directory be used directly as a restore starting point — especially handy for a "spin up a temporary instance first, then extract data" drill.
- The backup output directory must have its target path emptied first — `pg_basebackup` requires the target directory to be empty or nonexistent.

## WAL archiving: archive_mode and archive_command

The other pillar of PITR is WAL archiving. WAL segments completed after a checkpoint are copied to a location independent of the primary's filesystem, usually to object storage or remote storage.

```plaintext
# postgresql.conf
archive_mode = on
archive_command = 'cp %p /backup/wal-archive/%f'
archive_timeout = 300      # how long to wait before forcing a WAL segment switch, in seconds
```

`archive_command`'s two placeholders: `%p` is the local path of the segment file to be archived, `%f` is the filename. PG 15 and later still use this parameter name and behavior, unchanged.

```bash
# more common in production: push to object storage, and return a non-zero exit code on failure
archive_command = 'aws s3 cp %p s3://pg-archive/wal/%f'
```

The archive command's exit code determines whether the archive succeeded, and PostgreSQL does not retry a persistently failing archive job — it can only wait for the next segment. So the archive command must be idempotent, handle the "target already exists" case, and have its failures wired into alerting.

PG 17 introduced a backup module (aggregated capabilities in the direction of `backup_fdw`, plus improvements around `pg_start_backup`); archiving itself remains the `archive_mode`/`archive_command` mechanism.

## Restoring: restore_command and recovery.signal

PITR starts from a base backup directory; the restore process pulls WAL segment by segment back out of the archive via `restore_command` and replays it until it reaches the recovery target.

```plaintext
# postgresql.conf (written in the fresh data directory used for restore)
restore_command = 'cp /backup/wal-archive/%f %p'

# pick one, or combine: restore to a point in time / an LSN / a backup label name
recovery_target_time = '2026-10-12 14:35:00+08'
# recovery_target_lsn = '0/1A3B4C50'
# recovery_target_name = 'basebackup-20261012'

# the default is pause mode: recovery pauses at the target so you can inspect and decide whether to continue or exit
# recovery_target = 'pause' | 'immediate' | 'timeline'
```

`recovery.signal` is the marker file that turns on recovery mode from PG 12 onward; it goes in the data directory:

```bash
# PG 12+: the old recovery.conf was split out; the approach is now "signal file + normal config file"
touch $PGDATA/recovery.signal
pg_ctl -D $PGDATA start
```

PG 11 and earlier used `recovery.conf`, which held `restore_command` and the recovery target on its own; from PG 12 everything moved into `postgresql.conf`, leaving only an empty `recovery.signal` as the switch. This is a common trip — a `recovery.conf` written per the old docs and dropped into a PG 12+ directory has no effect.

## A PITR drill: restoring to one second before an accidental deletion

Suppose a colleague ran `DROP TABLE orders` at 14:35:00 and the archive still holds the WAL from before that moment.

```bash
# 1. prepare a temporary data directory and restore from the base backup
sudo mkdir -p /tmp/restore && sudo chown postgres /tmp/restore
sudo -u postgres pg_basebackup -h db-host -U repuser \
  -D /tmp/restore -X stream -R -P

# 2. write the recovery configuration
cat >> /tmp/restore/postgresql.conf <<'EOF'
restore_command = 'cp /backup/wal-archive/%f %p'
recovery_target_time = '2026-10-12 14:34:50+08'
recovery_target = 'pause'
EOF

# 3. start a temporary instance on a separate port — don't touch the production instance
sudo -u postgres pg_ctl -D /tmp/restore -o "-p 5433" -l /tmp/restore.log start

# 4. watch the log to confirm the target was reached and recovery paused
tail -f /tmp/restore.log
# seeing "recovery stopping at 2026-10-12 14:34:50" or "recovery has paused" means you've arrived

# 5. verify the orders table is still there, then extract the data you need back to production
psql -p 5433 -c "\d orders"
psql -p 5433 -c "COPY orders TO STDOUT" > orders_recover.csv
```

Once verified, insert the data back into the production database and then stop the temporary instance:

```bash
sudo -u postgres pg_ctl -D /tmp/restore stop
# or continue the recovery to the latest point:
psql -p 5433 -c "SELECT pg_wal_replay_resume();"   # resume-during-recovery in PG 15+
```

"Restore into a new instance and then extract the data" is the safe PITR practice: the primary stays untouched and the blast radius is limited to the temporary instance.

## RPO and RTO

- **RPO** (tolerable data loss) is set by the archive interval. Archiving is "committed per segment," and `archive_timeout` determines "how soon to force a switch to a new segment and start archiving when the current segment isn't full." Set to 300 seconds, RPO is roughly 5 minutes plus one archive command's execution time. For a smaller RPO, lower `archive_timeout` — but archive command invocations become more frequent, and network and storage pressure rises with them.
- **RTO** (tolerable recovery time) is set by "base backup size + the amount of WAL that needs replaying." A big base backup takes time just to copy; the more WAL between two base backups, the longer the replay. So the standard approach is: the shorter the base backup period and the smaller the single replay window, the lower the RTO.
- The only way to confirm RPO/RTO are actually achievable is to drill: record the measured time of every PITR drill, and don't trust the theoretical numbers in the docs.

## Caveats and common pitfalls

- The archive directory must not live on the same disk as the data directory, and not in the same failure domain. Archiving to the same disk is equivalent to not archiving at all.
- `archive_command` must tolerate "the target file already exists." Using `cp` can be blocked by permissions or overwrite policy — use an object storage tool with `-f` or an equivalent overwrite option.
- Once archiving breaks, PostgreSQL accumulates unarchived segments in `pg_wal`, and a full disk causes the instance to PANIC and go down. Archive failures must trigger alerts.
- A restored instance is **read-only**; writes report `cannot execute in a recovery standby`. After extracting the data you need, exit recovery mode (delete `recovery.signal` and restart, or use `recovery_target = 'immediate'`).
- `recovery_target_action` defaults to pause — during a drill, seeing "recovery paused" doesn't mean it failed; that's the expected behavior after reaching the target.
- The drill environment has to be able to reach real archive files, rather than "the archive is fine, so no need to test." Run a full PITR drill at least quarterly.

## Further reading

- [PostgreSQL official docs · 25.3. Continuous Archiving and Point-in-Time Recovery (PITR)](https://www.postgresql.org/docs/current/continuous-archiving.html)
- [PostgreSQL official docs · Chapter 25. Backup and Restore](https://www.postgresql.org/docs/current/backup.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [postgresql-17-features](/ecosystem/postgresql-17-features.md)
- [wal-mechanism](/internals/wal-mechanism.md)
- [knowledge](/knowledge.md)
- [backup-strategy](backup-strategy.md)
- [cluster-init-and-layout](cluster-init-and-layout.md)
- [disaster-recovery-drills](disaster-recovery-drills.md)
- [index](index.md)
- [ops-sop](ops-sop.md)
- [streaming-replication-setup](streaming-replication-setup.md)
- [version-upgrade](version-upgrade.md)- [Backup Strategy](./backup-strategy) — the trade-offs and combinations of logical versus physical backups.
- [WAL Mechanics](../internals/wal-mechanism) — LSNs, segment files, and replay principles.
- [Disaster Recovery Drills](./disaster-recovery-drills) — the complete steps for a PITR extract-back in production.

Official docs: <https://www.postgresql.org/docs/current/continuous-archiving.html> and <https://www.postgresql.org/docs/current/backup.html>
