# WAL 机制

WAL（Write-Ahead Log，预写日志）是 PostgreSQL 持久化的基石：对数据页的任何修改，都先把描述该修改的日志记录写入 WAL 并落盘，然后才允许把数据页本身写出磁盘。它同时支撑三件事：崩溃恢复（重启后重放 WAL）、流复制与逻辑复制（下游消费 WAL）、时间点恢复 PITR（结合基础备份重放到任意时刻）。

## WAL 记录与 LSN

WAL 是一串追加写的字节流，每条记录描述「某个页发生了什么物理变更」而不是 SQL 逻辑。流中的位置用 LSN（Log Sequence Number）表示，形如 `16/B374D848`：

```sql
SELECT pg_current_wal_lsn();                    -- 当前写入位置
SELECT pg_walfile_name(pg_current_wal_lsn());   -- 对应的段文件名

-- 估算 WAL 生成速率：间隔一段时间取两次 LSN 求字节差
SELECT pg_current_wal_lsn();
-- ... 等待一段时间后：
SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '16/B374D848') AS bytes_elapsed;
```

```sql
-- PG 14+：实例启动以来的 WAL 量统计（wal_fpi 是整页镜像条数）
SELECT wal_records, wal_fpi, pg_size_pretty(wal_bytes) AS wal_volume
FROM pg_stat_wal;
```

## 先写 WAL，再写数据页

- 事务提交时，backend 必须先把它产生的 WAL 记录刷盘（`synchronous_commit = on` 时提交返回前完成），数据页可以继续留在 shared_buffers 里，之后由 checkpointer/bgwriter 批量写出；
- 因此崩溃瞬间磁盘上的数据页是「旧页 + 一部分新页」的混合状态，恢复时用 WAL 重放把页推到一致状态——这就是数据页可以乱序、延迟写盘的原因；
- `full_page_writes`（默认 on）：checkpoint 之后**第一次**修改某个页时，把整个 8KB 页的完整镜像写进 WAL。目的：对抗 torn page——OS 以 4KB 为单位写盘，崩溃可能让 8KB 数据页半新半旧，这种页无法用增量日志修补，只能整页覆盖。

FPW 使 checkpoint 后的第一轮写入明显放大，这是 `wal_compression` 的用武之地。

## wal_buffers 与提交路径

- `wal_buffers` 是共享内存中的 WAL 缓冲。默认 -1 表示取 `shared_buffers` 的 1/32，下限 64kB，上限一个 WAL 段（默认 16MB）。写入吞吐高的实例可显式设为 16MB~64MB，减少缓冲争用；
- 提交路径：backend 自己把 commit 记录写入 WAL 缓冲并负责刷盘；`walwriter` 进程在非提交时机提前刷出积压的 WAL 页，让某个 backend 提交时不必一次性刷掉大量其他事务留下的 WAL。

## 段文件与 pg_wal 目录管理

- WAL 按段文件组织，默认每段 16MB；PG 11 起可在建库时用 `initdb --wal-segsize` 调整为 1MB~1GB 的 2 的幂；
- 段写满后切换，新记录写下一个段；可用 `pg_switch_wal()` 手动强制切换；
- 写满的段不会立刻删除：先归档（若开启归档），之后按 `min_wal_size`/`max_wal_size` 策略回收（改名复用）或删除；
- `wal_keep_size`（PG 13+，取代旧 wal_keep_segments）保证 pg_wal 中至少保留这么多 WAL 供流复制使用；此外**复制槽**会阻止删除下游还没消费的段——废弃未删的槽是 pg_wal 撑爆磁盘的经典原因。

```sql
-- pg_wal 目录现状
SELECT count(*) AS segment_files, pg_size_pretty(sum(size)) AS total_size
FROM pg_ls_waldir();

-- 谁在挡住 WAL 回收
SELECT slot_name, active, wal_status, xmin, catalog_xmin
FROM pg_replication_slots;
```

## wal_compression

FPW 的整页镜像通常高度可压缩。`wal_compression` 开启后只压缩这些整页镜像：

- PG 9.6 引入该参数但仅支持 pglz，压缩效果与速度都一般；**PG 15 起可选 lz4 与 zstd**，推荐 PG 15+ 上设 `lz4` 或 `zstd`；
- 收益直接体现在 WAL 体积上：写入量、归档量、复制流量都受益，代价是少量 CPU。高写入负载通常值得开启。

```sql
SELECT name, setting FROM pg_settings
WHERE name IN ('wal_compression', 'full_page_writes', 'wal_buffers',
               'wal_keep_size', 'max_wal_size', 'min_wal_size', 'wal_segment_size');
```

## 注意事项与常见坑

- `synchronous_commit = off` 让提交不等 WAL 刷盘，吞吐提升明显；风险是崩溃时丢最近几百毫秒的已提交事务（不会损坏数据一致性）。计费、资金类不可丢场景不要关，见 [写入吞吐优化](../performance/write-throughput-optimization)。
- pg_wal 分区要与数据目录一起纳入容量监控，WAL 撑爆磁盘会让实例直接 PANIC；存量 WAL 增长异常先查 `pg_replication_slots` 的 inactive 槽。
- WAL 生成速率异常升高的常见原因：checkpoint 后大量 FPW、长事务把大量变更攒到一起提交、大批量 UPDATE/DELETE。用 `pg_stat_wal` 与两次 LSN 差值对照业务写入量定位。

## 相关页面

- [checkpoint 与 buffer](./checkpoint-and-buffer)——WAL 落盘之后脏页何时写出。
- [流复制与同步复制](./streaming-replication-and-sync)——WAL 如何被下游消费。
- [物理备份与 PITR](../operations/physical-backup-and-pitr)——WAL 归档与时间点恢复。

官方文档：<https://www.postgresql.org/docs/current/wal.html> 与 <https://www.postgresql.org/docs/current/wal-configuration.html>
