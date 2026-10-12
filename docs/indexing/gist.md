# GiST 索引

GiST（Generalized Search Tree，广义搜索树）不是一个具体索引，而是一套"平衡树 + 谓词节点"的框架：它能索引什么、支持什么操作符，完全由列上的**操作符类（operator class，opclass）**决定。同一套结构，配上几何 opclass 就能做空间检索，配上范围 opclass 就能做区间重叠查询。这让 GiST 成为范围类型、几何类型、KNN 最近邻这类"B-tree 无法排序"的数据的主要选择。官方文档见 [GiST 索引](https://www.postgresql.org/docs/current/gist.html)。

## 操作符类决定能索引什么

内置 opclass 一览（PG 16/17）：

| 操作符类 | 索引类型 | 典型操作符 |
| --- | --- | --- |
| `range_ops` | 任意范围类型 | `&&` `@>` `<@` `<<` `>>` `-|-` `=` |
| `box_ops` / `poly_ops` | box / polygon | `&&` `@>` `<@` `<<` `>>` |
| `point_ops`（默认）/ `kd_point_ops` | point | `<@` `~=` 与 KNN `<->` |
| `inet_ops`（PG 10+） | inet / cidr | `<<` `<<=` `>>` `>>=` `=` `&&` |
| `text_ops` | text | `<` `<=` `=` `>` `>=` 与 `^@`（PG 15+） |

建索引时不写 opclass 就用该类型的默认值，例如 `tstzrange` 默认 `range_ops`：

```sql
CREATE TABLE meetings (
    room   text,
    during tstzrange NOT NULL,
    title  text
);

INSERT INTO meetings
SELECT 'room-' || (g % 5),
       tstzrange(now() - (g || ' min')::interval,
                 now() - (g || ' min')::interval + interval '30 min'),
       'm' || g
FROM generate_series(1, 2000) g;

CREATE INDEX meetings_during_idx ON meetings USING gist (during);
ANALYZE meetings;

EXPLAIN (COSTS OFF) SELECT * FROM meetings
WHERE during && tstzrange(now(), now() + interval '1 hour', '[)');
-- Bitmap Heap Scan on meetings
--   Recheck Cond: (during && tstzrange(...))
--   ->  Bitmap Index Scan on meetings_during_idx
--         Index Cond: (during && tstzrange(...))
```

范围类型的完整语义见 [范围类型与 EXCLUDE](../advanced-sql/range-types-and-exclude)。

## KNN：按距离排序直接走索引

GiST（以及 SP-GiST 的 point 类）支持距离操作符 `<->` 出现在 `ORDER BY` 中，索引按距离顺序返回行，`LIMIT n` 时只算最近的 n 个：

```sql
CREATE TABLE poi (name text, loc point);
INSERT INTO poi
SELECT 'p' || g, point(120 + (g % 1000) * 0.001, 30 + (g % 1000) * 0.001)
FROM generate_series(1, 2000) g;

CREATE INDEX poi_loc_idx ON poi USING gist (loc);

EXPLAIN (COSTS OFF) SELECT name FROM poi
ORDER BY loc <-> point(120.5, 30.5) LIMIT 5;
-- Limit
--   ->  Index Scan using poi_loc_idx on poi
--         Order By: (loc <-> '(120.5,30.5)'::point)
```

注意计划里没有 Sort 节点——距离排序是索引本身的遍历顺序。向量检索场景（pgvector）用的 HNSW/IVFFlat 是独立访问方法，原理同源，见 [pgvector](../ecosystem/pgvector)。

## lossy 索引与 recheck

有些 opclass 在索引里只存**近似信息**。比如 `poly_ops` 对多边形只存外接矩形：索引先用矩形判断"可能相交"，命中后再由执行器用原始条件精确过滤，这一步叫 **recheck**。这类索引称为 lossy（有损）索引。体现在计划里就是 `Recheck Cond`，`EXPLAIN ANALYZE` 下还能看到 `Rows Removed by Index Recheck`：

```sql
CREATE TABLE shapes (id int, poly polygon);
INSERT INTO shapes SELECT g, polygon(circle(point(0,0), 5 + (g % 10)))
FROM generate_series(1, 2000) g;
CREATE INDEX shapes_poly_idx ON shapes USING gist (poly);

EXPLAIN (COSTS OFF) SELECT * FROM shapes
WHERE poly && polygon(box(point(0.1,0.1), point(0.1,0.1)));
-- Bitmap Heap Scan on shapes
--   Recheck Cond: (poly && '((0.1,0.1),...)'::polygon)   -- 精确过滤在这层
--   ->  Bitmap Index Scan on shapes_poly_idx             -- 索引只按外接矩形筛
```

对设计的影响：外接矩形越贴近原形状 recheck 浪费越少；对细长、镂空的几何体，recheck 可能过滤掉大量候选行，这是几何索引慢于预期的常见原因。

## btree_gist：让普通类型也能进 GiST

GiST 自带 opclass 只覆盖范围、几何、文本等类型。但一个高频需求是"普通列 + 范围列"组合进同一个 GiST 索引——**EXCLUDE 排除约束**要求所有列都走 GiST（见 [约束与数据质量](../database-design/constraints-and-data-quality)）。`btree_gist` 扩展把 int、text、timestamptz 等 B-tree 类型也搬进 GiST：

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 会议室同一时段不能有两个预订
ALTER TABLE meetings ADD CONSTRAINT no_overlap
  EXCLUDE USING gist (room WITH =, during WITH &&);
```

两点实用提示：

- 建约束时若表里已有互相冲突的数据会直接报错，例如 `DETAIL: Key (room, during)=(room-1, [...]) conflicts with key (room, during)=(room-1, [...])`，需要先清数据。
- `btree_gist` 的 B-tree 等价查询性能**不如真 B-tree 索引**，它存在的意义是让约束生效，不是替代 B-tree。

## GiST 与 GIN 的对比

两者都是"广义"索引，选型取决于数据形态与查询形态：

| 维度 | GiST | GIN |
| --- | --- | --- |
| 条目粒度 | 一行一条目，可原地更新 | 一个组成部分一条目，插入一行可能写多条 |
| 写入代价 | 相对平缓，无 pending list | 依赖 fastupdate/pending list，清理不及时会抖动 |
| 擅长的查询 | 重叠 `&&`、相邻、最近邻 `<->`、EXCLUDE 约束 | 包含 `@>`、键存在 `?`、词匹配 `@@` |
| lossy | 部分 opclass 有损（需要 recheck） | 基本无损 |
| 典型数据 | 范围类型、几何、point | 数组、jsonb、tsvector、trigram |

经验判断：查询形态是"有没有交集/谁最近"用 GiST，是"包不包含/有没有这个词"用 GIN。对 tsvector 全文检索，官方也推荐 GIN 优先（GiST 属有损、且查询更慢），见 [全文检索](../advanced-sql/full-text-search)。完整的选型路径见 [索引选型决策树](./index-selection-decision-tree)。

## 相关页面

- [范围类型与 EXCLUDE](../advanced-sql/range-types-and-exclude)
- [GIN 索引](./gin)
- [PostGIS](../ecosystem/postgis)
- [索引选型决策树](./index-selection-decision-tree)
