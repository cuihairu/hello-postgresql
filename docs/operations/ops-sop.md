# Ops SOPs

The value of an SOP is turning "experience an expert holds in their head" into "steps any on-call person can follow." This article covers six categories: daily inspection, change management, backup verification, index maintenance, retention policy, and incident response. Scripts can be dropped straight into an inspection platform to run on a schedule.

## Daily inspection checklist

Run once a day (or per shift); report only the anomalous items — nobody needs to look when everything is normal:

```sql
-- 1. connection headroom: warn above 85% utilization
SELECT count(*) AS total,
       current_setting('max_connections')::int AS max_conn,
       round(count(*) * 100.0 / current_setting('max_connections')::int, 1) AS pct
FROM pg_stat_activity;

-- 2. long transactions: anything over 30 minutes needs human confirmation
SELECT pid, usename, state, now() - xact_start AS xact_age, left(query, 60) AS query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL AND now() - xact_start > interval '30 minutes'
ORDER BY xact_age DESC;

-- 3. dead ratio top 10: log anything over 30%
SELECT relname, n_live_tup, n_dead_tup,
       round(n_dead_tup * 100.0 / greatest(n_live_tup + n_dead_tup, 1), 1) AS dead_pct
FROM pg_stat_user_tables
WHERE n_live_tup + n_dead_tup > 10000
ORDER BY dead_pct DESC LIMIT 10;

-- 4. xid age: alert above 200 million
SELECT datname, age(datfrozenxid) AS xid_age
FROM pg_database ORDER BY xid_age DESC;

-- 5. replication lag and invalidated slots
SELECT application_name, state,
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS lag_bytes,
       replay_lag
FROM pg_stat_replication;
SELECT slot_name, active,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained
FROM pg_replication_slots;

-- 6. disk (instance-side view): data directory and pg_wal partition usage
-- in an inspection script, get it via shell instead: df -h $PGDATA $PGDATA/pg_wal
```

Don't just post inspection results to a chat group — anomalous items have to be turned into tickets so they get closed out.

## Change SOP

All DDL goes through a review process, with review focused on four things: lock impact, table size, rollback plan, and execution window.

- **Lock timeout protection**: for any ALTER TABLE or add-constraint statement, set `lock_timeout` first so it fails fast if it can't get the lock, avoiding a queue backup of everything downstream (see [Lock System](../internals/lock-system)).

```sql
-- give up after 3 seconds if the lock can't be acquired; retry is left to a person or a script
SET lock_timeout = '3s';
ALTER TABLE orders ADD COLUMN channel text;
RESET lock_timeout;
```

- **Adding indexes to large tables**: always use `CONCURRENTLY`. A failure leaves an INVALID index behind that you must drop and rebuild:

```sql
CREATE INDEX CONCURRENTLY idx_orders_created_at ON orders (created_at);
-- cleanup after a failure:
DROP INDEX CONCURRENTLY idx_orders_created_at;
```

- **Adding a NOT NULL column / changing a column type**: PG 11+ no longer rewrites the whole table when adding a column with a default; changing a type can still rewrite the table and its indexes, so large tables must be assessed.
- **Execution window**: put changes that take an ACCESS EXCLUSIVE lock in the low-traffic window; `CONCURRENTLY` can't run inside a transaction.
- **Rollback plan**: write the reverse SQL before executing. The rollback for adding a column is `DROP COLUMN`, but the rollback for dropping a column depends on a backup — the two costs are entirely different, and the review has to distinguish them.
- Observe slow changes from the side with `pg_stat_activity` and use `pg_cancel_backend(pid)` to bail out if needed (see [Lock Conflict Troubleshooting](../internals/lock-conflict-troubleshooting)).

## Backup verification SOP

A backup that has never been restored is not really a backup. Run a full restore drill once a month:

1. Take the most recent base backup + its WAL archive and restore to a temporary instance (steps in [Physical Backup and PITR](./physical-backup-and-pitr)).
2. After restoring, run smoke checks: table count, row counts on key tables, and the timestamp of the latest business record.
3. Record the actual elapsed time (measured RTO) and data freshness (measured RPO), and compare against the expected SLA.
4. Verify logical backups (pg_dump) separately with sampling: restore into a temporary database and run read-only checks for key business flows.
5. File a bug the same day if a drill fails, with the owner given a deadline to fix it; the backup retention policy may only be adjusted after two consecutive months of passing drills.

