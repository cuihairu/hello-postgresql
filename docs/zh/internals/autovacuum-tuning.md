# autovacuum 调优

autovacuum 由 launcher 进程周期性唤醒，为超过触发阈值的表派发 worker 执行 VACUUM/ANALYZE。默认参数面向「小表、低写入」，对大表和高更新负载往往过于保守，结果是死元组堆积、表和索引膨胀。调优的主要工作：让触发条件跟上表的更新速度，让限速参数跟上硬件的 IO 能力。

## 触发公式与默认值的坑

对每张表，满足下式时触发 vacuum：

```plaintext
死元组数 > autovacuum_vacuum_threshold（默认 50）
         + autovacuum_vacuum_scale_factor（默认 0.2）× 表内估算行数
```

scale_factor 按「死元组占比到 20% 再清」设计，对大表过松：1 亿行的表要积到约 2000 万死元组才触发，这期间每次扫描都在跳过 2000 万条垃圾，表和索引早已明显膨胀。analyze 的触发同理（`autovacuum_analyze_scale_factor`，默认 0.1）。

## 按表覆盖参数

对大表和热点表，按表覆盖是最有效的手段，不必全局一刀切：

```sql
ALTER TABLE big_table SET (
  autovacuum_vacuum_scale_factor = 0.01,   -- 1% 而不是 20%
  autovacuum_vacuum_threshold = 10000
);

-- 查看哪些表做了按表覆盖
SELECT n.nspname, c.relname, c.reloptions
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.reloptions IS NOT NULL
  AND n.nspname NOT IN ('pg_catalog', 'information_schema');
```

全局把 `autovacuum_vacuum_scale_factor` 降到 0.02~0.05 也是常见做法，代价是 vacuum 触发更频繁，需要确认 IO 预算（见下一节）。

## 限速：cost limit 与 cost delay

autovacuum 每处理一页/一条死元组消耗一定的「cost 积分」，积分超过 limit 就睡 delay 毫秒——这是 autovacuum 内建的 IO 限速器：

- `autovacuum_vacuum_cost_delay`：每次睡眠时长，默认 2ms（PG 12 起从 20ms 降下来，autovacuum 默认跑得更快了）；
- `autovacuum_vacuum_cost_limit`：积分上限，默认 -1 表示沿用 `vacuum_cost_limit`（默认 200）；
- **所有并发 worker 共享同一份预算**：3 个 worker 时每个实际只能用 limit/3，加 worker 数并不能等比加速清理，要同时提 cost_limit。

硬件好（NVMe、大缓冲池）而清理长期跟不上的实例，通常把 cost_limit 提到 1000~3000 或把 delay 降到 0~1ms；反过来，担心清理影响白天业务，就维持默认甚至加大 delay，让清理更慢更温和。

## naptime 与 worker 数

- `autovacuum_naptime`（默认 1 分钟）：launcher 每隔这么久醒来一轮，为需要清理的数据库派发 worker；naptime 越小，死元组从「产生」到「被发现」的延迟越小；
- `autovacuum_max_workers`（默认 3）：同时工作的 worker 上限。多库实例、热点集中的实例可加到 6~8；每个 worker 内存受 `autovacuum_work_mem` 约束（默认取 `maintenance_work_mem`），加 worker 要同时评估内存和共享 cost 预算。

## insert-only 表：vacuum_insert 触发（PG 13+）

只插入、从不更新删除的表（日志表、流水表）永远凑不齐死元组，按旧公式永远不会被 vacuum，于是老元组无法冻结、VM 不完整——影响事务 ID 回卷防御和 index-only scan。PG 13 增加了插入触发：

```plaintext
插入行数 > autovacuum_vacuum_insert_threshold（默认 1000）
         + autovacuum_vacuum_insert_scale_factor（默认 0.2）× 行数
```

满足即触发 vacuum（即使没有死元组），用于推进冻结、补全 VM。大流水表同样建议按表调小 insert_scale_factor。

## 排查：跑了没、为什么慢、为什么没用

```sql
-- 全局参数一览
SELECT name, setting, unit FROM pg_settings
WHERE name LIKE 'autovacuum%' ORDER BY name;
```

