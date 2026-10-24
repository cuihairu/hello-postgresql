# 流复制搭建

流复制的传输链路、`synchronous_commit` 语义与备库冲突处理在原理篇（[流复制与同步](/zh/internals/streaming-replication-and-sync)）讲过，这里记录一套可复用的搭建流程：主库放行复制、`pg_basebackup` 拉起备库、用复制槽管住 WAL 保留，最后看懂两个观测视图。

## 主库准备

```sql
-- wal_level 默认就是 replica，确认即可；PG 16/17 的 max_wal_senders 默认 10
SHOW wal_level;
SHOW max_wal_senders;

-- 专用复制账号：最小权限，只有 REPLICATION + LOGIN
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '使用强密码';
```

```plaintext
# /etc/postgresql/17/main/conf.d/99-replication.conf（或 postgresql.conf）
wal_level = replica
max_wal_senders = 10        # 流复制连接 + 并发 basebackup 共用此额度
max_replication_slots = 10
listen_addresses = '*'

# pg_hba.conf：按网段放行物理复制连接（replication 伪库）
host  replication  replicator  10.0.0.0/24  scram-sha-256
```

```bash
# 上述参数与 pg_hba 均可 reload 生效，无需重启
sudo systemctl reload postgresql@17-main
```

## pg_basebackup 搭备库

在备库机器上执行（备库已装好相同或更高小版本的软件包，数据目录为空）：

```bash
sudo -u postgres pg_basebackup \
  -h 10.0.0.11 -p 5432 -U replicator \
  -D /var/lib/postgresql/17/main \
  -X stream -C -S standby_1 -P -R
# 会提示输入 replicator 密码；自动化环境改用 ~/.pgpass
```

参数含义：

- `-X stream`：备份期间同步流式拉取 WAL，不依赖主库归档齐全（PG 13 起这已是默认值）。
- `-C -S standby_1`：顺手在主库创建名为 `standby_1` 的物理复制槽。
- `-R`：在备库写入 `standby.signal` 标记文件，并把连接信息写进 `postgresql.auto.conf`。
- `-P`：显示进度。

完成后备库 PGDATA 里的关键内容：

```plaintext
standby.signal              # 空标记文件，存在即以备库模式启动（PG 12+，取代旧 recovery.conf）
postgresql.auto.conf        # pg_basebackup -R 自动写入以下两行：
#   primary_conninfo = 'host=10.0.0.11 port=5432 user=replicator ... application_name=standby_1'
#   primary_slot_name = 'standby_1'
```

```bash
sudo systemctl start postgresql@17-main
# 日志出现 "database system is ready to accept read-only connections" 即就绪
```

密码会明文留在 `postgresql.auto.conf`，注意该文件权限（默认 0600）；更干净的做法是把密码放进 `~postgres/.pgpass`，`primary_conninfo` 里省略密码项。PG 12 之前的版本这套配置写在 `recovery.conf`，看到老资料注意区分。

## 复制槽与 WAL 保留

- **物理复制槽**：主库为每个备库记住「它确认收到哪里」，未确认的 WAL 一律不删。备库短暂断线重启即可继续追，这是生产标配。
- **代价**：备库失联期间主库 `pg_wal` 持续堆积，直到磁盘满、主库写入崩溃。这是流复制运维中最常见的事故。
- **兜底**：`max_slot_wal_keep_size`（PG 13+）限制单个槽保留的 WAL 上限，超限后槽标记为 `lost`，备库需要重新搭建——磁盘有底，代价是失联过久的备库重做。
- **不用槽的替代**：`wal_keep_size`（主库无条件多保留多少 WAL，默认 0）。配置简单但保证性弱：突发写入量大时备库还没追上，旧 WAL 可能已被回收，只能靠归档找回或重建。

```sql
-- 主库侧：槽状态与健康度
SELECT slot_name, active, restart_lsn,
       retained_wal, wal_status
FROM pg_replication_slots;

-- 彻底下线备库后，记得删槽，否则 WAL 永远不回收
SELECT pg_drop_replication_slot('standby_1');
```

## 观测视图

**主库侧 `pg_stat_replication`**：每条 walsender 连接一行，是主备延迟的第一观测点。

```sql
SELECT client_addr, application_name, state, sync_state,
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS replay_lag_bytes,
       write_lag, flush_lag, replay_lag
FROM pg_stat_replication;
```

- `state = streaming` 为正常；`replay_lag_bytes` 是字节差（相对 `pg_current_wal_lsn()`），`replay_lag` 是时间差。
- `sync_state` 在配置了 `synchronous_standby_names` 时显示 `sync` / `quorum` / `potential` / `async`。

**备库侧 `pg_stat_wal_receiver`**：接收进程视角，`status = streaming` 为正常；`last_msg_send_time` 长时间不更新说明上游心跳断了。两边的监控告警都建议建立在 `pg_wal_lsn_diff` 与 lag 时间上，而不是只看连接存在。

## 级联复制一瞥

备库可以作为下级备库的上游：在中间层备库的 `pg_hba.conf` 里同样放行 `replication` 连接，下游 `pg_basebackup -h` 直接指向备库即可，WAL 由上游备库的 walsender 转发。用途：一主多备时把扇出压力从主库转移到中间层，跨机房部署时以本地中转减少专线流量。注意复制槽建在直接上游上（上游备库也可持有物理槽），中间层自身失联同样会堵住它的上游，`max_slot_wal_keep_size` 的兜底逻辑逐层都适用。

## 注意事项与常见坑

- **槽失联是 pg_wal 磁盘满的头号原因**：下线备库必须删槽，长期备库监控 `retained_wal` 与磁盘水位。
- **备库只读**：备库上执行写操作报 `cannot execute INSERT in a read-only transaction` 是正常行为，读写分离的路由要在应用/中间层做。
- **版本方向**：备库版本必须不低于主库；小版本升级先升备库再升主库。大版本升级是另一条路径，见 [版本升级](/zh/operations/version-upgrade)。
- **`synchronous_commit = on` 但没配 `synchronous_standby_names`** 时不会等任何备库，别误以为开了同步复制。
- **防火墙方向**：是备库主动连主库的 5432，安全组要按备库 → 主库方向放行。
- **`application_name` 要设置**（`primary_conninfo` 里带上）：它是 `synchronous_standby_names` 和监控里识别备库的依据，默认值不含实例标识。

## 参考资料

- [PostgreSQL 官方文档 · Chapter 25. Backup and Restore](https://www.postgresql.org/docs/current/backup.html)
- [PostgreSQL 官方文档 · Chapter 19. Server Configuration](https://www.postgresql.org/docs/current/runtime-config.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [流复制与同步](/zh/internals/streaming-replication-and-sync)
- [WAL 机制](/zh/internals/wal-mechanism)
- [高可用架构](/zh/operations/high-availability-architecture)
- [物理备份与 PITR](/zh/operations/physical-backup-and-pitr)
- [streaming-replication-and-sync](/zh/internals/streaming-replication-and-sync)
- [knowledge](/zh/knowledge)
- [high-availability-architecture](/zh/operations/high-availability-architecture)
- [index](/zh/operations/index)
- [ops-sop](/zh/operations/ops-sop)