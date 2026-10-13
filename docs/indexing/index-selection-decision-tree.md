# 索引选型决策树

PostgreSQL 的索引类型（访问方法，AM）各自能回答的查询形态不同：B-tree 擅长把条件换算成有序范围，GIN 擅长回答「包含」，GiST 擅长「重叠与邻近」，BRIN 用极小的块摘要换时序表的扫描成本，SP-GiST 按空间划分处理前缀与点数据。选型第一步不是挑「性能更好的那个」，而是问：**我的查询条件是哪种形态？** 只有 B-tree 表达不了的条件（包含、重叠、近邻、全文），才需要换 AM。

## 决策树

```plaintext
查询里最主要的 WHERE / ORDER BY 条件是什么形态？
│
├─ 等值 =、范围 < > BETWEEN、排序 ORDER BY ... LIMIT、唯一约束
│    └─ B-tree（默认选择，覆盖绝大多数业务查询）
│         └─ 条件带函数/表达式 → B-tree 表达式索引
│         └─ 只查一小部分行 → 加 WHERE 谓词做部分索引
│
├─ 包含/成员判断：jsonb @> ?、数组 @> && <@、全文 @@、模糊匹配 LIKE '%kw%'
│    └─ GIN
│
├─ 范围类型重叠 &&、几何相交/包含、KNN 近邻排序 ORDER BY col <-> point
│    └─ GiST（也是排除约束 EXCLUDE 的唯一选择）
│
├─ 超大表（远超内存）、追加型写入、按自然顺序（如时间）范围扫描
│    └─ BRIN（前提：物理顺序与列值顺序高度一致）
│
├─ 前缀结构数据（URL、IP、电话号码）、二维点、非平衡分层数据
│    └─ SP-GiST
│
└─ 只有纯等值 =，且键特别长/取值极分散，B-tree 键超限
     └─ Hash（仅 = ；更常用替代：对值取 md5 后建 B-tree 表达式索引）
```

树里 B-tree 分支排第一不是因为它最常用，而是因为其他分支的查询形态 B-tree 根本不支持——`jsonb @>`、`range &&`、`tsvector @@` 这些算子没有对应的 B-tree 算子类，建了 B-tree 也用不上。

## 各类型边界速查表

| 索引类型 | 能答的查询形态 | 典型列类型 | 边界与代价 |
| --- | --- | --- | --- |
| B-tree | =、<、<=、>、>=、BETWEEN、IN、前缀 LIKE、ORDER BY | 数值、文本、时间、枚举 | 键宽上限约 2704 字节；`%kw%` 双端通配无效 |
| GIN | @>、?、&&、@@（jsonb/数组/全文/trigram） | jsonb、数组、tsvector、trgm | 不支持唯一约束；不支持 IOS；写放大与 pending list 见 GIN 页 |
| GiST | && 重叠、@>、<-> KNN、几何算子 | range、几何、PostGIS | 有损结构，常伴随 Recheck；不支持唯一约束 |
| BRIN | 按块区间的 min/max 过滤 | 时序时间戳、自增序列 | 只在物理相关时有效；高更新表会失效；精度到块区间，需 Recheck |
| SP-GiST | 前缀匹配、点/区域划分 | text 前缀、inet、point、uuid | 能力完全由算子类决定，通用性弱于 B-tree |
| Hash | 仅 = | 任意可哈希类型 | 无范围/排序/唯一；不参与 ORDER BY 优化 |

版本注：BRIN 的 bloom、minmax-multi 算子类是 PG 14 加入的；Hash 索引自 PG 10 起才写入 WAL（可参与复制、崩溃安全）；`REINDEX CONCURRENTLY` 需 PG 12+。

## 两个典型路由示例

**时序监控表选 BRIN**：数据按时间追加，物理顺序与 `ts` 顺序一致，200 GB 的表建 B-tree 时间索引要几十 GB，BRIN 只要几 MB：

```sql
CREATE TABLE metrics_b (
    ts    timestamptz NOT NULL,
    host  text NOT NULL,
    value double precision NOT NULL
);

CREATE INDEX idx_metrics_b_ts ON metrics_b USING brin (ts)
    WITH (pages_per_range = 64);

EXPLAIN
SELECT count(*) FROM metrics_b
WHERE ts >= '2026-10-01' AND ts < '2026-10-02';
-- Bitmap Heap Scan ... Bitmap Index Scan on idx_metrics_b_ts
```

