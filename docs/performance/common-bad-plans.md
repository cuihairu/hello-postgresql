# 常见坏计划

绝大多数慢查询都能归到几类坏计划上：该用索引却在顺序扫、估算失真导致连接方式选错、Nested Loop 外层过大、排序落盘、以及 DISTINCT 与 ORDER BY 各排一遍。这一页给每类坏计划的计划特征、成因与修复方法，最后收拢成「诊断 → 修复 → 复验」三步法。所有示例基于 [EXPLAIN 读法](./explain-basics) 里的 users/orders 表。

## 大表 Seq Scan

计划特征：百万行表上出现 `Seq Scan`，且 `Rows Removed by Filter` 数量巨大。三种常见成因与对应修法：

```sql
-- 成因 1：条件列上根本没有索引 → 建索引
EXPLAIN ANALYZE SELECT * FROM orders WHERE user_id = 42;

-- 成因 2：函数包裹了索引列，普通索引用不上 → 改写为范围条件，或建表达式索引
EXPLAIN ANALYZE SELECT count(*) FROM orders
WHERE date(created_at) = current_date;                  -- Seq Scan
EXPLAIN ANALYZE SELECT count(*) FROM orders
WHERE created_at >= current_date
  AND created_at < current_date + interval '1 day';     -- 有 created_at 索引则走索引

-- 成因 3：统计过期，优化器以为匹配行很多 → 补 ANALYZE
ANALYZE orders;
EXPLAIN SELECT * FROM orders WHERE status = 'paid';
```

注意：不是所有 Seq Scan 都是坏计划——要取全表 10% 以上行时，顺序扫往往比索引快。判断标准是「扫描成本」与「实际需要的行数」是否匹配，而不是节点名字本身。函数包裹导致索引失效的完整清单见 [索引失效与误用](../indexing/index-failure-and-misuse)。

## rows 估错：估 1 行、实际 10 万

典型剧本：表由脚本批量导入，导入前跑过一次 `ANALYZE`（当时接近空表），之后没再统计。优化器对 `status = 'paid'` 估 1 行，于是选择 Nested Loop，实际却要处理 25 万行：

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT o.order_id, u.name
FROM orders o JOIN users u ON u.user_id = o.user_id
WHERE o.status = 'paid';
```

```plaintext
Nested Loop (cost=0.42..233.10 rows=1 width=24)
            (actual time=0.062..41883.224 rows=250010 loops=1)
  ->  Seq Scan on orders o (cost=0.00..224.75 rows=1 width=16)
        Filter: (status = 'paid'::text)
        Rows Removed by Filter: 999999
  ->  Index Scan using users_pkey on users u (cost=0.42..8.44 rows=1 width=8)
        Index Cond: (user_id = o.user_id)
```

对照三处就能确诊：估 rows=1、实际 rows=250010；`Rows Removed by Filter` 接近全表；执行时间比 cost 高出几个数量级。修复一步到位：

```sql
ANALYZE orders;
```

统计刷新后，同样的查询会变成 Hash Join（估 25 万行、实际 25 万行），耗时从几十秒降到几百毫秒。估算为什么不准、如何让估算变准，见 [统计信息与 ANALYZE](./statistics-and-analyze)；背后的定价机制见 [优化器代价模型](../internals/optimizer-cost-model)。

## Nested Loop 大外层爆炸

Nested Loop 的总代价 ≈ 外层行数 × 单次内层查找代价。它在外层只有几行时是最优选择，外层一大就线性放大：

```plaintext
Nested Loop (actual time=0.048..2380.441 rows=500010 loops=1)
  ->  Index Scan using users_region_idx on users u
        (cost=0.42..8.45 rows=1 width=16)
        (actual time=0.031..45.203 rows=50000 loops=1)     -- 估 1 行，实际 5 万
        Index Cond: (region = 'north')
  ->  Index Scan using orders_user_id_idx on orders o
        (cost=0.00..8.12 rows=10 width=16)
        (actual time=0.001..0.045 rows=10.0 loops=50000)   -- 5 万次索引探测
        Index Cond: (user_id = u.user_id)
        Buffers: shared hit=350214
```

识别要点：内层节点 `loops` 是五位数以上、`Buffers` 高达几十万。成因通常是外层估错（上例估 1 行实际 5 万），也可能是数据量涨了、旧的「小外层」假设失效。修复顺序：先补统计让估算恢复准头，估算正确时优化器会自动改用 Hash Join；如果确实需要 Nested Loop（比如外层注定小），确认内层连接列有索引且查询列能走 Index Only Scan。别忘了实际时间要乘 loops——0.045 ms × 50000 ≈ 2.2 秒。

## Sort 落盘

计划特征：

```plaintext
Sort (cost=92314.83..94814.83 rows=1000000 width=46)
     (actual time=998.311..1120.455 rows=1000000 loops=1)
  Sort Key: created_at
  Sort Method: external merge  Disk: 58000kB
  Buffers: shared hit=8801, temp read=7500 written=7502
