# 排障工具箱

生产库变慢时，先抓现场，再找根因。三板斧：**pg_stat_activity 看现场**（现在谁在跑）、**auto_explain 自动记录计划**（慢语句为什么慢）、**log_min_duration_statement 与 log_lock_waits 留证据**（事后复盘）。前两项是"此刻"，后两项是"过去"。

## 一、pg_stat_activity：抓现场

每个后端进程一行记录，`pid`、`usename`、`application_name`、`state`（active / idle / idle in transaction）、`wait_event_type` 与 `wait_event`、`xact_start`、`query_start`、`query` 是最常用的列。`application_name` 值得在应用连接串里配好，见[客户端驱动](./client-drivers)。

### 谁在跑：按执行时长排序

```sql
SELECT pid, usename, application_name, client_addr, state,
       wait_event_type, wait_event,
       now() - query_start AS stmt_age,
       left(query, 100) AS query
FROM pg_stat_activity
WHERE backend_type = 'client backend'
ORDER BY stmt_age DESC NULLS LAST;
```

`state = active` 且 `stmt_age` 很大的行是优先目标；`wait_event` 非空时先看它——类型是 `Lock` 说明卡在锁上，`Client` 说明卡在等客户端取数据，`IO` 说明卡在磁盘。

### 谁在等锁

`pg_blocking_pids()` 直接给出阻塞者列表，比手工比对 `pg_locks` 快：

```sql
SELECT a.pid AS blocked_pid,
       b.pid AS blocking_pid,
       now() - a.query_start AS waiting_ms,
       left(a.query, 80) AS blocked_query,
       left(b.query, 80) AS blocking_query
FROM pg_stat_activity a
JOIN LATERAL unnest(pg_blocking_pids(a.pid)) AS t(pid) ON true
JOIN pg_stat_activity b ON b.pid = t.pid
WHERE cardinality(pg_blocking_pids(a.pid)) > 0;
```

阻塞者往往是 `idle in transaction`——事务开了不提交，持有行锁不释放。完整锁冲突排查见[锁冲突排查](../internals/lock-conflict-troubleshooting)。

### 长事务与处理动作

```sql
SELECT pid, usename, application_name, state,
       now() - xact_start AS xact_age,
       left(query, 80) AS last_query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY xact_age DESC;
```

处理手段从轻到重：`pg_cancel_backend(pid)` 只中断当前语句，`pg_terminate_backend(pid)` 直接断连接（未提交事务被回滚）。中断前先确认会话来源和业务影响，误杀活跃业务连接比留着它更糟。

## 二、auto_explain：自动记录慢计划

手工 `EXPLAIN` 只对已知语句有效，而慢查询往往是"事先不知道"的。`auto_explain` 会在线程结束时把超过阈值的语句计划写进日志：

```bash
# 1) 先加载模块（shared_preload_libraries 修改后需要重启，不能 reload）
ALTER SYSTEM SET shared_preload_libraries = 'auto_explain';
SELECT pg_reload_conf();   -- 此处不生效，需要重启实例

# 2) 配置阈值与输出内容（这两项 reload 即可）
ALTER SYSTEM SET auto_explain.log_min_duration = '500ms';
ALTER SYSTEM SET auto_explain.log_analyze = on;
ALTER SYSTEM SET auto_explain.log_parameter_max_length = 64;
SELECT pg_reload_conf();
```

参数语义：

- `log_min_duration`：超过该毫秒数的语句才记录，`-1` 表示关闭（默认值，即装完模块也要显式打开）；
- `log_analyze = on`：计划里带 `actual time`/`rows`，才能判断估算是否偏离；
- `log_parameter_max_length`：记录参数值的最大长度，`-1` 为完整记录；
- `sample_rate`（默认 1.0）：只记录指定比例的语句，全表扫描类高频语句可设为 `0.01` 降噪；
- `log_buffers = on`：附加缓冲区命中率信息，配合[EXPLAIN 的 BUFFERS 选项](../performance/explain-analyze-buffers)一起看。

一段真实输出与读法：

