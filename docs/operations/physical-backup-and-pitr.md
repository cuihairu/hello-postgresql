# 物理备份与 PITR

物理备份是「拷贝整个数据目录」，配合 WAL 归档可以把集群恢复到过去任意一秒的状态，也就是 PITR（Point-In-Time Recovery）。它恢复的是数据本身，所以能扛住误删表、误 DROP、逻辑错误这一类问题；代价是要有独立的归档存储，并且平时就要演练。逻辑备份（pg_dump）只能恢复到「备份那一刻的完整状态」，无法插回到中间的任意时间点。

## pg_basebackup 做基础备份

`pg_basebackup` 通过复制协议连接主库，一边流式复制 WAL 一边复制数据目录，结束时的时间点落在同一个一致位点，天然适合做物理备份。

```bash
# 常规备份：流式抓 WAL，结束时做 fast checkpoint，自动写入 standby.signal 相关配置
pg_basebackup -h db-host -U repuser -D /backup/full/20261012 \
  -X stream --checkpoint=fast -P -v \
  --no-slot

# 使用复制槽防止归档期间 WAL 被清理（推荐生产用）
pg_basebackup -h db-host -U repuser -D /backup/full/20261012 \
  -X stream --checkpoint=fast --slot basebackup_slot -P -v

# -R：在备份目录里写出 standby.signal 和备份相关的复制参数，便于直接拿去做副本或恢复起点
pg_basebackup -h db-host -U repuser -D /backup/full/20261012 \
  -X stream -R
```

要点：

- `-X stream` 让 WAL 通过复制流实时拉取，避免去 `pg_wal` 目录里抓段文件（段文件可能刚写完还没归档）。替代写法 `-X fetch` 会从 `pg_wal` 拷贝已完成的段，适合 WAL 归档已经稳定的环境。
- `--checkpoint=fast` 会在备份前后各触发一次 checkpoint，缩短一次备份要重放的 WAL 量。代价是 checkpoint 期间的同步 I/O 尖峰，业务高峰期可以用 `--checkpoint=spread` 或省略（默认 spread 行为因版本略有差异，PG 17 起 `pg_basebackup` 默认 checkpoint 为 spread）。
- `-R` 写出的配置让恢复出来的目录可以直接作为恢复起点使用；做「先起临时实例再抽数据」的演练时特别省事。
- 备份出来的目录必须清空目标路径再放，`pg_basebackup` 要求目标目录为空或不存在。

## WAL 归档：archive_mode 与 archive_command

PITR 的另一个支柱是 WAL 归档。checkpoint 之后完成的 WAL 段会被复制到一个独立于主库文件系统的位置，通常写到对象存储或远端存储。

```plaintext
# postgresql.conf
archive_mode = on
archive_command = 'cp %p /backup/wal-archive/%f'
archive_timeout = 300      # 最多等多久强制切换 WAL 段，单位秒
```

`archive_command` 的两个占位符：`%p` 是待归档段文件的本地路径，`%f` 是文件名。PG 15 及以后的版本仍然使用这个参数名和行为，没有变化。

```bash
# 生产更常见的写法：推到对象存储，失败要返回非零退出码
archive_command = 'aws s3 cp %p s3://pg-archive/wal/%f'
```

归档命令的退出码决定归档是否成功，PostgreSQL 不会重试一个持续失败的归档任务，只能等下个段。所以归档命令必须幂等、要处理好「目标已存在」的情况，并把失败告警接上。

PG 17 引入了 backup 模块（`backup_fdw` 等方向的聚合能力与 `pg_start_backup` 相关的改进），归档本身依旧是 `archive_mode`/`archive_command` 这套机制。

## 恢复：restore_command 与 recovery.signal

PITR 的起点是基础备份目录，恢复过程靠 `restore_command` 从归档里把 WAL 一段一段拉回来重放，直到到达恢复目标。

```plaintext
# postgresql.conf（写在恢复用的新数据目录里）
restore_command = 'cp /backup/wal-archive/%f %p'

# 三选一或组合：恢复到某个时间点 / 某个 LSN / 某个备份标记名
recovery_target_time = '2026-10-12 14:35:00+08'
# recovery_target_lsn = '0/1A3B4C50'
# recovery_target_name = 'basebackup-20261012'

# 默认是 pause 模式：到达目标后暂停恢复，让你检查再决定继续还是退出
# recovery_target = 'pause' | 'immediate' | 'timeline'
```

`recovery.signal` 是 PG 12 及以后开启恢复模式的标志文件，放在数据目录里：

```bash
# PG 12+：拆掉了旧的 recovery.conf，改用「信号文件 + 正常配置文件」的方式
touch $PGDATA/recovery.signal
pg_ctl -D $PGDATA start
```

PG 11 及以前用 `recovery.conf`，里面单独写 `restore_command` 和恢复目标；PG 12 起全部并入 `postgresql.conf`，只留一个空的 `recovery.signal` 作为开关。这条是常见的踩坑点——照旧文档写的 `recovery.conf` 放到 PG 12+ 的目录里不会生效。

