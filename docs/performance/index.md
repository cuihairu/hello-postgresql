# 第6部分：查询调优与性能

EXPLAIN 读法、统计信息、pg_stat_statements、慢查询治理流程与参数调优——从发现问题到验证改进。

- [EXPLAIN 读法](explain-basics.md) —— cost/rows/字段含义、计划树从内到外。
- [EXPLAIN (ANALYZE, BUFFERS, WAL)](explain-analyze-buffers.md) —— 真实执行、缓存命中、IO 统计。
- [常见坏计划](common-bad-plans.md) —— 大表顺序扫描、rows 估错、nested loop 爆炸。
- [统计信息与 ANALYZE](statistics-and-analyze.md) —— 采样率、手动加大、过期统计。
- [pg_stat_statements](pg-stat-statements.md) —— top SQL、归一化、重置。
- [慢查询治理流程](slow-query-governance.md) —— 采集→复现→改写→验证 A/B。
- [连接与 ORM 优化](connection-and-orm-optimization.md) —— N+1、批量、prepared。
- [写入吞吐优化](write-throughput-optimization.md) —— 批量插入、unlogged 表、提交频率。
- [参数调优](parameter-tuning.md) —— shared_buffers/work_mem/effective_cache_size。
- [分区裁剪与裁剪失败](partition-pruning.md) —— 约束排除、运行时裁剪、分区键设计。
- [锁与并发瓶颈](lock-and-concurrency-bottlenecks.md) —— 长事务、热点行、advisory 锁队列。
- [VACUUM 卡顿对性能的影响](vacuum-stall-and-performance.md) —— IO 争用、age 阈值、监控。
- [基准工具](benchmark-tools.md) —— pgbench 自定义脚本、指标口径。
- [容量与扩展边界](capacity-and-scaling-limits.md) —— 单机上限、何时该分片。

---

- [内核机制](../internals/) · [索引体系](../indexing/) —— 调优背后的原理。