```plaintext
2026-10-12 07:04:19.594 UTC [147] LOG:  duration: 400.193 ms  plan:
	Query Text: SELECT pg_sleep(0.4) IS NULL AS slept;
	Result  (cost=0.00..0.01 rows=1 width=1) (actual time=400.178..400.179 rows=1 loops=1)
```

- `duration: 400.193 ms` 是整条语句耗时，超过 `log_min_duration` 才被记录；
- `Query Text:` 是原始语句（参数值受 `log_parameter_max_length` 控制）；
- 因为开了 `log_analyze`，计划行带 `(actual time=... rows=...)`；`cost` 与 `actual time` 数量级差太多，说明统计信息过期或估算失准，这是接下来要 `ANALYZE` 的信号；
- `loops=1` 表示节点只执行一次；子节点 `loops` 远大于父节点是嵌套循环放大的典型特征。

一个限制：auto_explain 只在**语句结束后**记录，运行中的查询没有计划可看。在长查询执行期间"定时输出中间计划"的机制在社区讨论多年，截至 PG 17 尚未进入正式版本；运行中的现场信息只能从 `pg_stat_activity` 的 `state`、`wait_event` 判断，要复现计划只能等它跑完或手工 `EXPLAIN`。

## 三、log_min_duration_statement 与 log_lock_waits

`log_min_duration_statement` 是核心的慢语句开关，只记原始语句和耗时，不带计划：

```bash
ALTER SYSTEM SET log_min_duration_statement = '500ms';   -- -1 关闭，0 记全部
ALTER SYSTEM SET log_parameter_max_length = 128;         -- 控制参数值记录长度
SELECT pg_reload_conf();
```

`log_lock_waits` 记录等锁超过阈值仍未拿到的会话，是定位锁链的关键：

```bash
ALTER SYSTEM SET log_lock_waits = on;
ALTER SYSTEM SET deadlock_timeout = '1s';   -- 等待多少后输出日志（同时也是死锁检测阈值）
SELECT pg_reload_conf();
```

真实输出（复现了一个未提交事务阻塞后续更新）：

```plaintext
2026-10-12 07:05:59.889 UTC [201] LOG:  process 201 still waiting for ShareLock on transaction 771 after 200.119 ms
2026-10-12 07:06:01.859 UTC [201] LOG:  process 201 acquired ShareLock on transaction 771 after 2170.628 ms
```

`still waiting for ShareLock on transaction 771` 表明它在等**某个未提交事务**，而不是某张表的锁；`deadlock_timeout` 是"等多久才输出这条日志"的阈值（本例设为 200ms 便于观察），同时也是死锁检测的触发周期。第二行 `acquired ... after 2170.628 ms` 说明最终拿到锁，总等待 2.17 秒——这类日志密集出现时，去 pg_stat_activity 里按 `xact_start` 找那个迟迟不提交的事务即可。

## 组合用法

先用 `pg_stat_activity` 定位是谁在跑、卡在什么 `wait_event`；`Lock` 类的去翻 `log_lock_waits` 找阻塞者；`CPU`/`IO` 类的去翻 `auto_explain` 日志看计划，判断是缺索引、还是统计信息过期导致估算失准。三条线串起来，慢查询治理的循环才闭合，见[慢查询治理](../performance/slow-query-governance)。

## 参考资料

- [PostgreSQL 官方文档 · psql](https://www.postgresql.org/docs/current/app-psql.html)
- [PostgreSQL 官方文档 · F.32. pg_stat_statements — track statistics of SQL planning and execution](https://www.postgresql.org/docs/current/pgstatstatements.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [pg_stat 观察视图](../internals/pg-stat-observation)
- [锁冲突排查](../internals/lock-conflict-troubleshooting)
- [慢查询治理](../performance/slow-query-governance)
- [psql 高阶](./psql-advanced)
- [common-errors-and-troubleshooting](/appendix/common-errors-and-troubleshooting.md)
- [client-drivers](client-drivers.md)
- [index](index.md)
- [pgadmin-4](pgadmin-4.md)
- [psql-advanced](psql-advanced.md)
官方文档：[监控与统计](https://www.postgresql.org/docs/current/monitoring-stats.html)、[auto_explain](https://www.postgresql.org/docs/current/auto-explain.html)、[日志配置](https://www.postgresql.org/docs/current/runtime-config-logging.html)。
