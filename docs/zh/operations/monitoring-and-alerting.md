# 监控告警

PostgreSQL 监控要回答的问题不是「进程活着吗」，而是「连接还有没有余量、事务是不是卡住了、vacuum 跟不跟得上、复制有没有落后、磁盘还剩多少」。这些问题分别对应不同子系统的饱和度指标，按层组织比按表组织更容易定位问题。采集端通常用 postgres_exporter + Prometheus，本文的 PromQL 表达式可直接抄。

## 关键指标分层

### 连接层

连接饱和度最直观，`max_connections` 打满后新连接直接被拒。

```sql
SELECT count(*) AS total,
       count(*) FILTER (WHERE state = 'active') AS active,
       count(*) FILTER (WHERE state = 'idle')   AS idle,
       count(*) FILTER (WHERE wait_event_type = 'Lock') AS waiting_locks
FROM pg_stat_activity;
```

### 查询层

慢查询数和最长事务时间是两类独立的信号：前者影响用户体验，后者是 vacuum 延迟和锁冲突的源头。

```sql
-- 最长事务（含 idle in transaction），单位秒
SELECT now() - xact_start AS xact_age, pid, usename, state, query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
ORDER BY xact_age DESC LIMIT 5;

-- 超过阈值的慢查询数（结合 log_min_duration_statement 与日志侧统计互补）
SELECT count(*) FROM pg_stat_activity
WHERE state = 'active' AND now() - query_start > interval '5 seconds';
```

### vacuum 层

dead ratio 高说明表在膨胀，xid age 逼近 20 亿是数据丢失级别的事故红线（见 [vacuum 与 HOT](/zh/internals/vacuum-and-hot)）。

```sql
-- 死元组占比
SELECT relname, n_dead_tup, n_live_tup,
       round(n_dead_tup * 100.0 / greatest(n_live_tup, 1), 1) AS dead_pct
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC LIMIT 10;

-- xid 年龄，警告线 2 亿（0.2 * 2147483648）
SELECT datname, age(datfrozenxid) AS xid_age
FROM pg_database ORDER BY xid_age DESC;

-- 单表层面的冻结进度
SELECT relname, age(relfrozenxid) FROM pg_class
WHERE relkind = 'r' ORDER BY 2 DESC LIMIT 10;
```

### 复制层

lag 有字节和时间两个视角，slot 滞后直接关联磁盘占用。

```sql
-- 字节 lag 与时间 lag
SELECT application_name, state, sync_state,
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS replay_lag_bytes,
       replay_lag
FROM pg_stat_replication;

-- 复制槽滞后（inactive 槽尤其危险，会一直持有 WAL）
SELECT slot_name, active, restart_lsn,
       pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained_bytes
FROM pg_replication_slots;
```

### 磁盘层

`pg_wal` 目录、表空间、归档目录三处都要盯，任何一处满盘都会导致停写或实例崩溃。

```sql
SELECT pg_database.datname,
       pg_size_pretty(pg_database_size(pg_database.datname)) AS size
FROM pg_database ORDER BY pg_database_size(pg_database.datname) DESC;

-- 单表占用 top（配合表空间容量告警）
SELECT relname, pg_size_pretty(pg_total_relation_size(oid))
FROM pg_class WHERE relkind = 'r'
ORDER BY pg_total_relation_size(oid) DESC LIMIT 10;
```

### 缓存命中率

`blks_hit / (blks_hit + blks_read)` 反映 shared_buffers 是否够用，稳定低于 95% 通常意味着内存不足或工作集太大。它是趋势指标，不是实时告警指标。

```sql
SELECT round(blks_hit * 100.0 / greatest(blks_hit + blks_read, 1), 2) AS hit_pct
FROM pg_stat_database WHERE datname = current_database();
```

## postgres_exporter 与 PromQL 告警

postgres_exporter 通过 SQL 采集上述指标，暴露为 `pg_stat_activity_*`、`pg_replication_lag`、`pg_database_size_*` 等系列。常用告警表达式：