## PITR 演练：恢复到误删前一秒

假设 14:35:00 有同事执行了 `DROP TABLE orders`，归档里还有那一刻之前的 WAL。

```bash
# 1. 准备一个临时数据目录，从基础备份恢复
sudo mkdir -p /tmp/restore && sudo chown postgres /tmp/restore
sudo -u postgres pg_basebackup -h db-host -U repuser \
  -D /tmp/restore -X stream -R -P

# 2. 写入恢复配置
cat >> /tmp/restore/postgresql.conf <<'EOF'
restore_command = 'cp /backup/wal-archive/%f %p'
recovery_target_time = '2026-10-12 14:34:50+08'
recovery_target = 'pause'
EOF

# 3. 用独立端口起一个临时实例，不要动生产实例
sudo -u postgres pg_ctl -D /tmp/restore -o "-p 5433" -l /tmp/restore.log start

# 4. 看日志确认到达目标并暂停
tail -f /tmp/restore.log
# 看到 "recovery stopping at 2026-10-12 14:34:50" 或 "recovery has paused" 即到达

# 5. 验证 orders 表还在，把需要的数据抽回生产
psql -p 5433 -c "\d orders"
psql -p 5433 -c "COPY orders TO STDOUT" > orders_recover.csv
```

验证无误后，在生产库把数据插回去，然后退出临时实例：

```bash
sudo -u postgres pg_ctl -D /tmp/restore stop
# 或者继续恢复到最新：
psql -p 5433 -c "SELECT pg_wal_replay_resume();"   # PG 15+ 恢复中恢复
```

「恢复到一个新实例再抽数据」是 PITR 的安全做法：主库不动，风险面只在临时实例上。

## RPO 与 RTO

- **RPO**（可容忍的数据丢失量）由归档间隔决定。归档是「按段提交」的，`archive_timeout` 决定了「当前段没写满也要多久强制切一个新段开始归档」。设 300 秒，RPO 大约是 5 分钟加上一次归档命令的执行时间。想要更小的 RPO，就得调小 `archive_timeout`，但归档命令的调用频率上去，网络与存储压力也随之上升。
- **RTO**（可容忍的恢复时间）由「基础备份大小 + 需要重放的 WAL 量」决定。基础备份大，光拷就要时间；两次基础备份之间的 WAL 越多，重放越久。所以常规做法是：基础备份周期越短、单次重放窗口越小，RTO 越低。
- 想验证 RPO/RTO 是否真的达得到，唯一办法是演练：每次 PITR 演练记录实际耗时，不要相信文档里的理论值。

## 注意事项与常见坑

- 归档目录和数据目录不能在同一块磁盘上，也不要在同一个故障域里。归档存到同一磁盘上等于没归档。
- `archive_command` 要能容忍「目标文件已存在」。用 `cp` 会被权限或覆盖策略挡住，用对象存储工具加 `-f` 或等效的覆盖选项。
- 归档一旦断了，PostgreSQL 会在 `pg_wal` 里堆积未归档的段文件，磁盘满会导致实例 PANIC 停服。归档失败必须进告警。
- 恢复出来的是**只读**实例，写操作会报 `cannot execute in a recovery standby`。抽完数据之后要退出恢复模式（删掉 `recovery.signal` 再重启，或用 `recovery_target = 'immediate'`）。
- `recovery_target_action` 默认 pause，演练时看到「恢复暂停」不要以为失败了，这是到达目标后的预期行为。
- 演练环境要能拿到真实的归档文件，而不是「归档是好的所以不用测」。至少每季度跑一次完整 PITR 演练。

## 参考资料

- [PostgreSQL 官方文档 · 25.3. Continuous Archiving and Point-in-Time Recovery (PITR)](https://www.postgresql.org/docs/current/continuous-archiving.html)
- [PostgreSQL 官方文档 · Chapter 25. Backup and Restore](https://www.postgresql.org/docs/current/backup.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [postgresql-17-features](/ecosystem/postgresql-17-features.md)
- [wal-mechanism](/internals/wal-mechanism.md)
- [knowledge](/knowledge.md)
- [backup-strategy](backup-strategy.md)
- [cluster-init-and-layout](cluster-init-and-layout.md)
- [disaster-recovery-drills](disaster-recovery-drills.md)
- [index](index.md)
- [ops-sop](ops-sop.md)
- [streaming-replication-setup](streaming-replication-setup.md)
- [version-upgrade](version-upgrade.md)- [备份策略](./backup-strategy)——逻辑备份与物理备份的取舍与组合。
- [WAL 机制](../internals/wal-mechanism)——LSN、段文件与重放原理。
- [故障演练清单](./disaster-recovery-drills)——PITR 抽回在生产里的完整步骤。

官方文档：<https://www.postgresql.org/docs/current/continuous-archiving.html> 与 <https://www.postgresql.org/docs/current/backup.html>
