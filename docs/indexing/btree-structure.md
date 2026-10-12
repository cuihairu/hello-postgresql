# B-tree 结构与原则

B-tree（多路平衡搜索树）是 PostgreSQL 的默认索引类型：`CREATE INDEX` 不写 `USING` 时建的就是它。它把索引键按序组织成一棵"矮胖"的树——从根页出发，每层一次页面读，最后落到按键排序、彼此用双向链表串联的叶子页。等值查找走一条路径，范围扫描沿叶子链顺序读，`ORDER BY` 甚至可以完全不排序。这三件事让 B-tree 成为绝大多数查询的首选。内部结构细节见官方文档 [B-tree 实现](https://www.postgresql.org/docs/current/btree-implementation.html)。

## 树的形状：内部分叉，叶子成链

一棵 B-tree 索引由三类页面组成，每页 8 KB：

- **根页**：树的入口，存若干"分隔键 + 子页指针"。
- **内部页**：继续按分隔键把搜索引向更深的页。
- **叶子页**：存真正的索引项 `(键值, TID)`，TID 指向堆表里的行。相邻叶子页之间用双向链表串起来。

范围扫描高效的原因就在叶子链上：定位到范围的起点后，后续行只需沿链表顺序读相邻叶子页，不需要回到根页重新搜索。等值查找则相反，从根到叶只走一条路径，读的页数等于树高。

用 pageinspect 扩展可以直接观察树高（`level` 是叶子之上一层数，`level=1` 表示"根→叶"两层）：

```sql
CREATE EXTENSION IF NOT EXISTS pageinspect;

CREATE TABLE orders (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    status     text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO orders (status, created_at)
SELECT (ARRAY['new','paid','shipped','done'])[1 + (g % 4)],
       now() - (g || ' minutes')::interval
FROM generate_series(1, 100000) g;

CREATE INDEX orders_created_at_idx ON orders (created_at);
ANALYZE orders;

SELECT level FROM bt_metap('orders_created_at_idx');   -- 10 万行：level = 1
```

## 等值、范围、前缀与排序

B-tree 能服务的查询形态比"等值查找"宽得多：

```sql
-- 等值：一次树搜索
EXPLAIN (COSTS OFF) SELECT * FROM orders WHERE id = 42;
-- Index Scan using orders_pkey on orders
--   Index Cond: (id = 42)

-- 范围：定位起点后沿叶子链顺序读
EXPLAIN (COSTS OFF) SELECT * FROM orders WHERE created_at > now() - interval '1 day';
-- Index Scan using orders_created_at_idx on orders
--   Index Cond: (created_at > (now() - '1 day'::interval))

-- 排序：直接按索引顺序输出，反向扫描即 DESC
EXPLAIN (COSTS OFF) SELECT * FROM orders ORDER BY created_at DESC LIMIT 10;
-- Limit
--   ->  Index Scan Backward using orders_created_at_idx on orders
```

前缀匹配 `LIKE 'ship%'` 也能走索引，但有一个前提：**列的排序规则必须是 C，或者索引建在 `text_pattern_ops` 上**。非 C 排序规则（如 `en_US.UTF-8`）下，默认的 `text_ops` 无法把 `LIKE 'ship%'` 转成范围条件，只能顺序扫描：

```sql
CREATE INDEX orders_status_pattern ON orders (status text_pattern_ops);
EXPLAIN (COSTS OFF) SELECT * FROM orders WHERE status LIKE 'ship%';
-- Bitmap Heap Scan on orders
--   ->  Bitmap Index Scan on orders_status_pattern
--         Index Cond: ((status ~>=~ 'ship'::text) AND (status ~<~ 'shiq'::text))
```

注意 `LIKE '%ship'`（前缀通配）永远用不上 B-tree，因为索引按前缀有序、后缀无序。

## 最左前缀原则

多列 B-tree 索引 `(a, b, c)` 的排序规则是：先按 `a` 排，`a` 相同再按 `b`，再按 `c`。因此：

- `WHERE a = ? AND b > ?` 可以用索引（`a` 等值定位，`b` 在范围内有序）。
- `WHERE b = ?` 用不上这个索引——`b` 在整个索引里不是全局有序的，只能全索引扫描。
- `WHERE a = ? AND c = ?` 只能用 `a` 的部分，`c` 的条件要回表过滤。

```sql
-- 索引 (tenant_id, created_at)：tenant_id 等值 + created_at 范围，两列都吃到
EXPLAIN (COSTS OFF) SELECT * FROM events
WHERE tenant_id = 3 AND created_at > now() - interval '1 hour';
-- Index Scan using events_tenant_created_idx on events
--   Index Cond: ((tenant_id = 3) AND (created_at > (now() - '01:00:00'::interval)))

-- 只查 created_at：用不上（除非 tenant_id 也是等值条件）
EXPLAIN (COSTS OFF) SELECT count(*) FROM events WHERE created_at > now() - interval '1 hour';
-- Seq Scan on events
```

组合索引的列顺序设计见 [组合索引设计](./composite-index-design)。

## 选择性与统计：优化器凭什么选它

优化器是否使用索引，取决于它对"索引能过滤掉多少行"的估计，而估计来自 `pg_stats` 里的统计信息：

```sql
SELECT attname, n_distinct FROM pg_stats
WHERE tablename = 'orders' AND attname IN ('id', 'status');
--  attname | n_distinct
-- ---------+------------
--  id      |         -1      -- -1 表示"几乎每行都不同"（高基数）
--  status  |          4      -- 只有 4 个不同值（低基数）
```

`n_distinct` 为负表示唯一值比例（-1 即全表唯一）。经验上：

- **高基数列**（id、email、created_at）：等值或范围查询能过滤掉大部分行，索引划算。
- **低基数列**（status、gender、布尔）：单独建索引通常不划算——命中几千行后回表的随机 I/O 比顺序扫描还慢，优化器会直接放弃索引。低基数列的正确用法是组合索引的前导列，或配合部分索引（见 [部分索引](./partial-indexes)）。

统计信息由 `ANALYZE` 维护，过期会导致优化器误判，见 [统计信息与 ANALYZE](../performance/statistics-and-analyze)。

## 层级数量级：百万行大约 3 层

B-tree 的容量来自"每页存几百个索引项"：叶子页每项约 16–24 字节（键 + TID），8 KB 页能放数百项。于是：

| 表规模 | 树高（level） | 一次等值查找的页面读 |
| --- | --- | --- |
| 10 万行 | 1（根→叶） | 2 次 |
| 100 万行 | 2（根→内部→叶） | 3 次 |
| 1 亿行 | 3 | 4 次 |

实测对照（100 万行表的 B-tree 索引）：

```sql
SELECT level FROM bt_metap('brin_events_ts_btree');   -- 100 万行：level = 2
```

也就是说，千万行级别的表做一次主键查找也只需要 3 次页面读，且根页和上层内部页几乎常驻 shared_buffers，实际磁盘 I/O 往往只有 1 次。这是 B-tree 能扛住大表的根本原因。

## 写入代价与随机键插入

索引不是免费的：每次 `INSERT`/`UPDATE` 都要同步维护所有索引，索引越多写入越慢。B-tree 的写入代价还取决于键的分布：

- **单调递增键**（`serial`/`identity`、时间戳）：新行总是追加到最右叶子页，页分裂少，写入快。
- **随机键**（UUID v4）：新行随机落在树的各个位置，页分裂发生在随机页上，页利用率下降，树也更容易长高。实测同样 20 万行，顺序键 `level = 1`，随机 UUID `level = 2`。

```sql
CREATE TABLE uuid_t (id uuid DEFAULT gen_random_uuid(), v text);
INSERT INTO uuid_t (v) SELECT 'x' || g FROM generate_series(1, 200000) g;
CREATE INDEX uuid_t_id_idx ON uuid_t (id);
SELECT level FROM bt_metap('uuid_t_id_idx');   -- 2：比同规模顺序键深一层
```

两个缓解手段：

1. **PG 13 起的 B-tree 去重（deduplication）**：相同键的多个 TID 合并存储，显著减少重复键索引的体积和分裂。
2. **换用 UUID v7 / 时间有序 UUID**：键值按时间单调，写入模式接近顺序键。

随机键还会带来另一个问题：索引项在磁盘上分散，范围扫描和索引扫描的随机 I/O 变多。如果业务上不需要全局随机，优先考虑时间有序的键。

## 相关页面

- [组合索引设计](./composite-index-design)
- [索引失效与误用](./index-failure-and-misuse)
- [EXPLAIN 读法](../performance/explain-basics)
- [统计信息与 ANALYZE](../performance/statistics-and-analyze)
