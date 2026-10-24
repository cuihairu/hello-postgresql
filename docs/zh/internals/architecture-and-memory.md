# 体系结构与内存

PostgreSQL 是"一个连接一个进程"的模型：postmaster 监听端口，每个客户端连接 fork 出一个 backend 进程。内存因此天然分成两块——启动时分配一次、所有进程共享的**共享内存**，和每个 backend 独立的**私有内存**。做容量规划、排查 OOM、理解参数为什么"不生效"，都要回到这条边界上。进程分类的完整介绍见[进程架构](/zh/internals/process-architecture)。

## 共享内存

postmaster 启动时分配共享内存段与信号量，随实例退出销毁，主要构成：

- `shared_buffers`：数据页缓冲池，所有进程通过它读写表与索引页。默认仅 128MB，生产上通常给到物理内存的 25% 左右（超过这个比例收益递减，OS 页缓存接管剩下的读）。
- WAL buffers（`wal_buffers`）：事务写 WAL 前的缓冲，默认 `-1` 即 `shared_buffers` 的 1/32。
- SLRU 缓冲：clog（`pg_xact`，事务提交状态）、subtrans、多事务等——可见性判定依赖它，详见[快照与可见性判定](/zh/internals/snapshot-and-visibility)。
- 锁表、复制槽、逻辑解码状态，以及 PG 15 起的累计统计数据（见[pg_stat 观测](/zh/internals/pg-stat-observation)）。

`huge_pages = try/on` 让共享内存改用大页映射，大 `shared_buffers` 的实例能减少 TLB miss、并避免内存被逐步换出，是一行配置的常规优化。

## backend 私有内存

每个 backend 有自己的内存上下文树，其中两个参数决定了大头：

- **`work_mem`**：排序（Sort）、哈希连接（Hash）、哈希聚合、窗口函数等每个**操作节点**的私有工作区上限，放不下就溢出到临时文件。关键在于它的单位不是"每查询"而是"每节点每操作"：一条带多个 sort/hash 的查询同时占用多份，并行查询时每个 worker 又各持一份。
- **`maintenance_work_mem`**：VACUUM、CREATE INDEX、外键校验等维护操作的每进程上限。这类操作通常不并发，可以设得比 `work_mem` 大；例外是 autovacuum worker——它们是常驻并发的，最多 `autovacuum_max_workers` 份，可用 `autovacuum_work_mem` 单独限制。
- **`temp_buffers`**：会话内访问临时表用的页缓冲，默认 8MB，只用临时表的会话才需要调。
- 之外还有关系缓存（relcache）、目录缓存（catcache）、计划上下文等固定开销，每个进程几十 MB 量级。

## 连接数 × work_mem 的 OOM 算术

OOM 的经典算式不是 `max_connections × work_mem`，而是"并发活跃查询里的节点数 × work_mem"：

```plaintext
例：max_connections = 200
   一条报表查询含 3 个哈希 + 2 个排序节点，work_mem = 64MB
   → 单会话峰值 ≈ 5 × 64MB = 320MB
   → 200 个连接同时跑满 ≈ 64GB，还没算并行 worker 各自的份额与 maintenance_work_mem
```

对应的缓解措施按优先级：

1. **连接池**把实际并发压到 CPU 核数量级（事务模式见[连接与 ORM 优化](/zh/performance/connection-and-orm-optimization)），这一条比任何内存参数都重要。
2. `work_mem` 保持全局保守值，给重查询的**角色或会话**单独 `SET`。
3. 并行度高的库把"worker 数 × work_mem"计入账本。
4. 知道 OOM killer 的行为：它杀的是整机内存占用最大的进程，往往直接命中正在跑大查询的 backend，整个连接（连同事务）一起消失，日志里通常能看到 `server process was terminated by signal 9`。

## 容易误解的参数

- **`effective_cache_size` 不分配任何内存**。它只是告诉优化器"一个查询预计能吃到多少 OS 页缓存 + shared_buffers"，影响的是选不选索引这类计划决策。设得离谱小会让优化器低估缓存命中、偏向串行扫描。
- `work_mem` 是**每操作**上限不是总量上限，调大它是放宽了溢盘阈值，不代表真会一次分配那么多（按需分配）。
- 临时文件（排序/哈希溢盘）不占共享内存也不占 work_mem 额度，只落 `temp_tablespaces` 指向的盘，见 `pg_stat_database.temp_bytes` 监控。

## 观测

会话级内存明细（PG 14+），谁在吃内存一目了然：

```sql
SELECT name, parent, level,
       pg_size_pretty(total_bytes) AS total,
       pg_size_pretty(used_bytes)  AS used
FROM pg_backend_memory_contexts
ORDER BY total_bytes DESC
LIMIT 15;
```

共享内存侧，`pg_buffercache` 扩展能按库/表统计 shared_buffers 的占用；后台写行为的视图在 PG 17 做了一次拆分——原 `pg_stat_bgwriter` 拆出 `pg_stat_checkpointer`（检查点与 restartpoint 统计），`pg_stat_bgwriter` 自己只保留后台写进程的缓冲写统计，调检查点参数时注意查新视图。

进程级的内存占用最终要回到 OS 看：

```bash
ps -o pid,rss,cmd -u postgres | sort -k2 -rn | head
```

## 注意事项与常见坑

- "调大了 `work_mem` 但排序还是溢盘"：先确认查询计划里是哪类节点在溢（`EXPLAIN ANALYZE` 的 `Sort Method`），再确认作用域是不是设在了错误的层级。
- `shared_buffers` 改动需要重启，`work_mem`/`effective_cache_size` 是 reload 级、还能会话级覆盖——排障时先 `SHOW` 当前会话的实际值，别只看配置文件。
- 一个连接空闲时只占几十 MB，内存峰值都发生在查询执行中；按"平均连接内存 × 连接数"做容量规划会严重低估。

## 参考资料

- [PostgreSQL 官方文档 · 19.4. Resource Consumption](https://www.postgresql.org/docs/current/runtime-config-resource.html)
- [PostgreSQL 官方文档 · 66.6. Database Page Layout](https://www.postgresql.org/docs/current/storage-page-layout.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [checkpoint-and-buffer](/zh/internals/checkpoint-and-buffer)
- [index](/zh/internals/index)
- [join-implementations](/zh/internals/join-implementations)
- [lock-system](/zh/internals/lock-system)
- [parallel-query](/zh/internals/parallel-query)
- [process-architecture](/zh/internals/process-architecture)
- [query-execution-pipeline](/zh/internals/query-execution-pipeline)
- [cloud-native-and-containers](/zh/operations/cloud-native-and-containers)- [进程架构](/zh/internals/process-architecture)——postmaster/backend/worker 全家福。
- [checkpoint 与 buffer](/zh/internals/checkpoint-and-buffer)——shared_buffers 的写入侧。
- [参数调优](/zh/performance/parameter-tuning)——这些参数在整体调优中的位置。
- [连接与 ORM 优化](/zh/performance/connection-and-orm-optimization)——把并发先压下来。

官方文档：<https://www.postgresql.org/docs/current/runtime-config-resource.html> 与 <https://www.postgresql.org/docs/current/storage-page-layout.html>
