# 故障演练清单

故障处置能力只能靠演练建立。每个场景都按「症状 → 确认 → 处置 → 预防」四段展开，演练时照着走一遍，把实际耗时和偏差记进演练记录，事故发生时才有可执行的肌肉记忆。

## 场景一：主库宕机

**症状**：应用大面积报连接失败或只读错误；监控 `pg_up == 0`；从库复制中断。

**确认**：

```bash
# 主库进程与端口
ssh db-primary "pg_ctl -D $PGDATA status" || echo "primary down"
ss -lntp | grep 5432

# 从库视角确认复制断了
psql -h db-standby -c "SELECT now() - pg_last_xact_replay_timestamp() AS lag;"
tail -20 $PGDATA/log/postgresql.log
```

**处置**（有 Patroni 之类 HA 工具时由工具自动完成，手工流程如下）：

1. 确认主库确实不可恢复（进程退出、机器失联），而不是网络抖动。等待 1~2 个探测周期再动手。
2. 在从库上确认它已收到所有能收到的 WAL：`SELECT pg_last_wal_replay_lsn();`。
3. 提升从库为主库：

```bash
# PG 12+ 触发提升：去掉 standby.signal 后重启，或用触发文件
pg_ctl -D $PGDATA promote
# 或
psql -c "SELECT pg_promote();"
```

4. 关闭旧主库的自动启动（`systemctl disable postgresql` 或隔离节点），避免双主。
5. 切换客户端连接串（DNS / 配置中心 / pgbouncer 后端）。
6. 旧主库恢复后作为新从库重新 `pg_rewind` 或重做基础备份接入。

**客户端表现**：提升期间写入报 `cannot execute ... in a read-only transaction` 或连接拒绝，通常持续几秒到几十秒；连接池要配置快速失败与健康检查，避免把请求持续打到旧主。

**预防**：HA 工具 + 仲裁（见 [高可用架构](/zh/operations/high-availability-architecture)）；客户端用读写分离端点而不是直连 Pod IP；每季度做一次手工切换演练。

## 场景二：磁盘满

**症状**：写入报错 `No space left on device`，或实例直接 PANIC（`pg_wal` 满时 PANIC，见 [WAL 机制](/zh/internals/wal-mechanism)）；日志大量写失败。

**确认**：

```bash
df -h $PGDATA $PGDATA/pg_wal
du -sh $PGDATA/pg_wal          # WAL 占用是否异常增长
du -sh $PGDATA/base/* | sort -h | tail   # 哪个库在膨胀
```

`pg_wal` 撑满的典型原因：复制槽失效（下游挂了却不删槽）、归档失败、`wal_keep_size` 设置过大叠加写入高峰。

**处置**（按优先级）：

```sql
-- 1. 找出滞留 WAL 的失效槽，确认后删掉
SELECT slot_name, active, pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained
FROM pg_replication_slots;
SELECT pg_drop_replication_slot('dead_slot');

-- 2. 临时把 checkpoint 上限调小，允许清掉可回收 WAL
ALTER SYSTEM SET max_wal_size = '1GB';
SELECT pg_reload_conf();
SELECT pg_switch_wal();   -- 强制切段，配合归档成功后清理
```

3. 归档目录满就先扩容或清理已备份到远端的旧段（对照远端清单再删）。
4. 数据目录满优先清理日志、临时文件（`$PGDATA/base/pgsql_tmp`）、旧 core dump，不要直接删 WAL 或数据文件。
5. 实例已 PANIC 的情况：腾出空间后重启，靠 WAL 恢复到一致状态。

**预防**：磁盘使用率 80% 告警、`pg_wal` 单独分区、slot 滞留量监控（见 [监控告警](/zh/operations/monitoring-and-alerting)）、归档失败即时告警。

## 场景三：表膨胀

**症状**：查询变慢但执行计划没变；表和索引体积远大于业务数据量；`n_dead_tup` 持续偏高。

**确认**：

```sql
SELECT relname, n_live_tup, n_dead_tup,
       round(n_dead_tup * 100.0 / greatest(n_live_tup + n_dead_tup, 1), 1) AS dead_pct,
       last_autovacuum
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC LIMIT 20;

-- 实际磁盘占用 vs 估计行数
SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS total_size
FROM pg_class WHERE relkind = 'r'
ORDER BY pg_total_relation_size(oid) DESC LIMIT 20;
```

**处置**：

```sql
-- 第一步永远是普通 VACUUM：空间可复用、不锁写，先把死元组清掉
VACUUM (VERBOSE, ANALYZE) big_table;

-- 空间要还给操作系统才用 VACUUM FULL：锁排他，业务要停写
VACUUM (FULL) big_table;

-- 索引膨胀用 REINDEX CONCURRENTLY（PG 12+），不阻塞写入
REINDEX INDEX CONCURRENTLY idx_big_table_owner;
```

时机选择：`VACUUM FULL` 和不带 `CONCURRENTLY` 的 `REINDEX` 都拿排他锁，只能在维护窗口做；PG 12+ 优先 `REINDEX CONCURRENTLY`，表空间回收优先考虑用 pg_repack 类扩展在线做。膨胀治理的更多细节见 [索引膨胀与维护](/zh/indexing/index-bloat-and-maintenance) 与 [autovacuum 调优](/zh/internals/autovacuum-tuning)。

