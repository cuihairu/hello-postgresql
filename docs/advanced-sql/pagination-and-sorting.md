# 分页与排序

`LIMIT/OFFSET` 是最直观的分页写法，但它的读取成本随页深线性增长——翻到第 1000 页时数据库仍要从头扫过前 999 页的数据。替代方案是 keyset（游标）分页：用「上一页最后一行的键值」作为下一条查询的过滤条件，每页成本恒定。这里整理两种方式的实现、keyset 分页需要的复合索引、无唯一键排序导致翻页丢行/重复的机理，以及页码总数 `count(*)` 的代价。

## 示例表

```sql
CREATE TABLE events (
    id         bigserial PRIMARY KEY,
    user_id    bigint NOT NULL,
    created_at timestamptz NOT NULL,
    amount     numeric(10,2)
);

-- 生成 10 万行测试数据
INSERT INTO events (user_id, created_at, amount)
SELECT (random() * 999)::bigint + 1,
       now() - (random() * interval '365 days'),
       round((random() * 1000)::numeric, 2)
FROM generate_series(1, 100000);

-- keyset 分页必需的复合索引
CREATE INDEX idx_events_user_created ON events (user_id, created_at DESC, id DESC);
```

## OFFSET 的成本随页深线性增长

先看两种写法：

```sql
-- 第一页：很快
SELECT id, created_at, amount
FROM events
ORDER BY created_at DESC, id DESC
LIMIT 20 OFFSET 0;

-- 第 5000 页：读满前 99980 行才能拿到 20 行
SELECT id, created_at, amount
FROM events
ORDER BY created_at DESC, id DESC
LIMIT 20 OFFSET 99980;
```

用 `EXPLAIN (ANALYZE, BUFFERS)` 对比能直接看到差距：

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM events ORDER BY created_at DESC, id DESC LIMIT 20 OFFSET 99980;
```

执行计划里 Offset 节点下方的子计划仍要产出 100000 行（前 99980 行被丢弃），深分页的时间几乎全部花在「生成再丢弃」上。若排序没有索引支撑，还会多一个物化全量结果的 Sort 节点。OFFSET 分页的适用边界：页数浅（前几十页）、数据量小、或产品明确要求「跳转到任意页码」。

## keyset 分页与行值比较

核心思想：不用「跳过 N 行」定位，而是记住上一页最后一行的排序键，下一页从「严格大于它的位置」继续。PostgreSQL 支持行值比较（row value comparison），写法紧凑：

```sql
-- 第一页
SELECT id, user_id, created_at, amount
FROM events
WHERE user_id = 42
ORDER BY user_id, created_at DESC, id DESC
LIMIT 20;

-- 下一页：带上第一页最后一行的 (created_at, id)
SELECT id, user_id, created_at, amount
FROM events
WHERE user_id = 42
  AND (created_at, id) < ('2026-01-05 10:00+08', 12345)
