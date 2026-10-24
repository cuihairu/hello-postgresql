# EXPLAIN 读法

EXPLAIN 是查询调优的入口工具：它让优化器对 SQL 做一次完整规划，并把得到的执行计划打印出来——打算怎么扫描表、用什么算法连接、按什么顺序组合各步骤，以及每一步预计产出多少行。默认的 `EXPLAIN` **只规划、不执行**，所以可以放心对任何语句使用；要看真实耗时与缓存命中，需要加 `ANALYZE` 选项，见 [EXPLAIN (ANALYZE, BUFFERS, WAL)](/zh/performance/explain-analyze-buffers)。

## 准备示例数据

本页及后续几页共用这对表：

```sql
CREATE TABLE users (
    user_id bigint PRIMARY KEY,
    name    text NOT NULL
);

CREATE TABLE orders (
    order_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    bigint NOT NULL REFERENCES users(user_id),
    amount     numeric(10,2) NOT NULL,
    status     text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO users SELECT g, 'user_' || g FROM generate_series(1, 100000) g;

INSERT INTO orders (user_id, amount, status, created_at)
SELECT 1 + (random() * 99999)::bigint,
       round((random() * 1000)::numeric, 2),
       (ARRAY['pending','paid','done','canceled'])[1 + floor(random() * 4)::int],
       now() - (random() * interval '90 days')
FROM generate_series(1, 1000000);

CREATE INDEX orders_user_id_idx ON orders (user_id);
ANALYZE users, orders;
```

## 三要素：cost、rows、width

计划里每个节点都带 `(cost=startup..total rows=N width=N)`：

```sql
EXPLAIN SELECT * FROM orders WHERE user_id = 42;
```

```plaintext
Index Scan using orders_user_id_idx on orders
    (cost=0.42..8.46 rows=10 width=46)
  Index Cond: (user_id = 42)
```

- **cost=startup..total**：两个抽象代价数字。startup 是产出第一行之前要付出的代价（Sort、Hash 建表这类「攒数据」的节点 startup 高，不读完输入出不了第一行）；total 是产出全部行的代价。单位是抽象值而非毫秒：一次顺序页读取记 1.0（`seq_page_cost`），一次随机页读取默认记 4.0（`random_page_cost`），处理一行记 0.01（`cpu_tuple_cost`）。只看相对大小，不要把 cost 直接当耗时。
- **rows**：优化器估计该节点输出的行数，来自统计信息。估算准不准直接决定计划好坏，估错的典型案例见 [常见坏计划](/zh/performance/common-bad-plans)。
- **width**：该节点输出的行平均字节数，由列类型和统计信息推算。判断「这个查询要搬多少数据」时有用。

顶层节点的 total 就是整条查询的代价；父节点的 cost 由子节点累加而来，所以 **只有顶层 cost 可以用来跨查询比较**，中间节点的 cost 只在计划内部有意义。

## 计划树：从内到外读

计划是一棵树：**缩进越深越先执行，最内层节点是数据来源（扫描）**，输出逐层向上被父节点加工，最顶层把结果交给客户端。下面这条查询「查用户 42 的订单数」，从内到外是：索引扫描 → 嵌套循环连接 → 聚合：

```sql
EXPLAIN
SELECT u.name, count(*)
FROM users u JOIN orders o ON o.user_id = u.user_id
WHERE u.user_id = 42
GROUP BY u.name;
```

```plaintext
Aggregate  (cost=8.58..8.59 rows=1 width=40)
  ->  Nested Loop  (cost=0.42..8.56 rows=10 width=16)
        ->  Index Scan using users_pkey on users u
              (cost=0.42..8.44 rows=1 width=16)
              Index Cond: (user_id = 42)
        ->  Index Scan using orders_user_id_idx on orders o
              (cost=0.00..8.12 rows=10 width=0)
              Index Cond: (user_id = 42)
```

阅读要点：

- 时间上先执行最深的节点；最顶层节点执行完，结果才返回。
- 父节点的 rows 是「子节点 rows × 选择率」推算出来的，因此**子节点估错会污染整条路径**，排查估算问题要自下而上。
- 每个节点下的 `Index Cond` / `Filter` 行说明该节点的过滤条件：`Index Cond` 是索引能利用的条件，`Filter` 是取回行之后逐行再过滤的条件（出现大量 `Rows Removed by Filter` 通常意味着该索引选得不合适）。

## 常见扫描节点

| 节点 | 行为 | 典型场景 |
| --- | --- | --- |
| Seq Scan | 从头到尾读全表 | 无可用索引；或要取的行占比很高（如超过百分之几到十几） |
| Index Scan | 走 B-tree 索引，按需回表取整行 | 条件选择性高，返回少量行 |
| Index Only Scan | 只读索引本身，不回表 | 查询的列全部包含在索引里，且表的可见性图较干净 |
| Bitmap Heap Scan + Bitmap Index Scan | 先在索引里把匹配的块位图算出来，再按块顺序回表 | 返回行数中等（几十到几万），单个索引或多个索引的 OR/AND 组合 |

对应示例：

```sql
EXPLAIN SELECT * FROM orders WHERE user_id = 42;          -- Index Scan
EXPLAIN SELECT count(*) FROM orders WHERE user_id = 42;   -- Index Only Scan
EXPLAIN SELECT * FROM orders WHERE user_id BETWEEN 100 AND 200;
```

```plaintext
Bitmap Heap Scan on orders  (cost=25.31..1531.05 rows=1010 width=46)
  Recheck Cond: ((user_id >= 100) AND (user_id <= 200))
  Heap Blocks: exact=690
  ->  Bitmap Index Scan on orders_user_id_idx
        (cost=0.00..25.06 rows=1010 width=0)
        Index Cond: ((user_id >= 100) AND (user_id <= 200))
```