代价要认清：BRIN 只记「每个块区间的最大最小值」，区间内不满足条件的行靠 Recheck 剔除；如果表经过大量乱序更新，物理顺序与时间错开，BRIN 会退化到扫掉大半张表——**物理相关性是 BRIN 的生死线**，详见 [BRIN 索引](./brin)。

**标签过滤表选 GIN**：按数组包含关系查文章，B-tree 无能为力：

```sql
CREATE TABLE articles_g (
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tags  text[] NOT NULL
);
INSERT INTO articles_g (tags)
SELECT ARRAY['db', 'pg', 'tag' || (g % 50)::text]
FROM generate_series(1, 100000) g;

CREATE INDEX idx_articles_g_tags ON articles_g USING gin (tags);

EXPLAIN ANALYZE
SELECT id FROM articles_g WHERE tags @> ARRAY['pg'];
-- Bitmap Index Scan on idx_articles_g_tags
```

如果这条查询改成 `tags = ARRAY['pg']`（完全相等），反而应该用 B-tree——查询形态决定 AM，不是列类型决定。

## 选完之后：用 BUFFERS 验证

选型是否成立，只有实测能回答。标准动作是**同一查询在加索引前后各跑一次 `EXPLAIN (ANALYZE, BUFFERS)`**，对比三项：执行时间、读取的缓冲页数（`shared read` 是真 I/O，`shared hit` 是缓存命中）、计划节点是否符合预期（详见 [EXPLAIN ANALYZE 与 BUFFERS](../performance/explain-analyze-buffers)）：

```sql
-- 加索引前
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM articles_g WHERE tags @> ARRAY['pg'];
-- Seq Scan ... rows=2000 ... Buffers: shared hit=835
--   Execution Time: 25 ms

CREATE INDEX idx_articles_g_tags ON articles_g USING gin (tags);

-- 加索引后
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM articles_g WHERE tags @> ARRAY['pg'];
-- Bitmap Index Scan ... rows=2000 ... Buffers: shared hit=18
--   Execution Time: 1.5 ms
```

缓冲页从 835 降到 18，说明选型兑现了「少读页」的预期；如果时间没降、或计划里出现大得离谱的 `Rows Removed by Recheck`，回到决策树重新审视查询形态。验证时注意三点：

- 冷缓存状态更接近生产，`DISCARD ALL` 不够（不清 OS 缓存），多次执行看稳定性而不是单次最快值。
- 新索引建完先 `ANALYZE` 表，否则优化器对 GIN/GiST 的选择性和 Recheck 比例没有依据。
- 写入侧的代价也要测：GIN 的 fastupdate、Hash 的维护成本都会转嫁到 INSERT/UPDATE 延迟上，读快写慢的选型对高频写入表可能是负优化。

## 注意事项与常见坑

- **一个索引只能选一种 AM**，但表达式、部分谓词、INCLUDE 这些修饰与 AM 正交：`CREATE INDEX ... USING gin (totsvector) WHERE is_published` 是合法组合。
- **一张表不需要为每种查询形态各建一个重型索引**。先看查询频率：偶尔跑一次的分析查询用顺序扫描 + 并行就够了（见 [并行查询](../internals/parallel-query)），不值得养索引。
- GIN 与 GiST 都能索引 range 类型：检索性能 GIN 更快，更新更快的是 GiST，按读写比选。
- 决策树给出的是「从哪类开始试」，最终以 EXPLAIN BUFFERS 的前后对照为准；组合索引的列序问题在 AM 选定之后还有一层，见[组合索引设计](./composite-index-design)。

## 参考资料

- [PostgreSQL 官方文档 · Chapter 11. Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL 官方文档 · 11.2. Index Types](https://www.postgresql.org/docs/current/indexes-types.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [full-text-search](/advanced-sql/full-text-search.md)
- [pgvector](/ecosystem/pgvector.md)
- [brin](brin.md)
- [gin](gin.md)
- [gist](gist.md)
- [index](index.md)
- [spgist-and-hash](spgist-and-hash.md)
- [knowledge](/knowledge.md)- [B-tree 结构与原则](./btree-structure)、[GIN 索引](./gin)、[GiST 索引](./gist)、[BRIN 索引](./brin)、[SP-GiST 与 Hash](./spgist-and-hash) —— 各 AM 的结构与算子类细节。
- [EXPLAIN ANALYZE 与 BUFFERS](../performance/explain-analyze-buffers) —— 本页验证手法的完整教程。
- [全文检索](../advanced-sql/full-text-search) —— GIN 分支最常见的业务场景。

官方文档：[索引类型](https://www.postgresql.org/docs/current/indexes-types.html)、[索引与算子类](https://www.postgresql.org/docs/current/indexes-opclass.html)。