ORDER BY user_id, created_at DESC, id DESC
LIMIT 20;
```

`(created_at, id) < (v1, v2)` 是字典序比较，展开后等价于 `(created_at < v1) OR (created_at = v1 AND id < v2)`，数据库按行值整体处理，规划器能直接利用 `(user_id, created_at DESC, id DESC)` 索引定位到起点。**排序键必须把唯一列（主键 id）放在末位兜底**，否则排序键相同的多行谁先谁后不确定（下一节详述）。keyset 分页每页都是一次索引范围扫描，成本与页深无关，代价是不支持随机跳页，只能「上一页/下一页」。

## 不稳定排序：翻页丢行与重复

排序键不唯一时，两页之间若数据发生变化（或有并发写入），同一条记录可能出现在两页，也可能两页都漏掉。机理很直接：

```sql
-- created_at 大量重复，两次执行同一查询返回顺序可能不同
SELECT id, created_at FROM events ORDER BY created_at LIMIT 20 OFFSET 0;
SELECT id, created_at FROM events ORDER BY created_at LIMIT 20 OFFSET 20;
```

没有唯一键兜底时，`created_at` 相同的行之间的相对顺序没有任何保证；两次查询（甚至同一次事务内的两次执行）可能给出不同顺序，边界行就会丢或重。防御手段只有一个：**ORDER BY 末尾永远追加唯一列**（主键或 `id DESC`）。这同时是 keyset 分页正确性的前提。

另一类「不稳定」来自排序键本身被更新：用户按 `updated_at` 排序翻页，期间某行被更新，它的位置就变了。对不允许漂移的场景（如导出全量数据），在事务里用 `REPEATABLE READ` 隔离或改用快照导出，见 [事务与隔离级别](../internals/transactions-and-isolation)。

## TABLESAMPLE 随机抽样

不需要「真随机分页」、只想要一个随机样本时，PG 9.5 起的 `TABLESAMPLE` 比 `ORDER BY random()` 快几个数量级：

```sql
SELECT id, amount FROM events TABLESAMPLE SYSTEM (0.1);   -- 约 0.1% 的块
```

`SYSTEM` 按数据块随机取样，速度快但样本在块内是连续的；`BERNOULLI` 逐行抽样更均匀也更慢。两者都只保证「大约」的百分比。它不是分页的替代品，只是避免把 `ORDER BY random()` 用在大表上。

## count(*) 与页码的代价

页码导航需要总行数，而 `SELECT count(*) FROM events WHERE user_id = 42` 本身就是一次全索引扫描，大表上动辄数百毫秒。常见的替代策略：

- **不要精确总数**：只显示「下一页」按钮，或前端做「加载更多」，keyset 分页天然不需要总数。
- **估算值**：`EXPLAIN` 的行数估计或 `pg_class.reltuples`（对全表计数），误差在报表场景通常可接受。
- **缓存计数**：对「总数变化不敏感」的列表用 Redis 缓存或物化汇总表定时刷新。
- **条件收敛**：给 count 查询加与列表相同的过滤条件，避免 `count(*) FROM events` 这种无过滤全表计数。

精确到个位数的分页总数在千万级表上是持续的纯开销，产品层面先确认是否真的需要。

## 注意事项与常见坑

- `LIMIT 20 OFFSET 99980` 不只是慢：深 OFFSET 期间数据变化还会导致跳页错乱，与不稳定排序问题叠加。
- 行值比较 `(a, b) < (v1, v2)` 的两侧括号形式必须一致，一侧是行值一侧是散列条件会得到不同的语义。
- keyset 分页的游标值要编码后传给前端（如 base64 的 `created_at|id`），不要让客户端拼接原始 SQL 片段。
- `ORDER BY` 里对可空列排序注意 `NULLS FIRST/LAST` 的默认行为，见 [条件表达式](./conditional-expressions)。
- 复合索引的列顺序必须与 `ORDER BY` 的方向一致（含 DESC），混合方向排序需要对应方向的索引，见 [复合索引设计](../indexing/composite-index-design)。

## 参考资料

- [PostgreSQL 官方文档 · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL 官方文档 · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [条件表达式](./conditional-expressions)
- [复合索引设计](../indexing/composite-index-design)
- [慢查询治理](../performance/slow-query-governance)
- [常用执行计划劣化形态](../performance/common-bad-plans)
- [conditional-expressions](conditional-expressions.md)
- [index](index.md)
- [window-functions-advanced](window-functions-advanced.md)
- [primary-key-design](/database-design/primary-key-design.md)
- [composite-index-design](/indexing/composite-index-design.md)
- [knowledge](/knowledge.md)
- [connection-and-orm-optimization](/performance/connection-and-orm-optimization.md)
官方文档：[LIMIT 与 OFFSET](https://www.postgresql.org/docs/current/queries-limit.html)、[行值比较](https://www.postgresql.org/docs/current/functions-comparisons.html#ROWWISE-COMPARISON)、[TABLESAMPLE](https://www.postgresql.org/docs/current/sql-select.html#SQL-TABLESAMPLE)。
