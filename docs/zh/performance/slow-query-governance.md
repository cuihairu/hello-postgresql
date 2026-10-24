# 慢查询治理流程

零散地「感觉慢了就调一下」解决不了长期问题，慢查询治理需要一条固定流水线：采集 → 复现 → 定位 → 改写 → 验证。这里按这五步走一遍完整案例：一条商品订单列表 SQL 从生产 1.8 秒降到 0.2 毫秒的全过程。单件工具的细节在 [EXPLAIN (ANALYZE, BUFFERS, WAL)](/zh/performance/explain-analyze-buffers) 和 [pg_stat_statements](/zh/performance/pg-stat-statements)，本页聚焦流程本身。

## 第 1 步：采集——找到该治理的 SQL

两个采集源互补：日志抓「单次慢」的现场，pg_stat_statements 抓「累计贵」的常客。

```sql
-- postgresql.conf：记录超过 500ms 的语句（按需调整，0 记录全部、-1 关闭）
-- log_min_duration_statement = 500
```

```sql
-- 从 pg_stat_statements 拉平均耗时最高的常客
SELECT calls,
       round(mean_exec_time::numeric, 1) AS mean_ms,
       round(total_exec_time::numeric / 1000, 1) AS total_s,
       left(query, 90) AS query
FROM pg_stat_statements
WHERE calls > 100
ORDER BY mean_exec_time DESC
LIMIT 10;
```

案例起点：榜单第三名是 `SELECT ... FROM orders WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT $3`，mean_exec_time 1813ms、每小时约 4000 次。单次慢但低频的语句同样要治，只是优先级排序不同——总耗时影响数据库整体，平均耗时影响用户体感。

## 第 2 步：复现——生产参数 + EXPLAIN ANALYZE

拿到真实参数（从应用日志或 `pg_stat_activity` 抓一条实际调用），在与生产同量级的数据上执行：

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT order_id, amount, status, created_at
FROM orders
WHERE user_id = 40021 AND status = 'paid'
ORDER BY created_at DESC
LIMIT 20;
```

复现环境的选择：优先生产只读副本（读语句无副作用）；没有副本就在还原了生产数据量的预发环境跑。注意缓存冷热会让结果差几个数量级——先跑一次热身、再取第二次的数字；`user_id = 40021` 这种参数务必用真实值，热门用户和冷门用户的计划可能完全不同。

## 第 3 步：定位——坏节点、估错、缺索引

复现输出是定位的全部依据：

```plaintext
Limit (actual time=1798.512..1798.528 rows=20 loops=1)
  Buffers: shared hit=8824
  ->  Sort (actual time=1798.509..1798.514 rows=20 loops=1)
        Sort Key: created_at DESC
        Sort Method: top-N heapsort  Memory: 26kB
        ->  Seq Scan on orders
              (cost=0.00..38833.00 rows=1 width=34)
              (actual time=0.014..1560.201 rows=31852 loops=1)
              Filter: ((user_id = 40021) AND (status = 'paid'::text))
              Rows Removed by Filter: 968148
              Buffers: shared hit=8824
```

三个坏信号全部出现：

- **大表 Seq Scan**：100 万行全扫，`Rows Removed by Filter: 968148`——96.8% 的扫描白做。
- **估算失真**：估 rows=1、实际 31852 行，差五个数量级（该表批量导入后没跑过 ANALYZE）。
- **扫描后排序**：先取出 3 万多行再 top-N 堆排序，若索引能按 `created_at DESC` 直接给出顺序，排序可整体消掉。

对照 [常见坏计划](/zh/performance/common-bad-plans) 的模式清单，本例是「缺索引 + 统计过期」的叠加，且缺索引是主因。

## 第 4 步：改写——索引、SQL、结构

本例不需要改 SQL——语句写法合理，问题在访问路径。按「条件等值在前、排序键在后」设计复合索引：

```sql
CREATE INDEX CONCURRENTLY orders_user_status_created_idx
    ON orders (user_id, status, created_at DESC);
