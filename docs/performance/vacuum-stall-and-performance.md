# VACUUM 卡顿对性能的影响

VACUUM 本身是「归还性能」的工作，但它要花 IO、抢 buffer、写 WAL——清理与业务共享同一块磁盘和同一个缓冲池。这里记录 autovacuum 限速机制的影响、表膨胀对查询的拖累、事务 ID 逼近上限时的强制清理，以及清理速度与业务负载的平衡。

## cost delay：autovacuum 的内建限速器

autovacuum 每处理一页消耗 cost 积分（命中 buffer 1 分、读入 2 分、弄脏 20 分），积分累计超过 limit（默认 200）就睡 delay 毫秒。两个参数控制这台风扇的转速：

```plaintext
autovacuum_vacuum_cost_delay = 2ms    # 每次睡眠时长（PG 12 起默认 2ms）
autovacuum_vacuum_cost_limit = -1     # -1 表示沿用 vacuum_cost_limit（默认 200）
```

两个关键行为：

- **所有 worker 共享一份预算**：limit 在并发 worker 之间「摊平」，3 个 worker 时每个实际限速 200/3。加 worker 数不等于更快清理，要连 cost_limit 一起提。
- **按表覆盖参数的 worker 不参与摊平**：对某表单独设过 `autovacuum_vacuum_cost_limit` 的 worker 独立计算，不影响全局预算的分配。

## vacuum 抢 buffer 与 IO 争用

vacuum 有意使用很小的环形缓冲（默认 256KB，PG 16 起可经 `vacuum_buffer_usage_limit` 调整），避免把热页挤出缓冲池——但争用仍然存在，路径有三条：

- **IO 带宽**：读脏页、写回脏页、预写 WAL，全部走业务同款磁盘；
- **WAL 流量**：清理动作本身产生 WAL（行清理记录、冻结记录），大量清理会推高 WAL 写入，见 [WAL 机制](../internals/wal-mechanism)；
- **checkpoint 压力**：集中弄脏的页促使 checkpoint 提前，刷盘风暴叠加在业务高峰上就是双重变慢。

所以 vacuum 卡顿的典型症状是「清理在跑的时段，p95 延迟整体抬升，CPU 却不高」——瓶颈在 IO 队列，不在算力。

## 表膨胀：所有查询一起变慢

清理跟不上时死元组堆积，表和索引膨胀。它不是只影响那张表，而是抬高全库基线：

- 顺序扫描要扫的物理页变多（垃圾页也要扫过去跳过）；
- 索引变厚，B-tree 层数与页数上升，每次点查多读几个块；
- index-only scan 依赖可见性映射（VM），VM 迟迟不完整时退回 heap fetch，走索引也读表。

膨胀的精确测量与 REINDEX 手法见[索引膨胀与维护](../indexing/index-bloat-and-maintenance)，清理动作与 HOT 优化见 [VACUUM 与 HOT](../internals/vacuum-and-hot)。

## xid age 逼近 20 亿：强制清理风暴

事务 ID 年龄逼近上限前，系统会分阶段强制推进清理：表 age 超过 `autovacuum_freeze_max_age`（默认 2 亿）就触发反回卷 vacuum——**即使全局关闭了 autovacuum 也会启动**，且不会被锁冲突自动取消。风险在于它往往不是一张表：多张大表同时过阈值，几轮全表扫描叠在共享的 cost 预算上，可能持续数小时乃至数天，期间 IO 被长期占用；拖到 age 只剩 300 万时系统拒绝分配新事务 ID，业务只读。

```sql
-- 每日巡检：全库 age 分布
SELECT datname, age(datfrozenxid) AS db_age
FROM pg_database
ORDER BY 2 DESC;

-- 找最老的表
SELECT relname, age(relfrozenxid) AS rel_age
FROM pg_class
WHERE relkind IN ('r', 't', 'm')
ORDER BY 2 DESC LIMIT 10;
```

把 age 纳入告警（如 5 亿预警、10 亿严重），在业务低峰主动清理，而不是等系统替你决定时机。告警落地见 [监控与告警](../operations/monitoring-and-alerting)。

## 监控哪些指标

```sql
-- 死元组占比与最近清理时间
SELECT relname,
       n_live_tup, n_dead_tup,
       round(n_dead_tup * 100.0 / greatest(n_live_tup, 1), 2) AS dead_pct,
       last_autovacuum, last_autoanalyze
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC LIMIT 20;

-- 正在跑的 vacuum 到哪一步了（PG 12+）
SELECT * FROM pg_stat_progress_vacuum;
```

- `dead_pct` 持续上涨、`last_autovacuum` 迟迟不更新：清理跟不上或被长事务挡住；
- `pg_stat_progress_vacuum` 看 phase 与 heap_blks_scanned/heap_blks_total，估算剩余时长；
- `log_autovacuum_min_duration`（默认 10min，可调小）让每轮清理的耗时和清理量进日志。

## 调 cost limit 的平衡点

目标只有一个：**清理速度 ≥ 垃圾产生速度**，且 IO 余量可接受。调整方向按硬件与业务取舍：

- 清理长期落后（dead_pct 爬坡）：提 `autovacuum_vacuum_cost_limit` 到 1000~3000，或把 delay 降到 0~1ms，配合按表参数给热点表更多份额；
- 业务高峰敏感：维持默认限速，改在低峰对大表手动 `VACUUM`。注意手动 VACUUM 走 `vacuum_cost_delay`（默认 0，不限速），比 autovacuum 猛得多，安排在窗口内执行；
- 优先减少垃圾产生量本身：高频 UPDATE 的小表降低触发阈值、能用 HOT 的更新保持 HOT 链，见 [autovacuum 调优](../internals/autovacuum-tuning)。

## 参考资料

- [PostgreSQL 官方文档 · 24.1. Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html#VACUUM-FOR-WRAPAROUND)
- [PostgreSQL 官方文档 · 14.1. Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [autovacuum-tuning](/internals/autovacuum-tuning.md)
- [vacuum-and-hot](/internals/vacuum-and-hot.md)
- [knowledge](/knowledge.md)
- [monitoring-and-alerting](/operations/monitoring-and-alerting.md)
- [index](index.md)
- [lock-and-concurrency-bottlenecks](lock-and-concurrency-bottlenecks.md)- [autovacuum 调优](../internals/autovacuum-tuning)——触发公式与参数全景。
- [VACUUM 与 HOT](../internals/vacuum-and-hot)——清理动作与 HOT 减负机制。
- [监控与告警](../operations/monitoring-and-alerting)——xid age 与膨胀的告警落地。
- [写入吞吐优化](./write-throughput-optimization)——从源头减少死元组的写法。

官方文档：<https://www.postgresql.org/docs/current/routine-vacuuming.html#VACUUM-FOR-WRAPAROUND>
