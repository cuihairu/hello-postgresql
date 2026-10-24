# pg_stat_statements

pg_stat_statements 是内置的 SQL 执行统计扩展：按归一化后的语句聚合总耗时、调用次数、行数、缓冲区与 WAL 用量，是「哪些 SQL 在长期消耗数据库资源」这个问题的标准答案。慢查询治理的第一步采集就靠它，完整流程见 [慢查询治理流程](/zh/performance/slow-query-governance)。

## 安装与启用

扩展分两步启用，缺一不可。第一步在 `postgresql.conf` 里把模块挂进共享内存（需要重启实例）：

```plaintext
# postgresql.conf
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.max = 10000        # 最多追踪多少条语句，默认 5000
pg_stat_statements.track = top        # top=只统计顶层语句（默认）；all=含嵌套
pg_stat_statements.track_utility = on # 是否统计 utility 语句（SET/COPY/PREPARE 等）
```

第二步在目标数据库里创建扩展：

```sql
CREATE EXTENSION pg_stat_statements;
SELECT * FROM pg_stat_statements LIMIT 1;   -- 能查到即生效
```

`shared_preload_libraries` 改完必须重启；只执行 `CREATE EXTENSION` 不重启，视图会存在但统计恒为空。想看规划阶段耗时与执行分开，PG 13+ 的列里已经有 `total_plan_time`，无需额外配置。托管云数据库通常已预载此扩展，`CREATE EXTENSION` 一下即可。

## 关键列

视图列很多，日常盯这几列：

| 列 | 含义 | 用途 |
| --- | --- | --- |
| `calls` | 调用次数 | 高频 + 低耗时的语句同样值得治理 |
| `total_exec_time` | 累计执行耗时（毫秒） | 按资源总消耗排序 |
| `mean_exec_time` | 平均单次耗时 = total/calls | 按单次体验排序 |
| `rows` | 返回或影响的累计行数 | rows/calls 异常大常意味着缺 LIMIT 或全量拉取 |
| `shared_blks_hit` / `shared_blks_read` | 命中/读取的缓冲区块 | 命中率低说明该查询把数据从磁盘搬进内存 |
| `temp_blks_written` | 写临时文件的块数 | 直接指向排序/聚合落盘，见 [Sort 落盘](/zh/performance/common-bad-plans) |
| `wal_bytes` | 产生的 WAL 字节量（PG 13+） | 评估写放大与复制压力 |
| `total_exec_time` 与 `total_plan_time`（PG 13+）分列 | 规划/执行分开计 | 规划占比高说明 SQL 过于复杂或统计抖动 |

PG 17 把 IO 计时列改名：`blk_read_time`/`blk_write_time` 变为 `shared_blk_read_time`/`shared_blk_write_time`，并新增 `local_blk_read_time` 等列，跨版本升级的监控 SQL 要跟着改。计时列需要 `track_io_timing = on` 才非零（有一定开销）。

## 查询归一化与 queryid

pg_stat_statements 按**查询结构**聚合：常量被折叠成 `$1` 占位符，`WHERE user_id = 42` 和 `WHERE user_id = 99` 算同一条语句，共享一个统计行。聚合键 `queryid` 是查询树解析后的哈希值：

```sql
SELECT queryid, calls, query FROM pg_stat_statements
WHERE query LIKE '%orders%' LIMIT 3;
```

```plaintext
queryid                 | calls | query
-7939279735244372691    | 85230 | SELECT * FROM orders WHERE user_id = $1
 6644210390673785246    |   931 | SELECT * FROM orders WHERE status = $1 LIMIT $2
```

要点与边界：

- `queryid` 跨重启、跨版本不保证稳定，长期对比要用归一化文本（`query` 列）做键，或自己按周期快照。
- 相同文本、不同 `search_path`/参数类型可能落成不同的 queryid，两个「一样」的查询分成两行属正常现象。
- 归一化对字面量生效，但不理解数据分布——`status = 'paid'`（25 万行）和 `status = 'weird-rare'`（1 行）合并统计，mean_exec_time 是混合平均，排查参数敏感问题时要用 `pg_stat_activity` 或日志里的实际参数。
- `track_utility = off` 可屏蔽 SET/COMMIT 这类噪音语句；`track = all` 会连函数体内的嵌套查询一起统计（开销略增）。

## Top 10 慢查询模板

两个常用排序口径：按资源总消耗（对数据库整体影响）和按单次平均耗时（对用户体验影响），过滤低频语句避免噪音：

