# 并行查询

PostgreSQL 从 9.6 起支持并行查询：执行一条查询时，发起查询的 backend（称为 leader）可以请求若干并行 worker 进程，各自扫描一部分数据做计算，再把结果汇总回来。它的目标场景是"单条大查询"——大表扫描、大聚合、大 join；OLTP 短查询通常用不到，也不该用。这一页讲清楚 worker 从哪来、代价怎么算、哪些计划能并行，以及怎么在 EXPLAIN 里确认并行真的发生了。

## leader 与 worker 进程模型

- 计划树顶端出现 `Gather`（乱序汇总）或 `Gather Merge`（保持排序的汇总）节点，表示这里有一个并行段（parallel aware 的子树）。
- leader 通过共享内存里的元组队列（tuple queue）接收各 worker 的输出；默认 leader 自己也参与扫描（`parallel_leader_participation = on`）。
- worker 不是常驻的，每条查询按需 fork、结束即退出。可用额度是三层逐级收紧的：

| 参数 | 含义 | 默认值 |
| --- | --- | --- |
| `max_worker_processes` | 整个实例后台进程总量（含复制、扩展） | 8 |
| `max_parallel_workers` | 其中允许用于并行的数量 | 8 |
| `max_parallel_workers_per_gather` | 单个 Gather 节点最多申请几个 | 2 |

- worker 不够用时查询不会失败：`Workers Launched` 会小于 `Workers Planned`，并行度自动下降，只剩 leader 也能跑。

## 哪些计划可以并行

可并行的执行节点是按版本逐步放开的，常见能力：

- 并行顺序扫描（9.6）；并行 index scan、index-only scan、bitmap heap scan（10）；并行 Append（11，配合分区表）。
- 并行 hash join（11，worker 共享一张哈希表，计划节点叫 Parallel Hash）、merge join、nested loop（外层并行）。
- 聚合：Partial/Finalize Aggregate（见下）；`SELECT DISTINCT`（15）。
- `CREATE INDEX`（btree 11 起，GIN/BRIN 也有）、`REFRESH MATERIALIZED VIEW`（14）。

不能并行或受限的场景：

- 游标（`DECLARE CURSOR` 后的 FETCH）、PL/pgSQL 里的 `FOR ... IN query` 循环，不会生成并行计划。
- 数据修改节点（ModifyTable，即 INSERT/UPDATE/DELETE 的写动作）始终在 leader 执行；但其下的扫描在 PG 11+ 可以并行（如 `INSERT INTO ... SELECT`）。
- **PARALLEL UNSAFE 的函数**：用户自定义函数默认就是 UNSAFE，计划里出现一个，整棵子树退回串行。这是"为什么我的查询不并行"最常见的原因之一。内置函数绝大多数是 SAFE。

```sql
CREATE FUNCTION is_hot(score numeric) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT score >= 90
$$;

-- 未标注 PARALLEL 属性时默认 UNSAFE，含该函数的查询不会并行
ALTER FUNCTION is_hot(numeric) PARALLEL SAFE;
```

## 并行代价与阈值参数

优化器用两步判断要不要并行、用几个 worker：

1. 表够不够大：只有超过 `min_parallel_table_scan_size`（默认 8MB）或 `min_parallel_index_scan_size`（默认 512KB）的表才有资格。表尺寸每翻一倍，候选 worker 数加一。
2. 代价划不划算：`parallel_setup_cost`（默认 1000，一次进程启动的开销）加 `parallel_tuple_cost`（默认 0.1，每个元组跨进程传递的开销）计入总代价，不比串行便宜就放弃。

控制并行度的三个入口：

```sql
-- 全局/会话级：完全关闭并行
SET max_parallel_workers_per_gather = 0;

-- 表级：直接指定该表的并行扫描度，绕过代价模型
ALTER TABLE big_fact SET (parallel_workers = 4);

-- 并行建索引的 worker 数（默认 2）
SET max_parallel_maintenance_workers = 4;
```

注意 `ALTER TABLE ... SET (parallel_workers)` 同时影响普通并行扫描和并行建索引，调优后建议 `RESET` 掉，避免长期影响别的计划。

## partial aggregate 与 finalize

聚合的并行分两段：worker 先各自算局部结果（Partial Aggregate），leader 收齐后再合并成最终值（Finalize Aggregate）。`GROUP BY` 需要按组归并时，会配 `Gather Merge` 保持有序输出。

```sql
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF)
SELECT status, count(*) FROM orders GROUP BY status;
```

```plaintext
Finalize GroupAggregate (actual rows=3 loops=1)
  ->  Gather Merge (actual rows=9 loops=1)
        Workers Planned: 2
        Workers Launched: 2
        ->  Partial GroupAggregate (actual rows=3 loops=3)
              ->  Sort (actual rows=666667 loops=3)
                    ->  Parallel Seq Scan on orders (actual rows=666667 loops=3)
```

要点：并行聚合要求聚合函数带 combine function，内置聚合都有；自定义聚合默认没有，自然无法并行。

## 在 EXPLAIN 里确认并行

`EXPLAIN`（不带 ANALYZE）只能看到 `Workers Planned`；加上 `ANALYZE` 才有 `Workers Launched`，并且每个 worker 的实际行数会显示缩进的 `loops=N`（多行累加，读法见 [EXPLAIN 基础](../performance/explain-basics)）：

```sql
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF)
SELECT count(*) FROM orders;
```

运行期间想看并行段在忙什么，`pg_stat_activity` 里 worker 的 `leader_pid` 指向它的 leader：

```sql
SELECT pid, backend_type, leader_pid, wait_event_type, wait_event
FROM pg_stat_activity
WHERE backend_type = 'parallel worker';
```

## maintenance_work_mem 与并行索引创建

并行建索引（btree/GIN/BRIN）时，`maintenance_work_mem` 是**整个建索引操作（leader + 所有 worker 合计）的上限**，而不是每人一份。官方要求每个 worker 至少能分到 32MB、leader 还要再留 32MB，所以预算不足会直接压低实际申请的 worker 数。给大表建索引想吃到并行，就要相应调大这个值（或按官方文档用 `ALTER TABLE ... SET (parallel_workers)` 显式指定）。

## 注意事项与常见坑

- 并行不等于更快：小表、全部命中缓存的表、高并发 OLTP 场景下，进程启动和元组传递的开销反而是负收益。判断依据是 `EXPLAIN ANALYZE` 前后对比，不是"越大越该并行"。
- `Workers Launched < Workers Planned` 多半是 `max_worker_processes`/`max_parallel_workers` 被其他会话占满，属正常降级，但意味着"设了 4 个 worker 却只起来 1 个"时调 `max_parallel_workers_per_gather` 无效，要看上一层额度。
- 并行 worker 的排序、哈希各自独立耗用 `work_mem`，并行度越高内存峰值越大，容量规划见[体系结构与内存](./architecture-and-memory)。
- 同一条 SQL 时而并行时而不并行（worker 抢占所致），排查性能抖动时先固定会话的 `max_parallel_workers_per_gather` 再对比。

## 相关页面

- [进程架构](./process-architecture)——backend 与后台进程从哪来。
- [join 实现方式](./join-implementations)——hash/merge/nested loop 的选择依据。
- [优化器代价模型](./optimizer-cost-model)——并行代价如何进入总成本。
- [EXPLAIN 基础](../performance/explain-basics)——读取并行计划的 loops 与行数。

官方文档：<https://www.postgresql.org/docs/current/how-parallel-query-works.html> 与 <https://www.postgresql.org/docs/current/parallel-planning.html>