## Index maintenance SOP

Run an index health check once a quarter:

```sql
-- indexes never used (idx_scan = 0 since the last statistics reset)
SELECT schemaname, relname, indexrelname, idx_scan,
       pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE idx_scan = 0 AND NOT indisprimary
ORDER BY pg_relation_size(indexrelid) DESC;

-- also check for INVALID indexes (leftovers from CONCURRENTLY failures)
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
```

Handling rules:

- Large indexes with `idx_scan = 0` get marked for observation for one quarter first; only `DROP INDEX CONCURRENTLY` them after confirming across a business peak that they're unused. Note that statistics reset to zero after an instance restart, so judge with `pg_stat_statements` in combination.
- Primary key and unique constraint indexes are never candidates for cleanup.
- Index bloat (an obviously abnormal size-to-row-count ratio) goes into the REINDEX CONCURRENTLY schedule (see [Index Bloat and Maintenance](../indexing/index-bloat-and-maintenance)).

## Retention policy

- **WAL archive**: retention length is determined by PITR needs, commonly 7~30 days. The cleanup basis is segment files that are "already backed up and past their retention period" — compare against the remote archive manifest when deleting locally, and never delete blindly by filename date. Archive cleanup links to the base backup cycle: within the retention period there must be a complete base backup available as a starting point.
- **Base backups**: keep at least the "last 2 complete backups," to avoid the situation where the previous backup has already been cleaned up while a restore is in progress. Long-term compliance requirements are separate.
- **Old backup cleanup**: put the cleanup action in scripts + a confirmation checklist; manual `rm` is forbidden; run an "archive restorable" spot check after cleaning.
- **Logical backups**: daily backups kept 7 days, weekly kept 1 month, monthly kept 1 year is a common starting point, adjusted to business compliance requirements.
- **Replication slots**: for decommissioned subscriptions or spare standbys, drop the slot the same day to avoid long-term WAL retention (see [Setting Up Streaming Replication](./streaming-replication-setup)).

## Incident response template

Fill this out within 48 hours of an incident and archive it to the team knowledge base:

```markdown
## Incident report: <title>
- Timeline:
  - 14:02 monitoring alert PgDown fired
  - 14:05 on-call confirmed the instance was down and started responding
  - 14:18 standby promoted to primary, business recovered
- Impact: order service writes failed for 16 minutes, about xx orders backed up, no data loss
- Root cause: the pg_wal partition was filled by 180GB of WAL retained by an invalidated replication slot, causing the instance to PANIC
- Why it wasn't caught earlier: slot retention monitoring was missing (alert rule misconfigured)
- Action items:
  1. [P0] add slot retention alerts — owner: xxx — due xx-xx
  2. [P1] drop the abandoned slot rep_dead — owner: xxx — due xx-xx
  3. [P2] add disk-full response to the quarterly drill — owner: xxx — due xx-xx
```

Key points: timeline precise to the minute, impact quantified in business terms, and every Action item has an owner and a deadline. The value of an incident report lies in the closure rate of its Action items — writing one nobody follows up on is the same as not writing it.

## Further reading

- [PostgreSQL official docs · Chapter 24. Routine Database Maintenance Tasks](https://www.postgresql.org/docs/current/maintenance.html)
- [PostgreSQL official docs · 27.2. The Cumulative Statistics System](https://www.postgresql.org/docs/current/monitoring-stats.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [disaster-recovery-drills](disaster-recovery-drills.md)
- [index](index.md)
- [logical-replication-ops](logical-replication-ops.md)
- [monitoring-and-alerting](monitoring-and-alerting.md)- [Monitoring and Alerting](./monitoring-and-alerting) — turning inspection metrics into alerts.
- [Physical Backup and PITR](./physical-backup-and-pitr) — the operational steps behind the backup verification SOP.
- [Disaster Recovery Drills](./disaster-recovery-drills) — handling details for incident scenarios.
- [Backup Strategy](./backup-strategy) — the backup-side design of the retention policy.

Official docs: <https://www.postgresql.org/docs/current/maintenance.html> and <https://www.postgresql.org/docs/current/monitoring-stats.html>
