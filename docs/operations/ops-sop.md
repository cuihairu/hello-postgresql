# 运维 SOP

SOP 的意义在于把「老手脑子里的经验」变成「任何值班的人都能照着走的步骤」。本文覆盖日常巡检、变更、备份验证、索引维护、保留策略和事故响应六类，脚本可以直接放进巡检平台定时执行。

## 日常巡检清单

每天（或每班）跑一遍，输出异常项即可，全部正常不用人看：

```sql
-- 1. 连接余量：使用率超过 85% 预警
SELECT count(*) AS total,
       current_setting('max_connections')::int AS max_conn,
       round(count(*) * 100.0 / current_setting('max_connections')::int, 1) AS pct
FROM pg_stat_activity;

-- 2. 长事务：超过 30 分钟的需要人工确认
SELECT pid, usename, state, now() - xact_start AS xact_age, left(query, 60) AS query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL AND now() - xact_start > interval '30 minutes'
ORDER BY xact_age DESC;

-- 3. dead ratio top10：超过 30% 记录
SELECT relname, n_live_tup, n_dead_tup,
       round(n_dead_tup * 100.0 / greatest(n_live_tup + n_dead_tup, 1), 1) AS dead_pct
FROM pg_stat_user_tables
WHERE n_live_tup + n_dead_tup > 10000
ORDER BY dead_pct DESC LIMIT 10;

-- 4. xid age：超过 2 亿告警
SELECT datname, age(datfrozenxid) AS xid_age
FROM pg_database ORDER BY xid_age DESC;

-- 5. 复制 lag 与失效槽
SELECT application_name, state,
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS lag_bytes,
       replay_lag
FROM pg_stat_replication;
SELECT slot_name, active,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained
FROM pg_replication_slots;

-- 6. 磁盘（实例侧看）：数据目录与 pg_wal 分区使用率
-- 巡检脚本里用 shell 拿：df -h $PGDATA $PGDATA/pg_wal
```

巡检结果不要只发群，异常项要挂到工单系统里闭环。

## 变更 SOP

所有 DDL 走审核流程，审核关注四点：锁影响、表大小、回滚方案、执行窗口。

- **锁超时保护**：任何 ALTER TABLE / 加约束的语句，先设 `lock_timeout`，拿不到锁就快速失败，避免把后面所有查询堵成排队（见 [锁系统](../internals/lock-system)）。

```sql
-- 拿不到锁 3 秒就放弃，重试交给人或脚本
SET lock_timeout = '3s';
ALTER TABLE orders ADD COLUMN channel text;
RESET lock_timeout;
```

- **大表加索引**：一律 `CONCURRENTLY`，失败会留下 INVALID 索引，要删掉重建：

```sql
CREATE INDEX CONCURRENTLY idx_orders_created_at ON orders (created_at);
-- 失败清理：
DROP INDEX CONCURRENTLY idx_orders_created_at;
```

- **加 NOT NULL 列 / 改列类型**：PG 11+ 加带默认值的列已不需要重写全表；改类型仍可能重写表和索引，大表必须评估。
- **执行窗口**：拿 ACCESS EXCLUSIVE 锁的变更放在低峰；`CONCURRENTLY` 不能在事务里跑。
- **回滚方案**：执行前写清楚反向 SQL。加列回滚是 `DROP COLUMN`，但删列回滚要靠备份，两者成本完全不同，审核时就要区分。
- 慢变更用 `pg_stat_activity` 旁路观察进度，必要时用 `pg_cancel_backend(pid)` 收场（见 [锁冲突排查](../internals/lock-conflict-troubleshooting)）。

## 备份验证 SOP

备份没恢复过就等于没备份。每月一次完整恢复演练：

1. 取最近一次基础备份 + 对应 WAL 归档，恢复到临时实例（步骤见 [物理备份与 PITR](./physical-backup-and-pitr)）。
2. 恢复完成后跑冒烟检查：表数量、关键表行数、最新一条业务数据的时间戳。
3. 记录实际耗时（RTO 实测值）、数据新鲜度（RPO 实测值），和预期 SLA 对比。
4. 逻辑备份（pg_dump）另做抽样验证：恢复到临时库，跑关键业务的只读检查。
5. 演练失败当天提 bug 单，责任人限期修复；连续两个月演练通过才允许调整备份保留策略。

## 索引维护 SOP

每季度一次索引体检：

```sql
-- 未被使用过的索引（自上次统计重置以来 idx_scan = 0）
SELECT schemaname, relname, indexrelname, idx_scan,
       pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE idx_scan = 0 AND NOT indisprimary
ORDER BY pg_relation_size(indexrelid) DESC;

-- 顺带看 INVALID 索引（CONCURRENTLY 失败残留）
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
```

处置规则：

- `idx_scan = 0` 且体积大的索引先标记观察一个季度，跨业务高峰确认无使用后再 `DROP INDEX CONCURRENTLY`。注意统计在实例重启后会清零，判断要结合 `pg_stat_statements`。
- 主键和唯一约束的索引不进清理候选。
- 索引膨胀（体积/行数比明显异常）进入 REINDEX CONCURRENTLY 排期（见 [索引膨胀与维护](../indexing/index-bloat-and-maintenance)）。

## 保留策略

- **WAL 归档**：保留时长由 PITR 需求决定，常见 7~30 天。清理依据是「已备份且超出保留期」的段文件，对照远端归档清单删本地，不要按文件名日期盲删。归档清理与基础备份周期联动：保留期内要有完整的基础备份可起点。
- **基础备份**：至少保留「最近 2 份完整备份」，避免正在恢复时上一次备份已被清掉。长期合规要求另算。
- **旧备份清理**：清理动作放脚本 + 确认清单，禁止手工 rm；清理后跑一次「归档可恢复」抽检。
- **逻辑备份**：日备保留 7 天、周备保留 1 个月、月备保留 1 年是常见起点，按业务合规要求调整。
- **复制槽**：下线的订阅/备用从库，槽当天删除，避免长期滞留 WAL（见 [流复制搭建](./streaming-replication-setup)）。

## 事故响应模板

事故发生后 48 小时内补全，存档到团队知识库：

```markdown
## 事故报告：<标题>
- 时间线：
  - 14:02 监控告警 PgDown 触发
  - 14:05 值班确认实例宕机，开始处置
  - 14:18 从库提升为主，业务恢复
- 影响范围：订单服务写入失败 16 分钟，约 xx 笔订单积压，无数据丢失
- 根因：pg_wal 分区被失效复制槽滞留的 180GB WAL 占满，实例 PANIC
- 为什么没提前发现：slot 滞留监控缺失（告警规则漏配）
- Action items：
  1. [P0] 补 slot 滞留告警 —— owner: xxx —— 截止 xx-xx
  2. [P1] 删除废弃的 slot rep_dead —— owner: xxx —— 截止 xx-xx
  3. [P2] 磁盘满处置纳入季度演练 —— owner: xxx —— 截止 xx-xx
```

要点：时间线精确到分钟、影响用业务语言量化、每个 Action item 都有 owner 和截止时间。事故报告的价值在 Action items 的闭环率，写完没人跟进等于没写。

## 相关页面

- [监控告警](./monitoring-and-alerting)——巡检指标的告警化。
- [物理备份与 PITR](./physical-backup-and-pitr)——备份验证 SOP 的操作步骤。
- [故障演练清单](./disaster-recovery-drills)——事故场景的处置细节。
- [备份策略](./backup-strategy)——保留策略的备份侧设计。

官方文档：<https://www.postgresql.org/docs/current/maintenance.html> 与 <https://www.postgresql.org/docs/current/monitoring-stats.html>
