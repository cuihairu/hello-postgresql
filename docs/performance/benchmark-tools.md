# 基准工具

调优的每个决定都该有数字支撑，pgbench 是随 PostgreSQL 附带的标准压测工具：不用额外安装，能跑内置模型也能自定义事务组合，足以覆盖「参数 A/B」「硬件选型」「SQL 改写收益」这类日常验证。这里记录内置测试与自定义脚本、并发与数据规模、指标口径，以及对比实验的做法。

## 内置测试：tpcb-like 与它的三个变体

两步走：初始化建表灌数据，再压测。

```bash
# 初始化，scale factor 100：accounts 表 1000 万行，数据量 GB 量级
pgbench -h localhost -U postgres -i -s 100 benchdb

# 压测：32 客户端、8 线程、跑 5 分钟（默认内置脚本 tpcb-like）
pgbench -h localhost -U postgres -c 32 -j 8 -T 300 benchdb
```

`-b` 可选内置脚本：`tpcb-like`（默认，点查 + 更新余额 + 历史）、`select-only`（纯读）、`simple-update`（轻写）。对比「读多写少」与「写密集」时切换脚本比自写更快。

## 自定义脚本：随机参数与事务比例

脚本里用 `\set` 生成随机参数，模拟真实请求：

```plaintext
-- update-account.sql：随机账户转账
\set aid random_gaussian(1, 100000 * :scale, 10)
\set delta random(-5000, 5000)
BEGIN;
UPDATE pgbench_accounts SET abalance = abalance + :delta WHERE aid = :aid;
SELECT abalance FROM pgbench_accounts WHERE aid = :aid;
UPDATE pgbench_tellers SET tbalance = tbalance + :delta WHERE tid = :aid % (10 * :scale) + 1;
COMMIT;
```

- `random(lo, hi)` 均匀分布；`random_gaussian(lo, hi, threshold)` 集中在中部，模拟热点；`random_zipfian`（PG 11 起）模拟少数 key 占大头的倾斜访问——热点行的并发问题（见[锁与并发瓶颈](./lock-and-concurrency-bottlenecks)）就该用 zipfian 压出来。
- 事务比例用脚本权重控制，`@` 后是权重：

```bash
# 读 : 写 = 9 : 1
pgbench -c 32 -j 8 -T 300 -f read.sql@9 -f write.sql@1 benchdb
```

## scale factor 与并发设计

- **scale factor 定数据量**：accounts 行数 = 100000 × SF。SF 要选到让数据远大于 shared_buffers（压磁盘路径）或远小于（压 CPU/锁路径），两种定位别混在一条结果里。
- **并发定压测形态**：`-c` 是客户端数，`-j` 是线程数（每线程跑 c/j 个客户端）。客户端数从核数附近开始阶梯压（如 8/16/32/64/128），画出 TPS 与延迟曲线：TPS 停止上涨、延迟开始陡增的拐点，就是这套参数下的容量边界。
- 客户端数远超核数只会增加调度开销和锁排队，压出来的数字不代表生产。

## 指标口径

pgbench 收尾输出两类核心数：

```plaintext
number of transactions actually processed: ...
latency average = 12.345 ms          -- 平均每事务延迟（含等待，不含建连）
initial connection time = ...
tps = 2597.123456 (without initial connection time)
```

- **TPS**：每秒完成事务数，注意括号里是否含建连时间——短压测差异很大，压测时长 `-T` 给足 5 分钟以上可忽略；
- **latencyaverage**：平均延迟，只能看均值。分位数（p95/p99）pgbench 不直接给，用 `-l` 落逐笔日志后自行计算；`-P 10` 每 10 秒输出进度便于中途观察；
- `--rate N` 把客户端改成按固定到达率（泊松）发请求，配合 `--latency-limit` 定义「超过 X ms 即算失败」，测出来的延迟分布更接近生产形态——闭环比压测（有多少客户端就打多少压力）在高负载下会失真；
- `-r` 输出脚本里每条语句的平均延迟，定位脚本内哪个 SQL 拖后腿。

## 测试前后的固定动作

```sql
-- 1. 灌完数据必须 ANALYZE，否则规划器拿不到统计信息，结果不可信
ANALYZE;

-- 2. 记录压测前后的 checkpoint 与 WAL 计数，评估测试本身是否被刷盘干扰
SELECT checkpoints_timed, checkpoints_req FROM pg_stat_bgwriter;
-- PG 17 起 checkpoint 统计已拆到独立视图：
SELECT num_timed, num_requested FROM pg_stat_checkpointer;

SELECT wal_bytes FROM pg_stat_wal;   -- PG 14+，评估 WAL 写入量
```

- 压测时长覆盖至少 2~3 个 checkpoint 周期（默认 `checkpoint_timeout` 5 分钟），否则「正好没碰上 checkpoint」的幸运结果会误导对比；checkpoint 机制见 [checkpoint 与 buffer](../internals/checkpoint-and-buffer)。
- 对比实验里 checkpoint 相关参数（`max_wal_size`、`checkpoint_timeout`）必须两边一致。
- 先空跑一轮预热缓冲，丢弃这轮结果再正式计时。

## 对比 A/B 的实验设计

- **单变量**：一次只改一个东西（一个参数、一条 SQL、一种索引），其余环境锁死——同机器、同数据、同并发、同时长。
- **重复取中位数**：同一配置至少跑 3~5 轮，报中位数和波动幅度；单轮结果噪声可能超过你要证明的差距。
- **数据可复现**：每次用 `pgbench -i` 重建同一 scale 的数据集，或提前 dump 一份快照恢复后测。
- **记录环境**：实例参数快照（`SELECT name, setting FROM pg_settings WHERE source <> 'default';`）、硬件型号、PG 小版本都写进报告，三个月后还要能复现。
- 结论只写数字差与置信范围：「p95 从 12ms 降到 8ms，TPS 提升 18%」，而不是「明显变快」。

除 pgbench 外，sysbench、TPC-C 系实现（BenchmarkSQL、TPCC-UVA）与 HammerDB 可用于跨数据库或更复杂业务模型的压测，日常单机验证 pgbench 通常足够。

## 参考资料

- [PostgreSQL 官方文档 · pgbench](https://www.postgresql.org/docs/current/pgbench.html)
- [PostgreSQL 官方文档 · 14.1. Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [capacity-and-scaling-limits](capacity-and-scaling-limits.md)
- [index](index.md)
- [parameter-tuning](parameter-tuning.md)
- [write-throughput-optimization](write-throughput-optimization.md)- [参数调优](./parameter-tuning)——被测参数的取值依据。
- [写入吞吐优化](./write-throughput-optimization)——写路径优化的具体手段。
- [锁与并发瓶颈](./lock-and-concurrency-bottlenecks)——高并发下压测结果的解释框架。
- [checkpoint 与 buffer](../internals/checkpoint-and-buffer)——压测干扰源之一。

官方文档：<https://www.postgresql.org/docs/current/pgbench.html>
