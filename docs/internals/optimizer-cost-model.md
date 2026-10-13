# 优化器代价模型

同一条 SQL 往往有多种执行方式，planner 用统一的"货币" cost 给每个候选计划估价，挑最便宜的。cost 不是毫秒，而是一组加权估算；只要比例关系可信，选出的计划就是对的。看懂代价模型的两个输入——代价参数与统计信息——就明白 EXPLAIN 里的 rows 和 cost 从哪来、为什么会错、错了怎么修。官方参考：[查询规划](https://www.postgresql.org/docs/current/planner-stats.html)。

## 代价单位与默认值

所有代价都是相对单位，默认把顺序读一页（8KB）定为 1.0：

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| seq_page_cost | 1.0 | 顺序读一页的代价基准 |
| random_page_cost | 4.0 | 随机读一页，比顺序贵 4 倍；SSD 上常调到 1.1~2.0 |
| cpu_tuple_cost | 0.01 | 处理一行（投影、过滤）的 CPU 代价 |
| cpu_index_tuple_cost | 0.005 | 索引扫描中处理一条索引项 |
| cpu_operator_cost | 0.0025 | 计算一个操作符或函数 |
| parallel_setup_cost | 1000 | 启动一次并行扫描的开销 |
| parallel_tuple_cost | 0.1 | 一行元组从 worker 传回 leader 的代价 |

EXPLAIN 输出的 `cost=0.42..42.17` 是 `[启动代价..总代价]`：启动代价是吐出第一行之前必须付出的部分——Sort 要吃完输入所以启动代价高，Index Scan 几乎为 0。LIMIT 类查询比较的是"启动代价 + 走 N 行的运行代价"，这就是小 LIMIT 常选中索引扫描的原因。

## rows 估算从哪来：pg_statistic

行数估算是一切代价计算的乘数，数据来自 pg_statistic（人读版是 pg_stats 视图），由 ANALYZE 采样维护——默认采 300 × statistics_target 行（target=100 时约 3 万行样本）：

```sql
SELECT attname, n_distinct,
       most_common_vals,     -- MCV：最常见的值
       most_common_freqs,    -- MCV 对应的出现频率
       histogram_bounds,     -- 直方图：非 MCV 值的分布分桶
       correlation           -- 物理存储顺序与索引顺序的相关性
FROM   pg_stats
WHERE  tablename = 'orders' AND attname = 'status';
```

- **MCV + 频率**：`status = 'paid'` 这类等值条件直接按频率估算。
- **直方图**：`amount < 1000` 这类范围条件按桶插值。
- **correlation**：决定 Index Scan 的随机页代价折扣——数据物理上越接近索引序，索引扫描越便宜。
- **n_distinct**：GROUP BY / JOIN 基数估算；负值表示比例（-0.3 即 30% 的行互不相同）。

## 组合列统计：CREATE STATISTICS（PG 10+）

planner 默认假设各列独立，相关列的组合条件会被乘法算错：

```sql
CREATE STATISTICS st_orders_city_district (dependencies, ndistinct)
  ON city, district FROM orders;
ANALYZE orders;
```

- `dependencies`（PG 10+）：函数依赖，修正"第一个条件筛过后第二个条件不再缩小范围"导致的低估。
- `mcv`（PG 12+）：组合列的 MCV 列表，修正高频组合的估算。
- `CREATE STATISTICS ON (lower(email))` 形式的表达式统计 PG 14 起支持。
- 观测视图：pg_stats_ext、pg_stats_ext_exprs。

## 估算错 → 计划错的典型链条

低估 join 结果行数是最常见的翻车路径：

```plaintext
rows 估成 100（实际 100 万）
  → 以为内表只被探测 100 次
  → 选 Nested Loop + Index Scan
  → 实际探测 100 万次，每次随机 IO
  → 计划"正确"地选了一个灾难
```

反向同样成立：高估行数会让优化器弃用索引改走全表扫描或 Hash Join。定位办法是 `EXPLAIN ANALYZE` 对比估算 rows 与 actual rows——偏差超过一个数量级就先修统计（ANALYZE、提高该列 statistics target、加扩展统计），而不是调参数，见[统计信息与 ANALYZE](../performance/statistics-and-analyze)与[常见坏计划](../performance/common-bad-plans)。

## 代价不是执行时间：比例才可信

- cost 只用于**同一优化器、同一套参数下**的计划间比较；不同版本、不同参数的 cost 不可跨库对比，更不能换算成毫秒。
- 但比例基本可信：同机同参数下，cost 2 倍的计划通常慢 2 倍上下——前提是 rows 估算正确。
- `random_page_cost` 与硬件强相关：HDD 上 4.0 合理，SSD/NVMe 上应下调（常见 1.1~2.0），否则优化器会系统性低估索引扫描的竞争力，`effective_cache_size` 同理要如实反映内存。
- 执行时间还叠加了代价模型之外的因素：缓存命中率、并发争用、JIT、网络传输。

## 调整统计精度

```sql
SHOW default_statistics_target;   -- 100

-- 全局调大：采样更准，ANALYZE 更慢、pg_statistic 更大
ALTER SYSTEM SET default_statistics_target = 200;
SELECT pg_reload_conf();

-- 推荐：只对关键列调大
ALTER TABLE orders ALTER COLUMN customer_id SET STATISTICS 500;
ANALYZE orders;
```

经验：出现在 WHERE / JOIN / GROUP BY 高频路径上的列、数据高度倾斜的列值得更高的 target；低基数均匀分布的列（如状态位）用默认值即可。target 调大不改变计划逻辑，只是让直方图与 MCV 更细腻。

## 注意事项与常见坑

- **新建表没 ANALYZE**：pg_statistic 为空，planner 用固定默认行数估算，计划随机离谱；批量导入后手动跑一次 ANALYZE。
- **表达式列没有统计**：`lower(email)`、`data->>'city'` 这类写法除非建了表达式索引或表达式统计，否则估算只有粗略默认值。
- **enable_xxx 开关不是调优手段**：它们只是把某类计划"抬高到不可接受"用于调试，线上应调 cost 参数、统计与索引，见 [join 实现](./join-implementations)。
- **pg_statistic 需要特权读**：普通用户查 pg_stats 视图即可，且只看得到自己有权限的表。
- 统计信息在变更后**不会自动立即更新**：autovacuum 的 analyze 触发阈值（`autovacuum_analyze_scale_factor`）在大表上意味着"几百万行变更后才分析"，关键表要靠定时任务。

## 参考资料

- [PostgreSQL 官方文档 · 19.7. Query Planning](https://www.postgresql.org/docs/current/runtime-config-query.html)
- [PostgreSQL 官方文档 · Chapter 51. Overview of PostgreSQL Internals](https://www.postgresql.org/docs/current/overview.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [统计信息与 ANALYZE](../performance/statistics-and-analyze)
- [EXPLAIN 基础](../performance/explain-basics)
- [join 实现](./join-implementations)
- [常见坏计划](../performance/common-bad-plans)
- [index](index.md)
- [join-implementations](join-implementations.md)
- [parallel-query](parallel-query.md)
- [plan-cache-and-generic-plan](plan-cache-and-generic-plan.md)
- [query-execution-pipeline](query-execution-pipeline.md)
- [knowledge](/knowledge.md)
- [common-bad-plans](/performance/common-bad-plans.md)
- [explain-analyze-buffers](/performance/explain-analyze-buffers.md)
- [explain-basics](/performance/explain-basics.md)
- [parameter-tuning](/performance/parameter-tuning.md)
- [statistics-and-analyze](/performance/statistics-and-analyze.md)
官方文档参考：[Planner Cost Constants](https://www.postgresql.org/docs/current/runtime-config-query.html)