```

`CONCURRENTLY` 避免锁写，生产建索引用它（注意失败会留下 INVALID 索引，需删除重建）。索引列顺序的推敲：`user_id`、`status` 都是等值条件，谁前谁后都行；`created_at` 放最后正好为 `ORDER BY created_at DESC` 提供序，整个计划退化为对索引前几行的扫描。如果 `status='paid'` 占比极低且该组合是固定查询，还可以考虑部分索引 `WHERE status = 'paid'`，见 [部分索引](/zh/indexing/partial-indexes) 与 [复合索引设计](/zh/indexing/composite-index-design)。统计过期的问题顺手补上：

```sql
ANALYZE orders;
```

## 第 5 步：验证 A/B——前后对照与回归

同一条 EXPLAIN 命令再跑一遍，与第 2 步的输出逐项对照：

```plaintext
Limit (actual time=0.198..0.206 rows=20 loops=1)
  Buffers: shared hit=5
  ->  Index Scan using orders_user_status_created_idx on orders
        (actual time=0.193..0.199 rows=20 loops=1)
        Index Cond: ((user_id = 40021) AND (status = 'paid'::text))
        Buffers: shared hit=5
```

对照结果：无 Sort 节点、`Rows Removed by Filter` 消失、Buffers 从 8824 降到 5、耗时 1798ms → 0.2ms。验证清单按序过一遍：

1. **性能对照**：改前/改后的 `(ANALYZE, BUFFERS)` 输出并排存档，冷热缓存各跑一组。
2. **结果回归**：改写过 SQL 的必须比对结果集（行数、抽样行、聚合值）；只加索引的也确认一下排序结果与原来一致。
3. **线上确认**：第二天看 pg_stat_statements 里该语句的 mean_exec_time 与 temp_blks_written 是否归零，负载指标（IO、CPU）是否回落。

## 建立基线与持续跟踪

治理不是一次性的。沉淀三样东西，让下一轮有据可依：

- **基线快照**：每周把 top 20 语句的 calls/mean_exec_time/total_exec_time 快照到自建表，用差值发现劣化趋势。
- **告警阈值**：`log_min_duration_statement` 持续兜底单次慢查询；对 top 榜语句的 mean_exec_time 设环比阈值，突变即告警。规则设计见 [监控与告警](/zh/operations/monitoring-and-alerting)。
- **计划档案**：对核心 SQL 存一份 `(ANALYZE, BUFFERS)` 计划，升级大版本、改统计参数前后 diff，防止计划静默翻转；auto_explain（`auto_explain.log_min_duration`）可自动把超时语句的真实计划记进日志。

每次治理完成，把「症状 → 定位 → 修法」记进团队案例库，同类问题第二次出现时可以直接套用。

## 注意事项与常见坑

- 跳过复现直接在测试环境改：测试表几百行，计划与生产完全不同，结论不可靠。
- 复现时不用真实参数：估算正确的参数会掩盖参数敏感问题，热门值与冷门值要都试。
- 一次改多处再验证：说不清哪一处起效，还可能互相抵消；一改一验是纪律。
- 只看耗时不算数：耗时受缓存影响波动大，Buffers 与行数才是稳定证据；耗时也要多次取中位。
- 验证只在测试库做回归：改写 SQL 时结果集回归必须在同数据量的库上做，行数对不上就是语义变了。

## 参考资料

- [PostgreSQL 官方文档 · 14.1. Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)
- [PostgreSQL 官方文档 · Chapter 14. Performance Tips](https://www.postgresql.org/docs/current/performance-tips.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [pg_stat_statements](/zh/performance/pg-stat-statements)
- [EXPLAIN (ANALYZE, BUFFERS, WAL)](/zh/performance/explain-analyze-buffers)
- [常见坏计划](/zh/performance/common-bad-plans)
- [连接与 ORM 优化](/zh/performance/connection-and-orm-optimization)
- [pagination-and-sorting](/zh/advanced-sql/pagination-and-sorting)
- [connection-and-orm-optimization](/zh/performance/connection-and-orm-optimization)
- [index](/zh/performance/index)
- [lock-and-concurrency-bottlenecks](/zh/performance/lock-and-concurrency-bottlenecks)
- [pg-stat-statements](/zh/performance/pg-stat-statements)
- [troubleshooting-toolbox](/zh/tools/troubleshooting-toolbox)
官方文档：[性能提示](https://www.postgresql.org/docs/current/performance-tips.html)、[auto_explain](https://www.postgresql.org/docs/current/auto-explain.html)。