```sql
-- 按总耗时：最吃资源的 10 条
SELECT calls,
       round(total_exec_time::numeric / 1000, 1)          AS total_s,
       round(mean_exec_time::numeric, 2)                  AS mean_ms,
       rows,
       round(100.0 * shared_blks_hit
             / nullif(shared_blks_hit + shared_blks_read, 0), 1) AS hit_pct,
       temp_blks_written,
       left(regexp_replace(query, '\s+', ' ', 'g'), 80)   AS query
FROM pg_stat_statements
WHERE calls > 100
ORDER BY total_exec_time DESC
LIMIT 10;

-- 按平均耗时：单次最慢的 10 条
SELECT calls, round(mean_exec_time::numeric, 2) AS mean_ms,
       left(query, 80) AS query
FROM pg_stat_statements
WHERE calls > 100
ORDER BY mean_exec_time DESC
LIMIT 10;
```

`hit_pct` 低于 90% 的读查询值得点进去看计划（大概率全表扫描）；`temp_blks_written` 非零说明排序落盘。把这两条 SQL 放进监控看板定期截图或落表，就是治理基线，模板见 [监控与告警](/zh/operations/monitoring-and-alerting)。

## reset 与采集周期

统计自扩展启用起累积，`pg_stat_statements_reset()` 清零（PG 14+ 支持按用户/库/单条 queryid 精确重置），`pg_stat_statements_info` 记录上次重置时间与淘汰次数：

```sql
SELECT pg_stat_statements_reset();            -- 全部清零
SELECT pg_stat_statements_reset(NULL, NULL, -7939279735244372691);  -- PG 14+，重置单条
SELECT dealloc, stats_reset FROM pg_stat_statements_info;
```

两种使用节奏：

- **累积观察**：不清零，定时（如每小时）把感兴趣的行快照到自建表，用差值算「这个小时的增量耗时」，适合长期基线。
- **周期重置**：每天/每周 reset 后累积一个周期再看全量排名，适合临时专项排查。

`dealloc` 持续增长说明 `pg_stat_statements.max` 太小、热门条目被挤出，调大后需重启。注意 reset 影响所有读这个视图的监控，先和团队对齐再动手。

## 与 pg_stat_activity 的互补

两者回答不同时态的问题：

- **pg_stat_statements 是历史聚合**：过去这段时间里谁最耗时、被调了多少次，回答「该治理谁」。
- **pg_stat_activity 是当前快照**：此刻每个连接在跑什么、处于什么状态、等哪把锁，回答「现在谁在拖慢谁」。

典型配合：pg_stat_statements 发现某语句 mean_exec_time 从 5ms 涨到 500ms，用 `pg_stat_activity` 看它当前卡在哪个等待事件上：

```sql
SELECT pid, wait_event_type, wait_event, state, left(query, 60) AS query
FROM pg_stat_activity
WHERE state <> 'idle' AND wait_event_type IS NOT NULL;
```

`wait_event_type = Lock` 转锁排查（[锁冲突排查](/zh/internals/lock-conflict-troubleshooting)），`IO/DataFileRead` 转缓存与扫描问题，`LWLock/buffer_content` 多为热点块竞争。

## 注意事项与常见坑

- 忘配 `shared_preload_libraries` 是最常见故障：`CREATE EXTENSION` 成功但统计恒为空，重启后才有数据。
- `total_exec_time` 不含网络传输与客户端处理时间，应用侧感受到的延迟可能远大于它。
- 归一化把不同参数合并统计，参数倾斜场景要用日志或 `pg_stat_activity` 复核单次执行。
- `track = all` 在大量调用 PL/pgSQL 函数的库上开销明显，确认需要再开。
- 视图查询本身也有成本，高频轮询监控建议间隔不低于 10 秒，并固定查询列避免全行展开。
- 扩展升级（`ALTER EXTENSION pg_stat_statements UPDATE;`）跨大版本时会重置统计，升级窗口要预期到。

## 参考资料

- [PostgreSQL 官方文档 · 14.1. Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)
- [PostgreSQL 官方文档 · Chapter 14. Performance Tips](https://www.postgresql.org/docs/current/performance-tips.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [慢查询治理流程](/zh/performance/slow-query-governance)
- [EXPLAIN (ANALYZE, BUFFERS, WAL)](/zh/performance/explain-analyze-buffers)
- [统计观察](/zh/internals/pg-stat-observation)
- [extension-management](/zh/ecosystem/extension-management)
- [when-to-choose-postgresql](/zh/ecosystem/when-to-choose-postgresql)
- [pg-stat-observation](/zh/internals/pg-stat-observation)
- [plan-cache-and-generic-plan](/zh/internals/plan-cache-and-generic-plan)
- [process-architecture](/zh/internals/process-architecture)
- [query-execution-pipeline](/zh/internals/query-execution-pipeline)
- [version-upgrade](/zh/operations/version-upgrade)
- [common-bad-plans](/zh/performance/common-bad-plans)
- [index](/zh/performance/index)
- [slow-query-governance](/zh/performance/slow-query-governance)
官方文档：[pg_stat_statements](https://www.postgresql.org/docs/current/pgstatstatements.html)、[统计收集器](https://www.postgresql.org/docs/current/monitoring-stats.html)。
