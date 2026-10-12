# checkpoint 与 buffer

PostgreSQL 自管一块共享缓冲池（shared_buffers），数据页先在缓冲池里修改，再由 checkpoint 等机制批量写出磁盘；WAL 先行落盘保证随时可崩溃恢复（见 [WAL 机制](./wal-mechanism)）。checkpoint 是「把脏页批量刷盘 + 推进恢复起点」的周期性动作，它的节奏直接决定 IO 曲线的平稳程度和崩溃恢复时长。

## 双缓冲架构：8KB 页与 OS 页

- PostgreSQL 页大小固定 8KB，OS 文件系统页一般 4KB，叠加形成「双缓冲」：同一份数据可能同时存在于 shared_buffers 和 OS page cache；
- `shared_buffers` 默认仅 128MB；专用服务器常见起点是物理内存的 25% 左右。不必贪大——OS cache 对全量扫描、临时文件同样有效，而双缓冲意味着两边占的是同一份物理内存的预算；
- 缓冲池以 8KB 页为单位管理，命中缓冲池的读完全绕过 OS。

## 缓冲区查找与淘汰：clock-sweep

- backend 通过共享的缓冲区映射哈希表按 (表空间, 关系, 块号) 定位缓冲区，一次哈希查找判断页在不在内存；
- 未命中时淘汰一个缓冲区：clock-sweep 算法用环形扫描 + 访问计数（usage_count）近似 LRU，频繁访问的页计数高、更难被淘汰；
- 正被使用（pinned）的缓冲区不可淘汰；淘汰脏页需要先写出磁盘——这正是 bgwriter 的价值：提前把脏页写干净，让前台 backend 淘汰时不必自己写。

## 命中率观测

```sql
-- 全实例用户表堆页命中率（长期低于 95% 时检查 shared_buffers 与工作集）
SELECT sum(heap_blks_hit) AS heap_hits, sum(heap_blks_read) AS heap_reads,
       round(100.0 * sum(heap_blks_hit)
             / nullif(sum(heap_blks_hit) + sum(heap_blks_read), 0), 2) AS hit_pct
FROM pg_statio_user_tables;
```

```sql
-- 分表找读放大来源：heap_blks_read 高的表是缓冲池压力来源
SELECT relname, heap_blks_hit, heap_blks_read,
       round(100.0 * heap_blks_hit / nullif(heap_blks_hit + heap_blks_read, 0), 1) AS hit_pct
FROM pg_statio_user_tables
ORDER BY heap_blks_read DESC
LIMIT 10;
```

PG 16 起可用 `pg_stat_io` 按操作上下文（普通读、vacuum、bulkread 等）拆分观测：

```sql
SELECT backend_type, context, hits, reads, evictions
FROM pg_stat_io
WHERE object = 'relation'
ORDER BY reads DESC;
```

命中率低不一定是坏事：全表扫描类报表会把大量页冲过缓冲池，拉低整体命中率却未必是配置问题，要结合业务负载判断。

## checkpoint 的触发条件

满足任一条件即触发：

- 距上次 checkpoint 超过 `checkpoint_timeout`（默认 5 分钟）；
- 估算的 WAL 消耗即将达到 `max_wal_size`。它是软上限：超过后不会立即报错，而是立即触发 checkpoint，WAL 仍可能继续增长到 1.5~2 倍，极端情况磁盘耗尽 PANIC；
- 手动执行 `CHECKPOINT` 命令、在线备份开始等管理操作、正常关库。

日志出现 `checkpoints are occurring too frequently (N seconds apart)` 说明 WAL 生成速度顶到了 `max_wal_size`，`checkpoint_warning`（默认 30 秒）负责提醒调大它。

## spread：把 IO 峰摊平

- checkpoint 要写出全部脏页，天然是 IO 尖峰。`checkpoint_completion_target`（PG 14 起默认 0.9）控制写完的目标时刻：在下一次 checkpoint 到来前约 90% 的时间点完成，把写盘摊到整个周期；
- 摊平后 IO 曲线平稳，代价是脏页停留更久、崩溃恢复要重放更多 WAL（恢复时长与 checkpoint 之后的 WAL 量成正比）；
- 调优方向：写入量大的实例大幅增大 `max_wal_size`（8GB~32GB 起步试探）减少 checkpoint 次数，保持 `checkpoint_completion_target = 0.9`，而不是缩短 timeout 加密 checkpoint。

观测（PG 16 及更早，checkpoint 统计在 `pg_stat_bgwriter`）：

```sql
SELECT checkpoints_timed, checkpoints_req,
       checkpoint_write_time, checkpoint_sync_time,
       buffers_checkpoint, buffers_clean, maxwritten_clean
FROM pg_stat_bgwriter;
```

PG 17 起 checkpoint 统计移入 `pg_stat_checkpointer`：

```sql
SELECT num_timed, num_requested, write_time, sync_time, buffers_written
FROM pg_stat_checkpointer;
```

`checkpoints_timed` 远大于 `checkpoints_req` 说明节奏健康（由 timeout 驱动）；`checkpoints_req` 持续偏高说明 WAL 频繁顶到 `max_wal_size`，应调大它。

## bgwriter 与 walwriter 的分工

- **bgwriter**：每 `bgwriter_delay`（默认 200ms）醒来，沿 clock-sweep 扫描并写出「即将被淘汰」的脏页（受 `bgwriter_lru_maxpages`、`bgwriter_lru_multiplier` 约束），目标是让前台淘汰缓冲区时拿到干净页；
- **walwriter**：每 `wal_writer_delay`（默认 200ms）刷出 WAL 缓冲中已积累的页，摊平提交路径的刷盘量；
- 两者都不承担「事务提交必须落盘」的强约束——WAL 提交刷盘由提交事务的 backend 自己完成；checkpoint 的批量写出由 checkpointer 进程执行。

## 注意事项与常见坑

- `shared_buffers` 改动需重启生效；超过几十 GB 后继续加收益递减，先看命中率与工作集大小，容量评估见 [capacity 与扩展上限](../performance/capacity-and-scaling-limits)。
- PG 的写出走普通 write（非 O_DIRECT），OS cache 回写行为会与 checkpoint 峰叠加，压测时用 iostat 对照 checkpoint 时间点分析 IO 曲线。
- 恢复时间目标（RTO）有硬指标的系统，`max_wal_size` 不能无限放大：checkpoint 越稀疏，崩溃恢复越久，这是吞吐与恢复时长的权衡。

## 相关页面

- [WAL 机制](./wal-mechanism)——先写日志的另一半。
- [架构与内存](./architecture-and-memory)——shared_buffers 在整体内存中的位置。
- [参数调优](../performance/parameter-tuning)——相关参数的全局视角。
- [EXPLAIN ANALYZE 与 BUFFERS](../performance/explain-analyze-buffers)——从单条查询看缓冲区命中。

官方文档：<https://www.postgresql.org/docs/current/wal-configuration.html> 与 <https://www.postgresql.org/docs/current/runtime-config-resource.html#RUNTIME-CONFIG-RESOURCE-BACKGROUND-WRITER>