```sql
-- 各表死元组与清理历史；last_autovacuum 为空说明从未触发过
SELECT relname, n_live_tup, n_dead_tup, autovacuum_count, last_autovacuum
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 20;
```

```sql
-- 正在执行的 autovacuum 及其阶段
SELECT v.pid, v.phase, v.heap_blks_scanned, v.heap_blks_vacuumed, p.query
FROM pg_stat_progress_vacuum v
JOIN pg_stat_activity p ON p.pid = v.pid;
```

worker 在跑但 `n_dead_tup` 不降，通常是清理范围被挡住了——比「最老活跃快照」新的死元组一律不能清：

```sql
-- 谁把 xmin 地平线拉住了：长事务
SELECT pid, usename, state, now() - xact_start AS xact_age, backend_xmin, query
FROM pg_stat_activity
WHERE backend_xmin IS NOT NULL
ORDER BY xact_start
LIMIT 10;

-- 未消费的复制槽同样挡清理（standby 端保留旧版本）
SELECT slot_name, active, xmin, catalog_xmin
FROM pg_replication_slots
WHERE xmin IS NOT NULL OR catalog_xmin IS NOT NULL;
```

实例日志中每轮 autovacuum 结束有 `automatic vacuum of table ...` 记录，含各阶段耗时；日志显示清理一直在做、表却持续膨胀，方向就是上面两类「挡清理」检查。

## 注意事项与常见坑

- autovacuum 清不掉「正被某个事务需要」的版本：先治理长事务和弃用的复制槽，再谈调参，见 [VACUUM 停顿与性能](/zh/performance/vacuum-stall-and-performance)。
- 按表参数改动即时生效，无需重启。
- 全局激进调参（如 scale_factor 0.001）会让 vacuum 频繁扫描大表，与 cost_delay、worker 数一起评估总 IO 预算，其他内存与 IO 参数见 [参数调优](/zh/performance/parameter-tuning)。
- 手动 `VACUUM` 不受 autovacuum 限速参数控制（走 `vacuum_cost_limit` 本身），应急清理大表时注意它可能比 autovacuum 更猛。

## 参考资料

- [PostgreSQL 官方文档 · 24.1. Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html#AUTOVACUUM)
- [PostgreSQL 官方文档 · Chapter 51. Overview of PostgreSQL Internals](https://www.postgresql.org/docs/current/overview.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [constraints-and-data-quality](/zh/database-design/constraints-and-data-quality)
- [postgresql-17-features](/zh/ecosystem/postgresql-17-features)
- [when-to-choose-postgresql](/zh/ecosystem/when-to-choose-postgresql)
- [gin](/zh/indexing/gin)
- [index-bloat-and-maintenance](/zh/indexing/index-bloat-and-maintenance)
- [index](/zh/internals/index)
- [lock-conflict-troubleshooting](/zh/internals/lock-conflict-troubleshooting)
- [mvcc-and-multi-version](/zh/internals/mvcc-and-multi-version)
- [pg-stat-observation](/zh/internals/pg-stat-observation)
- [process-architecture](/zh/internals/process-architecture)
- [vacuum-and-hot](/zh/internals/vacuum-and-hot)
- [knowledge](/zh/knowledge)
- [disaster-recovery-drills](/zh/operations/disaster-recovery-drills)
- [statistics-and-analyze](/zh/performance/statistics-and-analyze)
- [vacuum-stall-and-performance](/zh/performance/vacuum-stall-and-performance)- [VACUUM 与 HOT](/zh/internals/vacuum-and-hot)——清理动作本身与 HOT 减负。
- [VACUUM 停顿与性能](/zh/performance/vacuum-stall-and-performance)——清理与业务争抢 IO 的场景。
- [参数调优](/zh/performance/parameter-tuning)——相关内存与 IO 参数全景。
- [索引膨胀与维护](/zh/indexing/index-bloat-and-maintenance)——膨胀的精确测量与 REINDEX。

官方文档：<https://www.postgresql.org/docs/current/routine-vacuuming.html#AUTOVACUUM>
