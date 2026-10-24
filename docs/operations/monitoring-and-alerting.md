# Monitoring and Alerting

The questions PostgreSQL monitoring has to answer aren't "is the process alive" but "is there connection headroom left, are transactions stuck, is vacuum keeping up, is replication lagging, how much disk is left." Each of those maps to a saturation metric from a different subsystem, and organizing by layer makes problems easier to localize than organizing by table. The collection side typically uses postgres_exporter + Prometheus; the PromQL expressions in this article can be copied directly.

## Key metrics by layer

### Connection layer

Connection saturation is the most visible signal; once `max_connections` is full, new connections are rejected outright.

```sql
SELECT count(*) AS total,
       count(*) FILTER (WHERE state = 'active') AS active,
       count(*) FILTER (WHERE state = 'idle')   AS idle,
       count(*) FILTER (WHERE wait_event_type = 'Lock') AS waiting_locks
FROM pg_stat_activity;
```

### Query layer

Slow query counts and longest transaction durations are two independent signals: the former affects user experience, the latter is the source of vacuum lag and lock contention.

```sql
-- longest transactions (including idle in transaction), in seconds
SELECT now() - xact_start AS xact_age, pid, usename, state, query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
ORDER BY xact_age DESC LIMIT 5;

-- slow queries past a threshold (combine with log_min_duration_statement and log-side statistics for complementary coverage)
SELECT count(*) FROM pg_stat_activity
WHERE state = 'active' AND now() - query_start > interval '5 seconds';
```

### Vacuum layer

A high dead ratio means tables are bloating, and xid age approaching 2 billion is a data-loss-class incident red line (see [Vacuum and HOT](../internals/vacuum-and-hot)).

```sql
-- dead tuple ratio
SELECT relname, n_dead_tup, n_live_tup,
       round(n_dead_tup * 100.0 / greatest(n_live_tup, 1), 1) AS dead_pct
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC LIMIT 10;

-- xid age; the warning line is 200 million (0.2 * 2147483648)
SELECT datname, age(datfrozenxid) AS xid_age
FROM pg_database ORDER BY xid_age DESC;

-- per-table freezing progress
SELECT relname, age(relfrozenxid) FROM pg_class
WHERE relkind = 'r' ORDER BY 2 DESC LIMIT 10;
```

### Replication layer

Lag has two viewpoints, bytes and time, and slot lag ties directly to disk usage.

```sql
-- byte lag and time lag
SELECT application_name, state, sync_state,
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS replay_lag_bytes,
       replay_lag
FROM pg_stat_replication;

-- replication slot lag (inactive slots are especially dangerous, since they keep holding WAL)
SELECT slot_name, active, restart_lsn,
       pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained_bytes
FROM pg_replication_slots;
```

### Disk layer

Watch three places: the `pg_wal` directory, tablespaces, and the archive directory. A full disk in any of them causes writes to stop or the instance to crash.

```sql
SELECT pg_database.datname,
       pg_size_pretty(pg_database_size(pg_database.datname)) AS size
FROM pg_database ORDER BY pg_database_size(pg_database.datname) DESC;

-- top consumers per table (pair with tablespace capacity alerts)
SELECT relname, pg_size_pretty(pg_total_relation_size(oid))
FROM pg_class WHERE relkind = 'r'
ORDER BY pg_total_relation_size(oid) DESC LIMIT 10;
```

### Cache hit rate

`blks_hit / (blks_hit + blks_read)` reflects whether shared_buffers is large enough; sitting steadily below 95% usually means insufficient memory or a working set that is too big. It's a trend indicator, not a real-time alert indicator.

```sql
SELECT round(blks_hit * 100.0 / greatest(blks_hit + blks_read, 1), 2) AS hit_pct
FROM pg_stat_database WHERE datname = current_database();
```

## postgres_exporter and PromQL alerts

postgres_exporter collects the metrics above via SQL and exposes them as `pg_stat_activity_*`, `pg_replication_lag`, `pg_database_size_*`, and so on. Common alert expressions:

