# SP-GiST 与 Hash

这里合并记录两个"小众但各有明确定位"的索引类型。SP-GiST 与 GiST 同属广义索引框架，但面向**天然不平衡**的数据分布（空间点、字符串前缀、IP 网段），用空间分区树把数据切得更贴合数据本身；Hash 索引则只服务等值查询，在 PostgreSQL 里长期处于"存在但少用"的状态——了解它的边界比记住它的用法更重要。

## SP-GiST：空间分区树

SP-GiST（Space-Partitioned GiST）把空间递归划分成互不相交的区域：四叉树把平面按中心点分成四个象限，radix tree（字典树）按字符串逐字符分叉。与 GiST 的"节点谓词可以重叠"不同，SP-GiST 的划分互斥，所以特别适合天然树形、深度不均的数据。内置 opclass（实测 `pg_opclass`）：

| 操作符类 | 数据类型 | 树结构 | 典型用途 |
| --- | --- | --- | --- |
| `quad_point_ops`（point 默认） | point | 四叉树 | 地理点、空间聚类 |
| `kd_point_ops` | point | K-D 树 | 同上，查询模式不同时可能更快 |
| `text_ops` | text | radix tree | 前缀搜索 |
| `inet_ops`（PG 10+） | inet / cidr | radix tree | IP 归属、网段查询 |
| `box_ops` / `poly_ops` | box / polygon | 四叉树 | 矩形/多边形 |
| `range_ops` | 任意范围类型 | 四叉树 | 区间重叠 |

`quad_point_ops`、`kd_point_ops`、`poly_ops` 支持 KNN 排序（`ORDER BY col <-> point`）。opclass 细节见官方 [SP-GiST 内置操作符类](https://www.postgresql.org/docs/current/spgist.html)。

## text 前缀搜索的 SP-GiST 用法

SP-GiST `text_ops` 的强项是**前缀匹配**：radix tree 按字符分叉，`LIKE 'abc%'` 直接沿前缀走。内部它被转写成 `^@`（starts with，PG 15 引入）条件：

```sql
CREATE TABLE usernames (name text);
INSERT INTO usernames
SELECT 'user' || lpad(g::text, 7, '0') FROM generate_series(1, 100000) g;

CREATE INDEX usernames_name_spgist ON usernames USING spgist (name text_ops);
ANALYZE usernames;

EXPLAIN (COSTS OFF) SELECT * FROM usernames WHERE name LIKE 'user0001%';
-- Bitmap Heap Scan on usernames
--   Filter: (name ~~ 'user0001%'::text)
--   ->  Bitmap Index Scan on usernames_name_spgist
--         Index Cond: (name ^@ 'user0001'::text)
```

与 B-tree `text_pattern_ops` 相比：SP-GiST 的前缀搜索不受排序规则影响、对基数极高的前缀分布（如 URL、标识符）更省内存；但它是位图扫描，且不支持 `%` 开头的模式。B-tree 方案的取舍见 [模式匹配](/zh/advanced-sql/pattern-matching)。

inet 场景示例（查某网段内所有地址）：

```sql
CREATE TABLE nets (ip inet);
CREATE INDEX nets_ip_spgist ON nets USING spgist (ip inet_ops);

EXPLAIN (COSTS OFF) SELECT * FROM nets WHERE ip << '10.0.3.0/24';
-- Bitmap Heap Scan on nets
--   ->  Bitmap Index Scan on nets_ip_spgist
--         Index Cond: (ip << '10.0.3.0/24'::inet)
```

## Hash 索引：只支持等值

Hash 索引把键值哈希成 4 字节存储，只支持 `=` 一种操作。历史上它是二等公民：PG 10 之前 hash 索引**不写 WAL**，崩溃后可能损坏、也不会被流复制带到备库，生产环境禁用；PG 10 重写后才具备生产可用性。所以版本判断要记住：**PG 10 起才可靠**。

它的边界很硬，两条都实测过：

```sql
CREATE TABLE users_h (email text);
INSERT INTO users_h SELECT 'u' || g || '@example.com' FROM generate_series(1, 100000) g;
CREATE INDEX users_h_email_hash ON users_h USING hash (email);

EXPLAIN (COSTS OFF) SELECT * FROM users_h WHERE email = 'u50000@example.com';
-- Index Scan using users_h_email_hash on users_h
--   Index Cond: (email = 'u50000@example.com'::text)

CREATE UNIQUE INDEX h_uniq ON users_h USING hash (email);
-- ERROR:  access method "hash" does not support unique indexes

CREATE INDEX h_multi ON users_h USING hash (email, email);
-- ERROR:  access method "hash" does not support multicolumn indexes
```

即：**不支持唯一约束、不支持多列**，也不参与 `ORDER BY` 与范围条件。

## 为什么 B-tree 已够大多数等值场景

"hash 查等值 O(1) 应该更快"是直觉陷阱。B-tree 高度只有 3–4 层（见 [B-tree 结构与原则](/zh/indexing/btree-structure)），等值查找的页面读次数与 hash 相差无几，而 hash 索引还要处理哈希冲突与页填充。两者等值查询的实际差距通常测不出来，B-tree 却额外获得范围、排序、多列、唯一约束的能力。体积上 hash 也没有优势——实测同一列 20 万条长字符串（160 字符 md5 重复串）：

```sql
-- long_text_h：v 为 160 字符文本
-- long_text_h_hash  | 64 MB   -- hash
-- long_text_h_btree | 15 MB   -- btree（PG 13+ 去重后反而更小）
```

官方文档的态度也是明确的：除非测试证明 hash 有可测量的收益，否则优先 B-tree（见[索引类型](https://www.postgresql.org/docs/current/indexes-types.html)）。

## 使用清单：何时用 / 何时不用

**SP-GiST 值得用**：

- point 类数据，且查询是"包含在框内 / 最近邻"，GiST 与 SP-GiST 都值得各测一遍；
- 高基数文本的前缀检索（`LIKE 'prefix%'`、`^@`）；
- inet/cidr 网段归属查询。

**SP-GiST 不必用**：普通可排序类型（用 B-tree）；需要唯一约束（SP-GiST 不支持）；数组/jsonb 包含查询（用 GIN）。

**Hash 可以考虑**：仅在"单列等值是唯一查询形态、且基准测试显示确有收益"这种很窄的场景。

**Hash 不要用**：需要唯一约束（用 B-tree）；多列条件（用 B-tree 组合索引）；范围或排序需求（用 B-tree）；PG 10 之前的服务器（无 WAL，直接禁用）。一句话：**等值场景默认 B-tree，hash 只在基准测试说话时才出场**。完整选型路径见 [索引选型决策树](/zh/indexing/index-selection-decision-tree)。

## 参考资料

- [PostgreSQL 官方文档 · Chapter 11. Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL 官方文档 · 11.2. Index Types](https://www.postgresql.org/docs/current/indexes-types.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [模式匹配](/zh/advanced-sql/pattern-matching)
- [GiST 索引](/zh/indexing/gist)
- [B-tree 结构与原则](/zh/indexing/btree-structure)
- [索引选型决策树](/zh/indexing/index-selection-decision-tree)
- [index-selection-decision-tree](/zh/indexing/index-selection-decision-tree)
- [index](/zh/indexing/index)