**预防**：autovacuum 对大表用更激进的 per-table 参数（`autovacuum_vacuum_scale_factor` 按表覆盖）；高频更新的表预留 fillfactor；监控 dead ratio 趋势而不是等用户报慢。

## 场景四：复制中断

**症状**：`pg_stat_replication` 里对应行消失；从库日志报 WAL 段缺失；slot 的 `active = false`。

**确认**：

```sql
-- 主库：哪个 slot 断了、滞留多少
SELECT slot_name, active, restart_lsn,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained
FROM pg_replication_slots;

-- 从库：卡在哪个 LSN
SELECT pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn();
tail -30 $PGDATA/log/postgresql.log   # 找具体报错：找不到段？认证失败？网络？
```

**处置**：

1. 报「requested WAL segment has already been removed」：主库已把段清掉，从库无法原地追赶，需要重建。
2. 网络或认证问题：修复后从库会自动重连追赶，不需要人工干预。
3. 从库落后过多或段已删除：重做基础备份恢复从库（用 [物理备份与 PITR](/zh/operations/physical-backup-and-pitr) 里的 `pg_basebackup -R` 流程，最省事）。
4. 只断流的 slot（逻辑订阅下线、废弃的槽）：确认无下游后 `pg_drop_replication_slot()` 删除，释放主库 WAL 保留。

**追赶确认**：重建接入后观察 `SELECT now() - pg_last_xact_replay_timestamp();` 收敛到亚秒级，且 `pg_stat_replication` 的 `state = streaming`。

**预防**：slot 滞留告警；从库 `recovery_min_apply_delay` 只在需要延迟灾备时设置；临时逻辑订阅用完即删槽。

## 场景五：误删数据

**症状**：业务报数据丢失，通常是误 `DELETE`/`UPDATE` 少了 WHERE，或误 `DROP TABLE`。

**确认**：先问清三件事——哪张表、什么时间、大概影响多少行。马上停止对这张表的写入（或停整个库），防止后续写入把恢复窗口冲掉。

**处置**（PITR 抽回，主库不动）：

1. 取一份误删之前的最新基础备份，按 [物理备份与 PITR](/zh/operations/physical-backup-and-pitr) 的步骤在临时实例恢复到「误删前一秒」。
2. 临时实例验证数据后，`COPY` 导出，导回生产。
3. 全程生产库只读化或锁表，避免导回期间产生主键冲突。

```bash
# 快速版：直接从主库起临时实例抽数
# 注意：恢复到基础备份完成之后的时刻仍需要归档 WAL，
# 没有归档时只能恢复到 pg_basebackup 结束时的数据状态
pg_basebackup -h db-host -D /tmp/restore -X stream -R
cat >> /tmp/restore/postgresql.conf <<EOF
recovery_target_time = '2026-10-12 14:34:50+08'
EOF
touch /tmp/restore/recovery.signal
pg_ctl -D /tmp/restore -o "-p 5433" start
```

**预防**：危险操作走变更审批；应用账号不给 `DROP` 权限（见 [角色与权限](/zh/security/roles-and-permissions)）；高频误操作风险的表开启延迟从库（`recovery_min_apply_delay = '1h'`）作为「后悔药」；每季度跑一次 PITR 演练。

## 演练频率与记录

- **季度级**：PITR 演练、主从切换演练、备份恢复验证（每月更佳，见 [运维 SOP](/zh/operations/ops-sop)）。
- **半年级**：磁盘满处置、复制重建、误删数据全流程。
- **记录内容**：演练时间、场景、每步实际耗时、与文档的偏差、发现的问题、修复责任人。演练中发现流程走不通的，当天修文档——演练的价值就在这里。
- 演练要尽量在接近生产的副本环境做，至少数据量级要接近；在 10MB 的测试库上演练出的耗时对 500GB 的库没有参考意义。

## 参考资料

- [PostgreSQL 官方文档 · 25.3. Continuous Archiving and Point-in-Time Recovery (PITR)](https://www.postgresql.org/docs/current/continuous-archiving.html)
- [PostgreSQL 官方文档 · 26.2. Log-Shipping Standby Servers](https://www.postgresql.org/docs/current/warm-standby.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [knowledge](/zh/knowledge)
- [backup-strategy](/zh/operations/backup-strategy)
- [high-availability-architecture](/zh/operations/high-availability-architecture)
- [index](/zh/operations/index)
- [ops-sop](/zh/operations/ops-sop)
- [physical-backup-and-pitr](/zh/operations/physical-backup-and-pitr)
- [data-encryption-at-rest](/zh/security/data-encryption-at-rest)- [物理备份与 PITR](/zh/operations/physical-backup-and-pitr)——场景五的完整步骤。
- [备份策略](/zh/operations/backup-strategy)——演练依赖的备份体系。
- [监控告警](/zh/operations/monitoring-and-alerting)——各场景的发现手段。
- [ops SOP](/zh/operations/ops-sop)——演练记录与备份验证的制度化。

官方文档：<https://www.postgresql.org/docs/current/continuous-archiving.html> 与 <https://www.postgresql.org/docs/current/warm-standby.html>
