# Disaster Recovery Drills

Incident-handling capability can only be built through drills. Each scenario is laid out in four stages: "symptom → confirmation → response → prevention." Walk through them during a drill, and record the actual elapsed time and any deviations in the drill log — that's what gives you executable muscle memory when an incident actually happens.

## Scenario one: primary down

**Symptom**: widespread connection failures or read-only errors in the application; monitoring shows `pg_up == 0`; standby replication is broken.

**Confirmation**:

```bash
# primary process and port
ssh db-primary "pg_ctl -D $PGDATA status" || echo "primary down"
ss -lntp | grep 5432

# confirm from the standby side that replication is broken
psql -h db-standby -c "SELECT now() - pg_last_xact_replay_timestamp() AS lag;"
tail -20 $PGDATA/log/postgresql.log
```

**Response** (with an HA tool like Patroni, the tool does this automatically; the manual flow is below):

1. Confirm the primary truly can't recover (process exited, machine unreachable) rather than a network blip. Wait 1~2 probe cycles before acting.
2. Confirm on the standby that it has received all the WAL it can: `SELECT pg_last_wal_replay_lsn();`.
3. Promote the standby to primary:

```bash
# PG 12+ triggers a promotion: remove standby.signal and restart, or use a trigger file
pg_ctl -D $PGDATA promote
# or
psql -c "SELECT pg_promote();"
```

4. Disable the old primary's automatic startup (`systemctl disable postgresql`, or isolate the node) to avoid dual primaries.
5. Switch the client connection strings (DNS / config center / PgBouncer backend).
6. Once the old primary recovers, bring it back as a new standby via `pg_rewind` or a fresh base backup.

**Client behavior**: during promotion, writes report `cannot execute ... in a read-only transaction` or connection refused, typically lasting a few seconds to a few tens of seconds. Connection pools need fast-fail and health checks configured so requests don't keep hammering the old primary.

**Prevention**: an HA tool + arbitration (see [High Availability Architectures](./high-availability-architecture)); clients use a read-write splitting endpoint rather than Pod IPs directly; run a manual switchover drill every quarter.

## Scenario two: disk full

**Symptom**: writes report `No space left on device`, or the instance PANICs outright (a full `pg_wal` causes a PANIC — see [WAL Mechanics](../internals/wal-mechanism)); logs show a flood of write failures.

**Confirmation**:

```bash
df -h $PGDATA $PGDATA/pg_wal
du -sh $PGDATA/pg_wal          # is WAL usage growing abnormally
du -sh $PGDATA/base/* | sort -h | tail   # which database is bloating
```