Bitmap 方案先收集位图再成批回表，避免了 Index Scan 逐行随机跳转；`Heap Blocks: exact=...` 表示位图精确命中的块数（出现 `lossy=` 说明内存位图放不下、退化成按块匹配，需要 `Recheck` 逐行复核）。Index Only Scan 依赖可见性图判断行版本是否对所有人可见，刚被大量更新过的表上可能退化成普通 Index Scan，原理见 [VACUUM 与 HOT](/zh/internals/vacuum-and-hot)。

## 连接节点与 JOIN 实现

计划里的连接节点对应三种物理实现：

| 节点 | 算法 | 优化器什么时候选它 |
| --- | --- | --- |
| Nested Loop | 外层每一行驱动一次内层查找 | 外层行数少，或内层连接列上有索引 |
| Hash Join | 内表建哈希表，外表逐行探测 | 两边行数都不小，等值连接 |
| Merge Join | 两边按连接键排序后归并 | 两边已有序（有索引），且要取的行多 |

上文的 `Nested Loop` 例子里，外层是 1 行的用户，内层走索引找订单，总代价很小；如果把条件放宽到「所有用户」，计划会变成 Hash Join——先全量扫描建哈希表再探测。三种实现的代价模型与细节见 [JOIN 实现方式](/zh/internals/join-implementations)。

## 估算与实际：建立对照意识

`EXPLAIN` 输出的 rows 全是估算，可能与真实差几个数量级。读计划时要带着「估算 vs 实际」的对照意识：看到可疑的估错比（比如估 1 行），立刻想到统计信息可能过期或分布倾斜。加 `ANALYZE` 选项即可拿到实际行数和耗时：

```sql
EXPLAIN (ANALYZE) SELECT * FROM orders WHERE user_id = 42;
```

```plaintext
Index Scan using orders_user_id_idx on orders
    (cost=0.42..8.46 rows=10 width=46)
    (actual time=0.021..0.048 rows=8 loops=1)
  Index Cond: (user_id = 42)
Planning Time: 0.182 ms
Execution Time: 0.089 ms
```

注意 `EXPLAIN (ANALYZE)` 会**真实执行语句**，对写语句要先包事务回滚，详见下一页。PG 16 起还支持 `EXPLAIN (GENERIC_PLAN)`，只看参数化查询的通用计划、不填参数也不执行。

## 注意事项与常见坑

- 默认 `EXPLAIN` 不执行语句：SELECT 不会跑、DML 也不会改数据；但 `EXPLAIN (ANALYZE)` 会真执行，两者别混淆。
- cost 是模型定价不是毫秒数。改了 `random_page_cost`、`seq_page_cost` 等参数，同一个计划里的 cost 数字会整体变化，但实际速度未必变。
- rows=1 是危险信号：通常意味着统计缺失/过期，或优化器对相关列做了独立性假设，后续所有节点的估算都会跟着失真。
- 计划树缩进对齐容易看串行，复杂计划可以加 `FORMAT JSON`（GJSON 树形结构）或用 explain 可视化工具排版后再读。
- `EXPLAIN` 显示的是规划时刻的决策，实际执行中缓冲区冷热、并发负载都会影响耗时，cost 高的计划在缓存全热时未必比 cost 低的慢。

## 参考资料

- [PostgreSQL 官方文档 · 14.1. Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)
- [PostgreSQL 官方文档 · Chapter 14. Performance Tips](https://www.postgresql.org/docs/current/performance-tips.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [EXPLAIN (ANALYZE, BUFFERS, WAL)](/zh/performance/explain-analyze-buffers)
- [常见坏计划](/zh/performance/common-bad-plans)
- [统计信息与 ANALYZE](/zh/performance/statistics-and-analyze)
- [优化器代价模型](/zh/internals/optimizer-cost-model)
- [索引选型决策树](/zh/indexing/index-selection-decision-tree)
- [cte-and-non-recursive-with](/zh/advanced-sql/cte-and-non-recursive-with)
- [lateral-and-from-subquery](/zh/advanced-sql/lateral-and-from-subquery)
- [set-operations](/zh/advanced-sql/set-operations)
- [subquery-family](/zh/advanced-sql/subquery-family)
- [common-beginner-mistakes](/zh/basics/common-beginner-mistakes)
- [join-family](/zh/basics/join-family)
- [psql-getting-started](/zh/basics/psql-getting-started)
- [pgvector](/zh/ecosystem/pgvector)
- [postgresql-17-features](/zh/ecosystem/postgresql-17-features)
- [when-to-choose-postgresql](/zh/ecosystem/when-to-choose-postgresql)
- [btree-structure](/zh/indexing/btree-structure)
- [composite-index-design](/zh/indexing/composite-index-design)
- [index-failure-and-misuse](/zh/indexing/index-failure-and-misuse)
- [join-implementations](/zh/internals/join-implementations)
- [optimizer-cost-model](/zh/internals/optimizer-cost-model)
- [parallel-query](/zh/internals/parallel-query)
- [query-execution-pipeline](/zh/internals/query-execution-pipeline)
- [knowledge](/zh/knowledge)
- [common-bad-plans](/zh/performance/common-bad-plans)
- [explain-analyze-buffers](/zh/performance/explain-analyze-buffers)
- [index](/zh/performance/index)
- [partition-pruning](/zh/performance/partition-pruning)
- [statistics-and-analyze](/zh/performance/statistics-and-analyze)
- [psql-advanced](/zh/tools/psql-advanced)
官方文档：[EXPLAIN 命令](https://www.postgresql.org/docs/current/sql-explain.html)、[Using EXPLAIN 文档](https://www.postgresql.org/docs/current/using-explain.html)。
