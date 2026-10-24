# 参数调优

参数调优不是背数值表，而是理解每个参数「为谁分配资源、错了的代价是什么」。本页给一套从内存与硬件出发的起步指导值，说明修改参数的三条路径与生效方式，最后列出常见误配。所有改动都应先测后改，一次只动一个变量。

## 起步指导值

以下按一台专用数据库服务器（内存记为 RAM）给出起点，后面每项都有「为什么」：

```plaintext
shared_buffers = RAM × 25%            # 默认仅 128MB，必须改
effective_cache_size = RAM × 50%~75%  # 告诉 planner OS 缓存的体量
work_mem = 16MB~64MB 起步，按并发算上限
maintenance_work_mem = 512MB~1GB      # VACUUM/CREATE INDEX 用
random_page_cost = 1.1                # SSD/NVMe；默认 4.0 是机械盘时代值
max_wal_size = 4GB~8GB                # 默认 1GB 对写入多的库偏小
```

- `shared_buffers`：PG 自己的缓冲池。25% 是公认的起步值；给到 40% 以上收益递减——超出部分由 OS page cache 缓存同样的页，形成双缓存，两边各占一份内存。
- `effective_cache_size`：只影响 planner 对「走索引还是走顺序扫」的估计，**不分配任何内存**。给低了 planner 会低估索引扫描的收益。
- `work_mem`：**每个排序/哈希节点**的内存，不是每连接总量。全局值要按最坏并发估算：

```plaintext
最坏峰值 ≈ max_connections × 单查询平均排序/哈希节点数 × work_mem
```

  例：200 连接 × 平均 2 个节点 × 64MB = 25.6GB，叠加其他内存就可能 OOM。全局给小，个别复杂查询在会话里 `SET work_mem = '512MB'`。
- `maintenance_work_mem`：VACUUM、CREATE INDEX、REINDEX 等维护操作使用；大表重建索引时给到 1GB 明显更快。autovacuum worker 的份额另受 `autovacuum_work_mem` 约束。
- `random_page_cost`：planner 里一次随机页读取相对一次顺序读的成本。SSD/NVMe 上 1.1 是常见取值，让 planner 更敢走索引；机械盘保持默认 4.0。配套地 `effective_io_concurrency` 在 SSD 上也可提到 200 左右。
- `max_wal_size`：不是「最多只能写这么多 WAL」的硬限制，而是 checkpoint 间隔的软目标。写入多的库给小了，checkpoint 频繁，IO 抖动明显。

## 修改参数的三条路径

```sql
-- 1. ALTER SYSTEM：写入 postgresql.auto.conf，实例级生效，最常用
ALTER SYSTEM SET max_wal_size = '8GB';
SELECT pg_reload_conf();          -- reload 类参数即刻生效

-- 2. conf.d 目录：postgresql.conf 末尾通常有 include_dir = 'conf.d'，
--    把自有配置集中成一个文件，便于进版本管理和排查
-- 3. 直接编辑 postgresql.conf：手工管理裸机时使用
```

优先级：`postgresql.auto.conf`（ALTER SYSTEM 写入的）最后读取、覆盖 `postgresql.conf` 及其 include 的 conf.d。同一个参数散落在多处时，用 `SHOW max_wal_size;` 看生效值，用 `SELECT source FROM pg_settings WHERE name = 'max_wal_size';` 看它来自哪一层。

## 哪些要重启，哪些 reload 即可

看 `pg_settings.context`：

```sql
-- 改了但尚未重启生效的参数
SELECT name, setting, context, pending_restart
FROM pg_settings
WHERE pending_restart;
```

- `postmaster`：需要重启。`shared_buffers`、`max_connections`、`wal_level`、`autovacuum_max_workers` 都在此列。
- `sighup`：reload 即可，`pg_reload_conf()` 或 `pg_ctl reload`。`max_wal_size`、`checkpoint_timeout`、`log_min_duration_statement` 等大多属于这类。
- `superuser` / `user`：连 reload 都不需要，superuser 可全局 SET，普通用户可在自己会话里 SET（`work_mem`、`random_page_cost`）。这也是「个别复杂查询单独给大 work_mem」可行的原因。
- `internal`：initdb/编译期定死（如 `block_size`），不用管。

改完 reload 类参数后确认生效：`SHOW max_wal_size;`。

## 先测后改与单变量原则

- 每次只改一个参数，改完用基准或生产流量回放对比 TPS 与 p95 延迟（方法见[基准工具](/zh/performance/benchmark-tools)），观察一个完整业务周期再动下一个。
- 建立基线再动手：记录 pg_stat_statements 的 top 查询耗时、checkpoint 计数（`pg_stat_bgwriter`，PG 17 起拆出 `pg_stat_checkpointer`），改参前后对着同一批指标看。
- 改动落进配置文件并纳入版本管理；ALTER SYSTEM 适合应急，事后把值同步回 conf.d，避免两处漂移。
- 参数没有银弹：同一组值在不同负载（OLTP 小事务 vs 报表大查询）下表现完全不同，抄别人的配置不如建立自己的基线。

## 常见误配

- **work_mem 全局给大（512MB 起）**：它是每节点、每连接的，高峰期叠加出几十 GB，触发 OOM killer。全局保守，重查询按会话调。
- **shared_buffers 给到 60% 以上**：双缓存浪费内存，还增加锁管理开销；25% 起步，用测试验证再加。
- **把 effective_cache_size 当成会分配的内存**：它只是 planner 的假设值。反过来，`work_mem`、`maintenance_work_mem` 是真分配的，两者别搞混。
- **max_connections 动辄 1000**：每连接是独立进程，基础内存 + work_mem 叠加，调度开销也随连接数涨。用连接池收敛活动连接数，见 [连接数与 ORM 优化](/zh/performance/connection-and-orm-optimization)。
- **只调内存不调 max_wal_size**：写多的库 checkpoint 频繁触发刷盘风暴，把缓冲调优的收益吃掉，两边要一起看。

## 参考资料

- [PostgreSQL 官方文档 · 19.1. Setting Parameters](https://www.postgresql.org/docs/current/config-setting.html)
- [PostgreSQL 官方文档 · Chapter 19. Server Configuration](https://www.postgresql.org/docs/current/runtime-config.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [architecture-and-memory](/zh/internals/architecture-and-memory)
- [autovacuum-tuning](/zh/internals/autovacuum-tuning)
- [checkpoint-and-buffer](/zh/internals/checkpoint-and-buffer)
- [connection-management](/zh/operations/connection-management)
- [benchmark-tools](/zh/performance/benchmark-tools)
- [common-bad-plans](/zh/performance/common-bad-plans)
- [index](/zh/performance/index)
- [write-throughput-optimization](/zh/performance/write-throughput-optimization)- [optimizer 成本模型](/zh/internals/optimizer-cost-model)——random_page_cost 等如何影响计划选择。
- [checkpoint 与 buffer](/zh/internals/checkpoint-and-buffer)——max_wal_size 背后的机制。
- [写入吞吐优化](/zh/performance/write-throughput-optimization)——写路径上其他可用手段。
- [常见错误与排查](/zh/appendix/common-errors-and-troubleshooting)——OOM、内存超限等症状对照。

官方文档：<https://www.postgresql.org/docs/current/config-setting.html> 与 <https://www.postgresql.org/docs/current/runtime-config.html>