Typical causes of `pg_wal` filling up: an invalidated replication slot (the downstream died but the slot wasn't dropped), archive failures, or `wal_keep_size` set too large on top of a write spike.

**Response** (in priority order):

```sql
-- 1. find the invalidated slots holding retained WAL, then drop them after confirming
SELECT slot_name, active, pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained
FROM pg_replication_slots;
SELECT pg_drop_replication_slot('dead_slot');

-- 2. temporarily lower the checkpoint upper limit to allow reclaimable WAL to be cleaned up
ALTER SYSTEM SET max_wal_size = '1GB';
SELECT pg_reload_conf();
SELECT pg_switch_wal();   -- force a segment switch, which clears up after a successful archive
```

3. If the archive directory is full, expand it first or clean up old segments already backed up remotely (compare against the remote manifest before deleting).
4. If the data directory is full, clean up logs and temporary files (`$PGDATA/base/pgsql_tmp`) and old core dumps first — don't delete WAL or data files directly.
5. If the instance has already PANICed: free up space and restart, letting WAL recovery bring it to a consistent state.

**Prevention**: alert at 80% disk usage, put `pg_wal` on a separate partition, monitor slot retention (see [Monitoring and Alerting](./monitoring-and-alerting)), and alert immediately on archive failures.

## Scenario three: table bloat

**Symptom**: queries get slower but the execution plan hasn't changed; table and index sizes far exceed the business data volume; `n_dead_tup` stays consistently high.

**Confirmation**:

```sql
SELECT relname, n_live_tup, n_dead_tup,
       round(n_dead_tup * 100.0 / greatest(n_live_tup + n_dead_tup, 1), 1) AS dead_pct,
       last_autovacuum
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC LIMIT 20;

-- actual disk usage vs estimated row count
SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS total_size
FROM pg_class WHERE relkind = 'r'
ORDER BY pg_total_relation_size(oid) DESC LIMIT 20;
```

**Response**:

```sql
-- the first step is always a plain VACUUM: space becomes reusable, writes aren't locked; clear the dead tuples first
VACUUM (VERBOSE, ANALYZE) big_table;

-- only use VACUUM FULL if you need the space returned to the operating system: it takes an exclusive lock, so the business must stop writing
VACUUM (FULL) big_table;

-- for index bloat use REINDEX CONCURRENTLY (PG 12+), which doesn't block writes
REINDEX INDEX CONCURRENTLY idx_big_table_owner;
```

Choosing timing: `VACUUM FULL` and `REINDEX` without `CONCURRENTLY` both take an exclusive lock, so they can only run in a maintenance window. On PG 12+ prefer `REINDEX CONCURRENTLY`, and for returning tablespace, consider online tools such as pg_repack extensions. For more on bloat governance, see [Index Bloat and Maintenance](../indexing/index-bloat-and-maintenance) and [Autovacuum Tuning](../internals/autovacuum-tuning).

**Prevention**: use more aggressive per-table parameters for autovacuum on large tables (override `autovacuum_vacuum_scale_factor` per table); reserve fillfactor on high-frequency-update tables; monitor dead ratio trends rather than waiting for users to report slowness.

## Scenario four: replication broken

**Symptom**: the corresponding row disappears from `pg_stat_replication`; the standby log reports missing WAL segments; the slot's `active = false`.

**Confirmation**:

```sql
-- primary: which slot dropped, and how much is retained
SELECT slot_name, active, restart_lsn,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained
FROM pg_replication_slots;

-- standby: which LSN it's stuck at
SELECT pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn();
tail -30 $PGDATA/log/postgresql.log   # find the specific error: segment not found? auth failure? network?
```

**Response**:

1. If you get "requested WAL segment has already been removed": the primary has already cleared the segment, and the standby can't catch up in place — it needs a rebuild.
2. Network or authentication problems: the standby will reconnect and catch up automatically once fixed, with no manual intervention needed.
3. A standby that fell too far behind, or a deleted segment: rebuild the standby from a base backup (use the `pg_basebackup -R` flow from [Physical Backup and PITR](./physical-backup-and-pitr), which is the least work).
4. A slot whose feed was just cut (a decommissioned logical subscription, an abandoned slot): after confirming no downstream depends on it, delete it with `pg_drop_replication_slot()` and release the primary's WAL retention.

**Catch-up confirmation**: after rebuilding and re-attaching, watch `SELECT now() - pg_last_xact_replay_timestamp();` converge to sub-second levels, and confirm `state = streaming` in `pg_stat_replication`.

**Prevention**: slot retention alerts; set standby `recovery_min_apply_delay` only when you need a delayed disaster recovery standby; drop slots from temporary logical subscriptions as soon as you're done with them.

## Scenario five: accidental data deletion

**Symptom**: the business reports missing data — usually a `DELETE`/`UPDATE` that was missing a WHERE clause, or an accidental `DROP TABLE`.

**Confirmation**: first get three things straight — which table, what time, roughly how many rows affected. Immediately stop writes to that table (or stop the whole database) to prevent later writes from erasing the recovery window.

**Response** (PITR extract-back, with the primary untouched):

1. Take the latest base backup from before the accidental deletion and restore it on a temporary instance up to "one second before the deletion" per the steps in [Physical Backup and PITR](./physical-backup-and-pitr).
2. After verifying the data on the temporary instance, `COPY` it out and import it back into production.
3. Keep the production database read-only or lock the table throughout, to avoid primary key conflicts during the import-back.

```bash
# fast version: bring up a temporary instance straight from the primary and extract data
# note: recovering to a point after the base backup finished still requires archived WAL;
# without archiving you can only restore to the data state at the end of pg_basebackup
pg_basebackup -h db-host -D /tmp/restore -X stream -R
cat >> /tmp/restore/postgresql.conf <<EOF
recovery_target_time = '2026-10-12 14:34:50+08'
EOF
touch /tmp/restore/recovery.signal
pg_ctl -D /tmp/restore -o "-p 5433" start
```

**Prevention**: route dangerous operations through change approval; don't grant `DROP` to application accounts (see [Roles and Permissions](../security/roles-and-permissions)); enable a delayed standby (`recovery_min_apply_delay = '1h'`) on tables with high accidental-operation risk as an "undo pill"; run a PITR drill every quarter.

## Drill frequency and records

- **Quarterly**: PITR drills, primary-standby switchover drills, backup restore verification (monthly is better — see [Ops SOPs](./ops-sop)).
- **Semi-annually**: full flows for disk-full response, replication rebuild, and accidental data deletion.
- **Record contents**: drill time, scenario, actual elapsed time per step, deviations from the docs, problems found, and the person responsible for fixes. If a drill shows a flow that doesn't work, fix the docs that day — that's where the value of a drill lies.
- Run drills in a replica environment as close to production as possible, at least at a comparable data scale — timing measured on a 10MB test database has no reference value for a 500GB database.

## Further reading

- [PostgreSQL official docs · 25.3. Continuous Archiving and Point-in-Time Recovery (PITR)](https://www.postgresql.org/docs/current/continuous-archiving.html)
- [PostgreSQL official docs · 26.2. Log-Shipping Standby Servers](https://www.postgresql.org/docs/current/warm-standby.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [knowledge](/knowledge.md)
- [backup-strategy](backup-strategy.md)
- [high-availability-architecture](high-availability-architecture.md)
- [index](index.md)
- [ops-sop](ops-sop.md)
- [physical-backup-and-pitr](physical-backup-and-pitr.md)
- [data-encryption-at-rest](/security/data-encryption-at-rest.md)- [Physical Backup and PITR](./physical-backup-and-pitr) — the complete steps for scenario five.
- [Backup Strategy](./backup-strategy) — the backup system the drills depend on.
- [Monitoring and Alerting](./monitoring-and-alerting) — how each scenario gets detected.
- [Ops SOPs](./ops-sop) — institutionalizing drill records and backup verification.

Official docs: <https://www.postgresql.org/docs/current/continuous-archiving.html> and <https://www.postgresql.org/docs/current/warm-standby.html>
