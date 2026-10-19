# pg_stat 观测

PostgreSQL 内置的 `pg_stat_*` 视图家族是数据库观测的入口：会话在干什么、表被怎么读写、实例缓存命中率如何、IO 花在哪，全部不用装扩展就能看到。它们都是**累计计数器**（自某次清零/重启以来），读数本身没有意义，做差才有意义。这里按"会话 → 表 → 实例 → IO"四层过一遍最常用的视图与配套 SQL。语句级耗时统计见 [pg_stat_statements](../performance/pg-stat-statements)。

## 统计体系与 PG 15 的架构变化

PG 14 及以前，各进程把统计事件打包成 UDP 包发给独立的 stats collector 进程，聚合后写文件——高负载下 UDP 会**丢包**，统计偏差时有发生。PG 15 起改为**共享内存**：进程直接更新本地缓存并定期刷入共享内存，丢包问题消除，读取一致性也更好。

持久性变化值得记住：正常关机时统计数据保存到数据目录的 `pg_stat` 子目录、跨重启保留；但**崩溃恢复、立即停机、从基础备份或 PITR 启动后，所有计数器清零**。给监控配基线时要考虑重启后的缺口。

## pg_stat_activity：每个会话此刻在干什么

最有用的一组字段：`state`（active / idle / **idle in transaction**）、成对的 `wait_event_type` + `wait_event`（读写文件、等锁、等 CPU 各有名字）、`query`、`backend_type`、`leader_pid`（并行 worker 指向它的 leader）、以及 `backend_xmin`——该会话快照持有的最老事务 id，是它让 VACUUM 干不了活。

```sql
-- 活跃与非活跃画像：找 idle in transaction 和长事务
SELECT pid, usename, state, wait_event_type, wait_event,
       now() - xact_start AS xact_age,
       now() - state_change AS idle_age,
       left(query, 60) AS query, backend_xmin
FROM pg_stat_activity
WHERE backend_type = 'client backend'
ORDER BY xact_start NULLS LAST;

-- 谁 hold 住了最老的 xmin（阻碍 VACUUM 的人）
SELECT pid, usename, state, backend_xmin,
       age(backend_xmin) AS xmin_age
FROM pg_stat_activity
ORDER BY age(backend_xmin) DESC NULLS LAST
LIMIT 5;
```

解读 `wait_event` 的关键是成对看：`wait_event_type = Lock` 结合 `pg_blocking_pids(pid)` 查堵塞源；`IO` 表示在读写文件（正常忙）；`LWLock` 大量出现才需要深挖。完整的等待事件对照表见官方文档 monitoring-stats 一章。

## pg_stat_user_tables：表级读写画像

```sql
SELECT relname,
       seq_scan, seq_tup_read, idx_scan,
       n_tup_ins + n_tup_upd + n_tup_del AS writes,
       n_dead_tup, n_mod_since_analyze,
       last_autovacuum, last_autoanalyze
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 10;
```

典型读法：`seq_scan` 很高而 `idx_scan` 为 0 → 缺索引的候选；`n_dead_tup` 占比高或 `last_autovacuum` 为 NULL → autovacuum 跟不上（阈值与卡住排查见 [autovacuum 调优](./autovacuum-tuning)）；`n_mod_since_analyze` 很大 → 统计过期，计划可能失准。PG 13 起手动与自动 vacuum 计数分开（`vacuum_count` vs `autovacuum_count`），归因不再靠猜。

## pg_stat_database：实例级健康

```sql
SELECT datname,
       xact_commit, xact_rollback,
       round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2) AS cache_hit_pct,
       temp_files, pg_size_pretty(temp_bytes) AS temp_written,
       deadlocks
FROM pg_stat_database
WHERE datname NOT LIKE 'template%';
```

