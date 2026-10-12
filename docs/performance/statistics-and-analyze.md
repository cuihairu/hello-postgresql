# 统计信息与 ANALYZE

优化器所有的 rows 估算都来自统计信息：每张表有多少行、每列有多少个不同值、哪些值最常见、值的分布落在哪些区间。这些数字由 `ANALYZE` 采样生成，绝大多数坏计划的根因都能追溯到「统计信息过期」或「统计粒度不够」。这一页讲统计信息的构成、autovacuum 与手动 ANALYZE 的触发时机、采样粒度控制，以及怎么从 `pg_stats` 里读出优化器眼中的数据分布。

## 统计信息里有什么

`ANALYZE` 把采样结果写进系统表 `pg_statistic`（超级用户才能直接读），日常用视图 `pg_stats` 查看：

```sql
SELECT attname, n_distinct,
       most_common_vals::text   AS mcv,
       most_common_freqs::text  AS freqs,
       correlation
FROM pg_stats
WHERE schemaname = 'public' AND tablename = 'orders'
  AND attname = 'status';
```

```plaintext
-[ RECORD 1 ]------------------------------------------------
attname     | status
n_distinct  | 4
mcv         | {done,paid,pending,canceled}
freqs       | {0.2603,0.2498,0.2451,0.2448}
correlation | 0.0012
```

四类核心数据决定了估算方式：

- **n_distinct**：不同值的个数。负数表示占总行数的比例（-0.3 即约 30% 的行互不相同），优化器据此估等值查询的选择率。
- **MCV（most_common_vals / most_common_freqs）**：最常见的值及其频率。`WHERE status = 'paid'` 的估算直接来自这里：0.2498 × 100 万 ≈ 24.98 万行。
- **直方图（histogram_bounds）**：把除 MCV 之外的值按相等行数切成桶。范围条件 `created_at < X` 的估算 = X 落在哪个桶、占几个桶的比例。
- **correlation**：物理存储顺序与逻辑排序的接近程度，影响优化器对范围扫描随机 IO 的定价。

直方图长这样：

```sql
SELECT histogram_bounds::text FROM pg_stats
WHERE tablename = 'orders' AND attname = 'user_id';
```

```plaintext
{1,1042,2076,3120,4187,5243, ... ,98771,99912}
```

100 万行被切成 100 个桶（默认 target 下），每桶约 1 万行；`user_id < 5000` 的估算就是数出 5000 前面有几个桶边界，占比约 5%。

## 采样方式与采样量

ANALYZE 随机抽取 `300 × statistics_target` 行（默认 target=100，即 3 万行），不是全表扫描，所以单表通常秒级完成。加 `VERBOSE` 能看到采样过程：

```sql
ANALYZE VERBOSE orders;
```

```plaintext
INFO:  analyzing "public.orders"
INFO:  "orders": scanned 10000 of 10000 pages, containing 1000000 live rows
        and 0 dead rows; 30000 rows in sample, 1000000 estimated total rows
ANALYZE
```

采样意味着估算天然有误差：样本里没出现过的长尾值，优化器只能按经验公式猜。对分布倾斜或长尾敏感的列，就要动 target（见下文）。

## autovacuum 顺带 ANALYZE 与触发阈值

autovacuum 在回收死元组之外也负责刷新统计：表的变更量（insert/update/delete 累计）超过阈值就触发一次 analyze。阈值公式：

```plaintext
autovacuum_analyze_threshold + autovacuum_analyze_scale_factor × 表行数
```

默认 `50 + 0.1 × 行数`：一万行的表变更 1050 次就触发，一百万行的表要变更 10 万零 50 次——大表的默认阈值明显偏钝。对变更频繁的大表单独收紧：

```sql
ALTER TABLE orders SET (
    autovacuum_analyze_scale_factor = 0.02,
    autovacuum_analyze_threshold = 1000
);
```

这样约 2.1 万次变更就会刷新统计。前提是 `track_counts = on`（默认开启），且 autovacuum 进程在运行；原理与整体调优见 [autovacuum 调优](../internals/autovacuum-tuning) 与 [VACUUM 与 HOT](../internals/vacuum-and-hot)。

## 手动 ANALYZE 与时机

autovacuum 的触发有延迟，几个场景必须手动来：