```yaml
# connection saturation > 85%
- alert: PgConnectionsSaturated
  expr: sum(pg_stat_activity_count) / pg_settings_max_connections > 0.85
  for: 5m

# longest transaction over 30 minutes
- alert: PgLongTransaction
  expr: max(pg_stat_activity_max_tx_duration) > 1800
  for: 5m

# xid age over 200 million
- alert: PgXidAgeHigh
  expr: max(pg_stat_database_age) > 200000000
  for: 5m

# replication lag over 10MB or 5 minutes
- alert: PgReplicationLag
  expr: pg_replication_lag > 10485760
  for: 5m

# replication slot retaining over 2GB of WAL
- alert: PgSlotRetainedWal
  expr: pg_replication_slots_pg_wal_lsn_diff_restart > 2147483648
  for: 10m

# instance down
- alert: PgDown
  expr: pg_up == 0
  for: 1m
```

Metric names differ slightly between exporter versions; when putting this into production, go by what postgres_exporter actually exposes (verify with `curl localhost:9187/metrics`).

## Log monitoring

Beyond metrics, there are two kinds of information on the log side that metrics can't cover:

```plaintext
# postgresql.conf
log_min_duration_statement = 1000    # log statements longer than 1 second
log_lock_waits = on                  # record when lock waits exceed deadlock_timeout
log_checkpoints = on                 # make checkpoint behavior observable (more complete info from PG 15)
log_autovacuum_min_duration = 10s    # record autovacuum activity, to judge whether it's doing enough
```

- Slow query logs analyzed with `pgBadger` or a log platform's aggregations show the specific SQL you can't see in the metrics.
- `log_lock_waits = on` combined with `deadlock_timeout` (default 1s) writes each long lock wait as a log line — first-hand material for diagnosing lock problems (see [Lock Conflict Troubleshooting](../internals/lock-conflict-troubleshooting)).
- Archive failures, sudden checkpoint duration spikes, and WAL segment pileups also show up in logs first; log alerts and metric alerts need to go together.

## Alert severity recommendations

| Severity | Example trigger conditions | Response requirement |
| --- | --- | --- |
| P0 phone/SMS | Instance down, connections full, disk remaining < 10%, xid age > 1 billion | Respond immediately |
| P1 IM alert | Replication interrupted, slot retention > 5GB, dead ratio > 40% on a core table, PITR failure | Within 1 hour during business hours |
| P2 email/daily report | Slow query count trending up, hit rate declining, table bloat entering the top 10 | Review and handle in the daily report |

The principle for tiering: keep only "the business will suffer if this isn't handled now" events at P0, and push the rest down to P1/P2 to avoid alert fatigue.

## Further reading

- [PostgreSQL official docs · 27.2. The Cumulative Statistics System](https://www.postgresql.org/docs/current/monitoring-stats.html)
- [PostgreSQL official docs · 19.8. Error Reporting and Logging](https://www.postgresql.org/docs/current/runtime-config-logging.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [psql-meta-command-reference](/appendix/psql-meta-command-reference.md)
- [index-bloat-and-maintenance](/indexing/index-bloat-and-maintenance.md)
- [logical-replication-internals](/internals/logical-replication-internals.md)
- [pg-stat-observation](/internals/pg-stat-observation.md)
- [snapshot-and-visibility](/internals/snapshot-and-visibility.md)
- [cloud-native-and-containers](cloud-native-and-containers.md)
- [disaster-recovery-drills](disaster-recovery-drills.md)
- [index](index.md)
- [ops-sop](ops-sop.md)
- [pg-stat-statements](/performance/pg-stat-statements.md)
- [slow-query-governance](/performance/slow-query-governance.md)
- [vacuum-stall-and-performance](/performance/vacuum-stall-and-performance.md)
- [audit](/security/audit.md)
- [ssl-and-transport-encryption](/security/ssl-and-transport-encryption.md)- [pg_stat Observation](../internals/pg-stat-observation) — the field meanings of each statistics view.
- [Vacuum Stalls and Performance](../performance/vacuum-stall-and-performance) — how to handle dead ratio and xid age.
- [Monitoring and Inspection SOPs](./ops-sop) — the day-to-day inspection SQL beyond alerts.
- [Lock Conflict Troubleshooting](../internals/lock-conflict-troubleshooting) — how to analyze log_lock_waits.

Official docs: <https://www.postgresql.org/docs/current/monitoring-stats.html> and <https://www.postgresql.org/docs/current/runtime-config-logging.html>
