# join 实现

SQL 的 `JOIN` 只声明结果关系，不声明算法。PostgreSQL 有三种物理实现——Nested Loop、Hash Join、Merge Join，planner 按代价在三者之间挑选。它们的性能差距可达数量级，而选择完全依赖行数估算与索引情况，这也是优化器最容易翻车的地方。官方参考：[join 的规划](https://www.postgresql.org/docs/current/geqo-pg-intro.html)。

## Nested Loop：外层驱动内层

对每一行外表（outer）结果，去内表（inner）里找匹配：

```plaintext
for outer_row in outer:
    for inner_row in inner where inner.key = outer_row.key:   -- 有索引就是一次索引探测
        emit(outer_row, inner_row)
```

- 最适合：**外表行数少 + 内表连接列有索引**，总代价 ≈ 外表行数 × 一次索引探测。
- **唯一支持非等值条件的实现**：`a.x < b.y`、`BETWEEN` 型连接只有它能做。
- 外表行数一多，内表被反复探测，最坏退化成 O(N×M)；外表被估少时（rows 估错） Nested Loop 就是灾难的来源。
- 内表热点页都在 shared_buffers 时极快，小 OLTP 查询绝大多数是它。

## Hash Join：建哈希表，再探测

两个阶段：先扫小的一侧（build 侧）在内存里建哈希表，再扫另一侧（probe 侧）逐行探测：

```plaintext
build:  hash_table = { hash(inner.key) → rows }        -- 通常用小表
probe:  for outer_row in outer:
            emit(outer_row, hash_table.lookup(outer_row.key))
```

- **只支持等值连接**（哈希可比的表达式）。
- 哈希表大小受 `work_mem` 约束；放不下时退化为 hybrid hash join，按哈希值分批（batch）写临时文件、多趟处理。EXPLAIN 里的 `Batches: N`，N > 1 就是在落盘。
- 无索引也能跑，大表等值连接的默认选择；代价是必须吃完 build 侧才能出第一行，对 LIMIT 不友好。
- `work_mem` 是**每个 hash 节点、每个并行 worker** 的预算，高并发大 join 时内存会放大，见[体系结构与内存](/zh/internals/architecture-and-memory)。

## Merge Join：两边有序，流式归并

两侧先按连接键有序，然后像归并排序的合并一样同步推进：

- 有序可来自索引扫描（自带顺序）或显式 Sort 节点；**都已有序时几乎不占额外内存，流式处理**。
- 只支持等值（准确说：可按 btree 比较的连接条件，实践上就是等值）。
- **输出天然有序**：上层 `ORDER BY` 能直接复用，省掉一个 Sort。
- 大表对大表、连接列恰有合适索引时经常胜出；但只要一侧需要额外排序，就得和"Hash Join + 上层 Sort"的总价竞争。

## 选择依据：planner 在比较什么

对每个候选实现，planner 沿这条链算代价（模型本身见[优化器代价模型](/zh/internals/optimizer-cost-model)）：

1. 两侧行数估算（pg_statistic）；
2. 连接列上有没有可用索引、索引顺序是否正好匹配连接键；
3. 需不需要额外 Sort（要不要吃 work_mem、会不会落盘）；
4. 代价参数（尤其 `random_page_cost`）与 `work_mem`。

行数估算错误是 join 计划翻车第一因：外表估成 10 行实际 1000 万行，Nested Loop 就从最优解变成最差解。

## 用 EXPLAIN 三方对比

```sql
CREATE TABLE dim_user (id int PRIMARY KEY, name text);
INSERT INTO dim_user SELECT g, 'u' || g FROM generate_series(1, 1000) g;

CREATE TABLE fact_order (user_id int, amount numeric);
INSERT INTO fact_order SELECT g % 1000, g FROM generate_series(1, 1000000) g;
CREATE INDEX ON fact_order (user_id);
ANALYZE dim_user, fact_order;
```

外表只有 1 行时，Nested Loop 稳赢：

```sql
EXPLAIN SELECT u.name, o.amount
FROM   dim_user u JOIN fact_order o ON o.user_id = u.id
WHERE  u.id = 42;
-- Nested Loop
--   ->  Index Scan using dim_user_pkey on dim_user u
--         Index Cond: (id = 42)
--   ->  Index Scan using fact_order_user_id_idx on fact_order o
--         Index Cond: (user_id = 42)
```

全量 join 时默认选 Hash Join（小表 build，大表 probe）：

```sql
EXPLAIN SELECT count(*)
FROM   dim_user u JOIN fact_order o ON o.user_id = u.id;
-- Hash Join
--   Hash Cond: (o.user_id = u.id)
--   ->  Seq Scan on fact_order o
--   ->  Hash
--         ->  Seq Scan on dim_user u
```

把 work_mem 调小可以看到落盘信号：

```sql
SET work_mem = '64kB';
EXPLAIN SELECT count(*)
FROM   dim_user u JOIN fact_order o ON o.user_id = u.id;
-- Hash Join ... Buckets: 1024  Batches: 64  Memory Usage: 40kB
-- Batches > 1：哈希表分批落盘了
RESET work_mem;
```

关掉另外两种实现（仅演示用），观察 Merge Join：

```sql
SET enable_hashjoin = off;
SET enable_nestloop = off;
EXPLAIN SELECT u.id, o.amount
FROM   dim_user u JOIN fact_order o ON o.user_id = u.id
ORDER  BY u.id;
-- Merge Join
--   Merge Cond: (u.id = o.user_id)
--   ->  Index Scan using dim_user_pkey on dim_user u
--   ->  Index Scan using fact_order_user_id_idx on fact_order o
RESET enable_hashjoin;
RESET enable_nestloop;
```

三个计划对应同一结果，代价差异可达数量级——这就是 EXPLAIN 调优的主战场。

## 多表 join 的顺序与 GEQO

- 关系数不超过 `geqo_threshold`（默认 12）时，planner 用动态规划穷举 join 顺序，能找到较优解。
- 超过 12 个关系改用遗传算法（GEQO）近似搜索，避免组合爆炸；代价是计划质量不稳定——大 BI 查询"加个无关条件计划就变"多源于此。
- 关键查询想锁定驱动顺序，可以拆成 CTE（必要时 `MATERIALIZED` 建栅栏）、用 `LATERAL` 明确依赖（见 [LATERAL 与 FROM 子查询](/zh/advanced-sql/lateral-and-from-subquery)），或小场景直接 `SET geqo = off`。

## 注意事项与常见坑

- **enable_hashjoin / enable_nestloop / enable_mergejoin / enable_seqscan 都是调试开关**：置 off 只是把这些计划加巨额惩罚，不是禁用；线上调优先修统计、cost 参数与索引，不要靠会话级开关。
- Hash Join 的 build 侧是 planner 选的"较小一侧"，估算错了（小表实际是大表）会导致哈希表暴涨、大量落盘。
- Merge Join 依赖有序性：若一侧索引被排除（如连接列上套了表达式或类型不匹配），merging 变成先 Sort，代价立刻上去，见[索引失效与误用](/zh/indexing/index-failure-and-misuse)。
- 非等值 join 只能 Nested Loop，两侧都是千万行的非等值 join 基本跑不动，应在建模或查询改写层解决。
- 连接列类型不一致（int vs bigint、text vs varchar 两侧 collation 不同）会让索引和哈希都别扭，建模期就该对齐，见[主键设计](/zh/database-design/primary-key-design)。

## 参考资料

- [PostgreSQL 官方文档 · 19.7. Query Planning](https://www.postgresql.org/docs/current/runtime-config-query.html)
- [PostgreSQL 官方文档 · Chapter 51. Overview of PostgreSQL Internals](https://www.postgresql.org/docs/current/overview.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [优化器代价模型](/zh/internals/optimizer-cost-model)
- [查询执行管道](/zh/internals/query-execution-pipeline)
- [EXPLAIN 基础](/zh/performance/explain-basics)
- [组合索引设计](/zh/indexing/composite-index-design)
- [join-family](/zh/basics/join-family)
- [citus](/zh/ecosystem/citus)
- [index](/zh/internals/index)
- [optimizer-cost-model](/zh/internals/optimizer-cost-model)
- [parallel-query](/zh/internals/parallel-query)
- [query-execution-pipeline](/zh/internals/query-execution-pipeline)
- [explain-basics](/zh/performance/explain-basics)
官方文档参考：[Genetic Query Optimizer](https://www.postgresql.org/docs/current/runtime-config-query.html)