- `cache_hit_pct` 是 **shared_buffers** 命中率，99% 以上是常态；它不含 OS 页缓存，所以"命中率不高"不等于真的慢，要结合 `pg_stat_io` 看实际读盘量。
- `temp_files/temp_bytes` 增长 = 排序/哈希在溢盘，是 `work_mem` 偏小的直接信号。
- `xact_rollback / xact_commit` 比例异常升高通常指向应用里的死锁重试或连接池行为异常。

## pg_stat_io（PG 16+）

按 backend_type × IO 对象（relation/temp，PG 17 起 还有 wal）× 上下文（normal / vacuum / checkpoint）三维统计 reads、writes、hits、extends、evictions、fsyncs 等计数，`op_bytes` 标注单位。它把"IO 到底是谁产生的"第一次拆开了——比如 VACUUM 的读不再混进 normal 上下文：

```sql
SELECT backend_type, context, io_object,
       SUM(reads) AS reads, SUM(hits) AS hits, SUM(writes) AS writes
FROM pg_stat_io
WHERE io_object = 'relation'
GROUP BY backend_type, context, io_object
ORDER BY reads DESC;
```

`track_io_timing = on` 时还会记录 `read_time/write_time`（PG 17 加入），能直接回答"哪类进程在等 IO"。官方文档里给了成套的用法示例：client backend 读多说明缓存不够，checkpointer 写多说明检查点太激进等。

## reset 与统计的生命周期

```sql
SELECT pg_stat_reset();                              -- 清空当前库全部累计统计
SELECT pg_stat_reset_single_table_counters('orders'::regclass);  -- 只清一张表
SELECT pg_stat_statements_reset();                   -- 扩展 pg_stat_statements 单独清
```

使用纪律：清零是全局动作（本库范围），没有 undo，别在高峰期随手 reset；做 A/B 对比时"先记下当前值、隔段时间做差"比 reset 更安全。PG 15 起的崩溃清零行为见上文——重启后的第一天基线要重建。

## 注意事项与常见坑

- 所有视图都是**最终一致**的：进程攒一小段才刷入共享内存，`pg_stat_activity` 例外（它是实时快照，不是累计计数）。用计数器做秒级告警会出现锯齿。
- 统计收集本身有开销，但默认档位（`track_counts=on`、`track_activities=on`）是生产标配，关掉省不了多少还瞎了眼。
- 备库上的表级/实例级统计独立累计，主备数字不能直接相加比较。

## 参考资料

- [PostgreSQL 官方文档 · 27.2. The Cumulative Statistics System](https://www.postgresql.org/docs/current/monitoring-stats.html)
- [PostgreSQL 官方文档 · 27.2. The Cumulative Statistics System](https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-IO-VIEW)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [system-catalogs-and-metadata](/basics/system-catalogs-and-metadata.md)
- [materialized-views](/database-design/materialized-views.md)
- [postgresql-16-features](/ecosystem/postgresql-16-features.md)
- [architecture-and-memory](architecture-and-memory.md)
- [index](index.md)
- [process-architecture](process-architecture.md)
- [knowledge](/knowledge.md)
- [monitoring-and-alerting](/operations/monitoring-and-alerting.md)
- [explain-analyze-buffers](/performance/explain-analyze-buffers.md)
- [lock-and-concurrency-bottlenecks](/performance/lock-and-concurrency-bottlenecks.md)
- [pg-stat-statements](/performance/pg-stat-statements.md)
- [audit](/security/audit.md)
- [troubleshooting-toolbox](/tools/troubleshooting-toolbox.md)- [autovacuum 调优](./autovacuum-tuning)——n_dead_tup 异常的下一步。
- [pg_stat_statements](../performance/pg-stat-statements)——语句级耗时的另一半观测。
- [监控与告警](../operations/monitoring-and-alerting)——把本页 SQL 变成告警项。
- [EXPLAIN ANALYZE 与 buffers](../performance/explain-analyze-buffers)——单条查询粒度的 IO 观测。

官方文档：<https://www.postgresql.org/docs/current/monitoring-stats.html> 与 <https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-IO-VIEW>