```

`external merge Disk: 58000kB` 说明排序数据超过了 work_mem（默认 4MB），一部分写到临时文件再归并，速度掉一个数量级。修复按优先级：

1. **用索引消掉排序**：`ORDER BY created_at DESC LIMIT 20` 这类场景，建 `(created_at)` 索引后计划直接变成 Index Scan，无需 Sort 节点。
2. **减少排序的数据量**：只取需要的列（width 变小）、先过滤再排序、加 LIMIT 用 top-N heapsort。
3. **调大 work_mem**：只对会话生效的改法最安全——`SET work_mem = '64MB';` 后再跑查询；全局调大要评估并发连接数 × 每个排序的内存占用，见 [参数调优](./parameter-tuning)。

同类的落盘还有 HashAggregate 的 `Batches: N`（N>1 即分组落盘）和 Hash Join 的溢出，判断方法一样。

## DISTINCT + ORDER BY 双重排序

去重键和排序键不一致时，计划里会出现两层排序（或一层哈希去重 + 一层排序）：

```sql
EXPLAIN
SELECT DISTINCT user_id, status, created_at::date AS d
FROM orders
ORDER BY d;
```

```plaintext
Sort  (cost=72833.02..73833.02 rows=400000 width=22)
      (actual time=1023.44..1101.20 rows=3600 loops=1)
  Sort Key: ((created_at)::date)
  Sort Method: external merge  Disk: 9432kB
  ->  HashAggregate  (cost=42833.00..46833.00 rows=400000 width=22)
        Group Key: user_id, status, ((created_at)::date)
        ->  Seq Scan on orders  (cost=0.00..37833.00 rows=1000000 width=22)
```

内层为去重维护了 40 万个分组，外层再整体排序一次，两步的代价都不小。修复思路是**让排序键与去重键对齐，把两步合并成一步**：

```sql
-- 排序键是去重键的前缀时，一个 Sort 完成 Unique + ORDER BY
SELECT DISTINCT user_id, status FROM orders ORDER BY user_id, status;
```

```plaintext
Unique  (cost=48836.94..51211.94 rows=4 width=18)
  ->  Sort  (cost=48836.94..50024.44 rows=1000000 width=18)
        Sort Key: user_id, status
```

业务上确实需要按非去重键排序时，接受一次额外排序，或者评估改用 `GROUP BY` + 聚合语义（比如取 `min(created_at)`）来减少分组基数。

## 诊断 → 修复 → 复验三步法

遇到慢查询，按固定节奏走，不要跳步：

1. **诊断**：`EXPLAIN (ANALYZE, BUFFERS)` 跑一遍，自上而下找「time × loops」最大的节点；同时检查每个节点的估算/实际行数比，比值超过一个数量级就把「统计过期/分布倾斜」列为头号嫌疑；看有没有 `temp read/written` 和巨大的 `Rows Removed by Filter`。
2. **修复**：一次只改一处。优先级：补统计（ANALYZE，成本最低）→ 加索引或改写 SQL 让条件/排序可被索引满足 → 调整语句结构（子查询转 JOIN、LIMIT 前置）→ 最后才考虑调参数。
3. **复验**：同一命令再跑一遍，对照 Buffers 和耗时；确认结果集不变（加索引不改结果，改写 SQL 必须做结果回归）；过一两天用 [pg_stat_statements](./pg-stat-statements) 看该语句的 mean_exec_time 是否真的下来了。

## 注意事项与常见坑

- 坏计划的根因多数在统计信息而不是参数，先怀疑 ANALYZE 缺位，再怀疑配置。
- 测试环境表只有几百行时，优化器会选 Seq Scan——小表顺序扫本来就更划算，别拿小表计划对照生产。
- 加了索引计划没变：检查是否函数包裹、隐式类型转换（`user_id = '42'` 在 text 列上）、或统计告诉它索引不划算。
- `SET enable_seqscan = off` 这类开关只用于验证「优化器为什么不用索引」，生产不要长期关闭任何 enable 开关。
- 计划抖动（时快时慢）常与 generic plan/custom plan 切换有关，见 [计划缓存与通用计划](../internals/plan-cache-and-generic-plan)。

## 参考资料

- [PostgreSQL 官方文档 · 14.1. Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)
- [PostgreSQL 官方文档 · Chapter 14. Performance Tips](https://www.postgresql.org/docs/current/performance-tips.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [EXPLAIN (ANALYZE, BUFFERS, WAL)](./explain-analyze-buffers)
- [统计信息与 ANALYZE](./statistics-and-analyze)
- [索引失效与误用](../indexing/index-failure-and-misuse)
- [复合索引设计](../indexing/composite-index-design)
- [pagination-and-sorting](/advanced-sql/pagination-and-sorting.md)
- [optimizer-cost-model](/internals/optimizer-cost-model.md)
- [explain-analyze-buffers](explain-analyze-buffers.md)
- [explain-basics](explain-basics.md)
- [index](index.md)
- [pg-stat-statements](pg-stat-statements.md)
- [slow-query-governance](slow-query-governance.md)
- [statistics-and-analyze](statistics-and-analyze.md)
官方文档：[性能提示](https://www.postgresql.org/docs/current/performance-tips.html)、[Using EXPLAIN 教程](https://www.postgresql.org/docs/current/using-explain.html)。
