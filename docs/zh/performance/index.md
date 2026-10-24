# 查询调优与性能

EXPLAIN 读法、统计信息、pg_stat_statements、慢查询治理流程与参数调优——从发现问题到验证改进。

- [EXPLAIN 读法](/zh/performance/explain-basics) —— cost/rows/字段含义、计划树从内到外。
- [EXPLAIN (ANALYZE, BUFFERS, WAL)](/zh/performance/explain-analyze-buffers) —— 真实执行、缓存命中、IO 统计。
- [常见坏计划](/zh/performance/common-bad-plans) —— 大表顺序扫描、rows 估错、nested loop 爆炸。
- [统计信息与 ANALYZE](/zh/performance/statistics-and-analyze) —— 采样率、手动加大、过期统计。
- [pg_stat_statements](/zh/performance/pg-stat-statements) —— top SQL、归一化、重置。
- [慢查询治理流程](/zh/performance/slow-query-governance) —— 采集→复现→改写→验证 A/B。
- [连接与 ORM 优化](/zh/performance/connection-and-orm-optimization) —— N+1、批量、prepared。
- [写入吞吐优化](/zh/performance/write-throughput-optimization) —— 批量插入、unlogged 表、提交频率。
- [参数调优](/zh/performance/parameter-tuning) —— shared_buffers/work_mem/effective_cache_size。
- [分区裁剪与裁剪失败](/zh/performance/partition-pruning) —— 约束排除、运行时裁剪、分区键设计。
- [锁与并发瓶颈](/zh/performance/lock-and-concurrency-bottlenecks) —— 长事务、热点行、advisory 锁队列。
- [VACUUM 卡顿对性能的影响](/zh/performance/vacuum-stall-and-performance) —— IO 争用、age 阈值、监控。
- [基准工具](/zh/performance/benchmark-tools) —— pgbench 自定义脚本、指标口径。
- [容量与扩展边界](/zh/performance/capacity-and-scaling-limits) —— 单机上限、何时该分片。

---

- [内核机制](/zh/internals/index) · [索引体系](/zh/indexing/index) —— 调优背后的原理。

<!-- BACKLINKS-AUTO -->
## 相关页面

- [index](/zh/indexing/index)
- [index](/zh/internals/index)
- [index](/zh/tools/index)
