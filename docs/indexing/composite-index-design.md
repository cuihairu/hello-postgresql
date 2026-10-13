# 组合索引设计

组合索引（多列索引）把多列的值按"先第一列、再第二列"的字典序组织进一棵 B-tree。它的价值在于：一个索引同时服务等值过滤、范围过滤和 `ORDER BY`，往往能顶替两三个单列索引。设计组合索引的核心问题只有一个——**列的顺序**。多列索引的行为细节见官方文档 [多列索引](https://www.postgresql.org/docs/current/indexes-multicolumn.html)。

## 列顺序：等值条件在前，范围/排序在后

原则：**等值条件的列放前面，范围条件或排序依据的列放后面**。原因是最左前缀——只有前导列是等值时，后面的列才能在索引内做范围定位；一旦某列是范围条件，它之后的列在索引内就不再有序，只能回表过滤。

以最常见的 `WHERE tenant_id = ? AND created_at > ?` 为例：

```sql
CREATE TABLE events (
    tenant_id  int NOT NULL,
    status     text,
    created_at timestamptz NOT NULL
);
CREATE INDEX ev_tenant_created ON events (tenant_id, created_at);

-- 两列都吃到索引：tenant_id 等值定位，created_at 范围扫描
EXPLAIN (COSTS OFF) SELECT * FROM events
WHERE tenant_id = 3 AND created_at > now() - interval '1 hour';
-- Index Scan using ev_tenant_created on events
--   Index Cond: ((tenant_id = 3) AND (created_at > (now() - '01:00:00'::interval)))
```

反例：如果把范围列放前面，建 `(created_at, tenant_id)`，同样的查询只能用 `created_at` 一个条件（而它命中大量行），`tenant_id` 的过滤退化为回表。

## 覆盖 ORDER BY：消除 Sort 节点

索引本身有序，所以"等值条件 + 按后位列排序"的查询可以直接按索引顺序读，省掉显式排序：

```sql
EXPLAIN (COSTS OFF) SELECT * FROM events
WHERE tenant_id = 3 ORDER BY created_at DESC LIMIT 20;
-- Limit
--   ->  Index Scan Backward using ev_tenant_created on events
--         Index Cond: (tenant_id = 3)
```

这个形态对分页查询尤其重要：`LIMIT 20` 只需要读 20 个索引项就停，而先扫描再 `Sort` 的计划必须处理所有匹配行。分页写法详见 [分页与排序](../advanced-sql/pagination-and-sorting)。

两个补充：

- 排序方向混合（如 `ORDER BY created_at ASC, status DESC`）需要索引列也按同样方向声明（`CREATE INDEX ... (created_at ASC, status DESC)`）。
- 排序键与索引顺序不完全一致时，PG 13 起会走 **Incremental Sort**（利用索引已有序的前缀，只对剩余部分排序），代价远低于全量 Sort：

```sql
EXPLAIN (COSTS OFF) SELECT * FROM events
WHERE tenant_id = 3 ORDER BY created_at, status LIMIT 20;
-- Limit
--   ->  Incremental Sort
--         Sort Key: created_at, status
--         Presorted Key: created_at          -- 索引已保证 created_at 有序
--         ->  Index Scan using ev_tenant_created on events
```

## INCLUDE 列：只进索引、不参与键序（PG 11+）

`INCLUDE` 把额外列塞进索引的叶子页，但**不参与键的排序和约束**。用途是做覆盖索引：查询需要的列全在索引里，就不用回表（Index Only Scan）：

```sql
CREATE INDEX ev_tenant_inc_status ON events (tenant_id) INCLUDE (status);
VACUUM (ANALYZE) events;    -- Index Only Scan 需要可见性图已更新

EXPLAIN (COSTS OFF) SELECT tenant_id, status FROM events WHERE tenant_id = 3;
-- Index Only Scan using ev_tenant_inc_status on events
--   Index Cond: (tenant_id = 3)
```

`\d` 可以看到 INCLUDE 列不作为键：

```plaintext
 Index "public.ev_tenant_inc_status"
  Column   |  Type   | Key? | Definition
-----------+---------+------+------------
 tenant_id | integer | yes  | tenant_id
 status    | text    | no   | status
btree, for table "public.events"
```

INCLUDE 列与键列的区别：键列参与排序和最左前缀匹配，INCLUDE 列不参与。两者都能被 Index Only Scan 读取。`UNIQUE (a) INCLUDE (b)` 表示"只要求 a 唯一，但把 b 也带上供覆盖查询用"——这是普通 `UNIQUE (a, b)` 做不到的。代价是索引变大、写入变慢，所以只把"高频查询需要、又不想进键"的列放进 INCLUDE。

## 索引跳扫：PostgreSQL 没有

`(tenant_id, created_at)` 不能服务"只按 created_at 过滤"的查询，而且 PostgreSQL（截至 17）**没有实现索引跳扫（skip scan）**：不会自动枚举 tenant_id 的值来分段使用索引。

可行的替代思路：

1. **把 tenant_id 的取值列表写进查询**。`IN` 列表会被展开成对索引的多段扫描：

```sql
EXPLAIN (COSTS OFF) SELECT count(*) FROM events
WHERE tenant_id IN (1, 2, 3) AND created_at > now() - interval '1 hour';
-- Bitmap Heap Scan on events
--   ->  Bitmap Index Scan on ev_tenant_created
--         Index Cond: ((tenant_id = ANY ('{1,2,3}'::integer[]))
--                      AND (created_at > (now() - '01:00:00'::interval)))
```

2. **为取值很少且固定的前导列建部分索引**，如 `CREATE INDEX ... WHERE tenant_id = 1`，见 [部分索引](./partial-indexes)。
3. **按前导列分区**，让每个分区自己的索引只包含后位列，见 [分区表设计](../database-design/table-inheritance-and-partitioning-design)。

## 冗余索引识别：左前缀重复

如果表上同时存在 `(tenant_id)` 和 `(tenant_id, created_at)`，前者就是冗余的——任何能用前者的查询都能用后者，但它白占空间、拖慢写入。识别方法：找"某索引的键列恰好是另一索引键列的左前缀"的组合：

```sql
SELECT pa.indexrelid::regclass AS redundant_index,
       pb.indexrelid::regclass AS keeping_index
FROM pg_index pa
JOIN pg_index pb
  ON  pb.indrelid = pa.indrelid
  AND pb.indexrelid <> pa.indexrelid
  AND (pb.indkey::int2[])[0:pa.indnkeyatts-1] = (pa.indkey::int2[])[0:pa.indnkeyatts-1]
  AND pb.indnkeyatts > pa.indnkeyatts
  AND (NOT pa.indisunique OR pb.indisunique)
WHERE pa.indisprimary = false;
-- redundant_index | keeping_index
-- -----------------+------------------
-- ev_tenant_only   | ev_tenant_created
```

删除前先确认没有查询依赖它的特殊属性（比如唯一性、或更小的体积带来的维护收益）。索引体积与维护成本的量化见 [索引膨胀与维护](./index-bloat-and-maintenance)。

## 组合索引与多个单列索引的选择

| 场景 | 建议 |
| --- | --- |
| 查询总是 `WHERE a = ? AND b > ?` 或带 `ORDER BY` | 一个组合索引 `(a, b)` |
| 查询分别只按 a 或只按 b 过滤，且各有高频流量 | 两个单列索引 |
| 查询按 a 或 b 过滤但组合条件命中率都很高 | 组合索引 + 视需要补一个单列索引 |
| 多个单列索引同时可用 | 优化器可用 BitmapAnd 合并位图，但比单一组合索引多两次索引扫描和位图合并开销 |

经验法则：**一个组合索引覆盖一种高频查询形态**。与其为每种条件组合都建索引，不如让最高频的形态走最优索引，低频形态退化为较宽的索引扫描或顺序扫描——索引数量对写入吞吐的影响是线性的，见 [写吞吐优化](../performance/write-throughput-optimization)。

## 参考资料

- [PostgreSQL 官方文档 · Chapter 11. Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL 官方文档 · 11.2. Index Types](https://www.postgresql.org/docs/current/indexes-types.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [B-tree 结构与原则](./btree-structure)
- [部分索引](./partial-indexes)
- [索引失效与误用](./index-failure-and-misuse)
- [EXPLAIN 读法](../performance/explain-basics)
- [lateral-and-from-subquery](/advanced-sql/lateral-and-from-subquery.md)
- [pagination-and-sorting](/advanced-sql/pagination-and-sorting.md)
- [anti-patterns](/database-design/anti-patterns.md)
- [logical-to-physical-modeling](/database-design/logical-to-physical-modeling.md)
- [btree-structure](btree-structure.md)
- [index-only-scans](index-only-scans.md)
- [index-selection-decision-tree](index-selection-decision-tree.md)
- [index](index.md)
- [join-implementations](/internals/join-implementations.md)
- [vacuum-and-hot](/internals/vacuum-and-hot.md)
- [common-bad-plans](/performance/common-bad-plans.md)
- [slow-query-governance](/performance/slow-query-governance.md)
- [real-world-cases](/tools/real-world-cases.md)