```sql
-- 批量导入/大批量 DELETE/UPDATE 之后：必做
COPY orders FROM '/path/orders.csv' WITH (FORMAT csv);
ANALYZE orders;

-- 只刷新个别列
ANALYZE orders (user_id, status);

-- 整库刷新（各表并行分阶段，快速建立基本盘）
vacuumdb --analyze-in-stages -d appdb;
```

`--analyze-in-stages` 在 pg_upgrade、逻辑备份恢复之后特别有用：先用最小代价让系统表和常查询的列拿到粗统计，避免恢复完立刻被烂计划打脸。常规业务里，「导入后必 ANALYZE」应写进数据流水线的固定步骤。

## default_statistics_target 与按列 SET STATISTICS

`default_statistics_target`（默认 100）控制两件事：采样行数（300 × target）和直方图桶数（target 个）。全局调大影响所有表；更精准的做法是按列设置：

```sql
-- user_id 的取值有 10 万个，默认 100 个桶太粗
ALTER TABLE orders ALTER COLUMN user_id SET STATISTICS 500;
ANALYZE orders (user_id);
```

什么时候该加大：范围查询估行明显偏差、直方图桶太稀疏、JOIN 键的 n_distinct 估错。什么时候不用动：布尔、状态这类低基数列，100 个桶绰绰有余。还有一层工具是扩展统计，针对「两列相关导致独立性假设失真」的场景（比如 city 与 postcode），见 `CREATE STATISTICS`（https://www.postgresql.org/docs/current/sql-createstatistics.html）。

## 统计过期的症状

统计过期有一个极具辨识度的症状：**估算 1 行（或几行），实际几万行**。因为空表时代的统计里 n_distinct 偏大、MCV 为空，等值条件被估成「几乎没有匹配」。自查清单：

```sql
-- 找出长期没有统计刷新的大表
SELECT relname, n_live_tup,
       last_analyze, last_autoanalyze, last_analyze_time, last_autoanalyze_time
FROM pg_stat_user_tables
WHERE n_live_tup > 100000
  AND coalesce(last_autoanalyze, last_analyze) < now() - interval '1 day';
```

伴随症状还有：执行时间与 cost 差距悬殊、计划里 `Rows Removed by Filter` 巨大、同一条 SQL 在 autoanalyze 前后计划突然翻转。遇到「昨天还好好的、今天突然慢」，先查统计刷新时间线，再查数据导入记录，见 [常见坏计划](./common-bad-plans) 中的实例。

## 加大采样的权衡

加大 target 的收益是估算更准：直方图桶更细、长尾值更容易进入 MCV、n_distinct 推断更稳。代价有三处：ANALYZE 时间与采样行数线性增长（target 1000 就是 30 万行样本）；`pg_statistic` 变大；规划器做选择率计算稍慢。实践建议：

- 默认 100 覆盖绝大多数列，不要全局翻倍「以防万一」；
- 出现过估算偏差的列，按列设到 200-1000，配合 `ANALYZE 该列` 验证估算是否收敛；
- 数据分布稳定的表（如按月分区的历史分区）不需要高 target，新数据写入活跃的表才需要。

判断标准永远是行为证据：`EXPLAIN` 里估算与实际的比值。没有证据就调采样，只是花更长的 ANALYZE 时间买安慰。

## 注意事项与常见坑

- `ANALYZE` 只刷新统计，**不回收死元组**——它不能替代 `VACUUM`，两者常被混为一谈。
- 统计信息不跨实例同步：逻辑复制订阅端、恢复出来的新实例都要自己跑一遍 ANALYZE。
- 采样有随机性，两次 ANALYZE 后计划可能不同；估算的置信度依赖样本量，这正是大 target 存在的理由。
- 表达式（如 `lower(email)`）上的查询要靠表达式索引附带的统计，普通列统计帮不上忙。
- 频繁 TRUNCATE + 重灌的中间表，autovacuum 可能长期不触发 analyze（行数清零又涨回），这类表要写进导入流程手动 ANALYZE。

## 相关页面

- [EXPLAIN 读法](./explain-basics)
- [常见坏计划](./common-bad-plans)
- [优化器代价模型](../internals/optimizer-cost-model)
- [autovacuum 调优](../internals/autovacuum-tuning)

官方文档：[规划器统计信息](https://www.postgresql.org/docs/current/planner-stats.html)、[例行清理](https://www.postgresql.org/docs/current/routine-vacuuming.html)。