```yaml
# 连接饱和度 > 85%
- alert: PgConnectionsSaturated
  expr: sum(pg_stat_activity_count) / pg_settings_max_connections > 0.85
  for: 5m

# 最长事务超过 30 分钟
- alert: PgLongTransaction
  expr: max(pg_stat_activity_max_tx_duration) > 1800
  for: 5m

# xid 年龄超过 2 亿
- alert: PgXidAgeHigh
  expr: max(pg_stat_database_age) > 200000000
  for: 5m

# 复制落后超过 10MB 或 5 分钟
- alert: PgReplicationLag
  expr: pg_replication_lag > 10485760
  for: 5m

# 复制槽保留 WAL 超过 2GB
- alert: PgSlotRetainedWal
  expr: pg_replication_slots_pg_wal_lsn_diff_restart > 2147483648
  for: 10m

# 实例宕机
- alert: PgDown
  expr: pg_up == 0
  for: 1m
```

不同 exporter 版本的指标名略有出入，落地时以 postgres_exporter 实际暴露的指标为准（用 `curl localhost:9187/metrics` 核对）。

## 日志监控

指标之外，日志侧有两类信息指标覆盖不了：

```plaintext
# postgresql.conf
log_min_duration_statement = 1000    # 超过 1 秒的语句记入日志
log_lock_waits = on                  # 锁等待超过 deadlock_timeout 时记录
log_checkpoints = on                 # checkpoint 行为可观测（PG 15 起信息更全）
log_autovacuum_min_duration = 10s    # 记录 autovacuum 动作，便于判断是否够用
```

- 慢查询日志用 `pgBadger` 或日志平台的聚合统计，能看到指标上看不到的具体 SQL。
- `log_lock_waits = on` 配合 `deadlock_timeout`（默认 1s），把每次长锁等待写成日志行，是排查锁问题的第一手资料（见 [锁冲突排查](/zh/internals/lock-conflict-troubleshooting)）。
- 归档失败、checkpoint 耗时突增、WAL 段堆积也会先出现在日志里，日志告警和指标告警要配套。

## 告警分级建议

| 级别 | 触发条件示例 | 响应要求 |
| --- | --- | --- |
| P0 电话/短信 | 实例宕机、连接打满、磁盘剩余 < 10%、xid age > 10 亿 | 立即响应 |
| P1 IM 告警 | 复制中断、slot 滞留 > 5GB、dead ratio > 40% 的核心表、PITR 失败 | 工作时间 1 小时内 |
| P2 邮件/日报 | 慢查询数趋势上升、命中率下滑、表膨胀进入 top10 | 日报复盘处理 |

分级的原则：P0 只留「现在不处理业务就会受损」的事件，其余下沉到 P1/P2，避免告警疲劳。

## 参考资料

- [PostgreSQL 官方文档 · 27.2. The Cumulative Statistics System](https://www.postgresql.org/docs/current/monitoring-stats.html)
- [PostgreSQL 官方文档 · 19.8. Error Reporting and Logging](https://www.postgresql.org/docs/current/runtime-config-logging.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [psql-meta-command-reference](/zh/appendix/psql-meta-command-reference)
- [index-bloat-and-maintenance](/zh/indexing/index-bloat-and-maintenance)
- [logical-replication-internals](/zh/internals/logical-replication-internals)
- [pg-stat-observation](/zh/internals/pg-stat-observation)
- [snapshot-and-visibility](/zh/internals/snapshot-and-visibility)
- [cloud-native-and-containers](/zh/operations/cloud-native-and-containers)
- [disaster-recovery-drills](/zh/operations/disaster-recovery-drills)
- [index](/zh/operations/index)
- [ops-sop](/zh/operations/ops-sop)
- [pg-stat-statements](/zh/performance/pg-stat-statements)
- [slow-query-governance](/zh/performance/slow-query-governance)
- [vacuum-stall-and-performance](/zh/performance/vacuum-stall-and-performance)
- [audit](/zh/security/audit)
- [ssl-and-transport-encryption](/zh/security/ssl-and-transport-encryption)- [pg_stat 观测](/zh/internals/pg-stat-observation)——各统计视图的字段含义。
- [vacuum 停滞与性能](/zh/performance/vacuum-stall-and-performance)——dead ratio 与 xid age 的处置手段。
- [监控与巡检 SOP](/zh/operations/ops-sop)——告警之外的日常巡检 SQL。
- [锁冲突排查](/zh/internals/lock-conflict-troubleshooting)——log_lock_waits 的分析方法。

官方文档：<https://www.postgresql.org/docs/current/monitoring-stats.html> 与 <https://www.postgresql.org/docs/current/runtime-config-logging.html>
