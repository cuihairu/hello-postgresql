# 向量检索 pgvector

pgvector 是 PostgreSQL 的开源向量扩展：给表加一列 `vector` 类型，用距离操作符做相似度排序，再配 HNSW 或 IVFFlat 索引做近似检索（ANN）。典型场景是 RAG、语义搜索、推荐召回——embedding 与业务数据同库，可以一起 JOIN、过滤、做事务。项目地址见 [pgvector GitHub](https://github.com/pgvector/pgvector)。

## 安装与建扩展

```bash
# Debian/Ubuntu（PGDG 仓库）
sudo apt install postgresql-16-pgvector
# 或使用官方 Docker 镜像
docker run -e POSTGRES_PASSWORD=secret -p 5432:5432 pgvector/pgvector:pg16
```

主流托管 PG（RDS、Cloud SQL 等）大多已提供 pgvector，只需在允许列表中启用。装好后：

```sql
CREATE EXTENSION vector;
```

## 向量列与距离操作符

`vector(n)` 定长向量，上限 16000 维。三个核心操作符，注意它们语义不同：

| 操作符 | 含义 | 距离范围 |
| --- | --- | --- |
| `<->` | 欧氏距离（L2） | ≥ 0，越小越相似 |
| `<=>` | **余弦距离**（1 − 余弦相似度） | 0 到 2，越小越相似 |
| `<#>` | **负内积**（取负是为了让「越大越相似」变成升序排前） | 结果为负数 |

最常见的坑：把 `<=>` 当成余弦相似度。它是余弦**距离**，排序时要 ASC（`ORDER BY ... <=>` 升序取最近）；如果模型返回的是相似度分数，与查询结果对不上时先检查这个。OpenAI 风格的归一化向量用 `<=>` 或 `<->` 结果一致，未归一化向量通常用 `<=>`。

```sql
CREATE TABLE docs (
    id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    content   text NOT NULL,
    embedding vector(4) NOT NULL
);

INSERT INTO docs (content, embedding) VALUES
    ('cat', '[0.9, 0.1, 0.0, 0.2]'),
    ('dog', '[0.8, 0.2, 0.1, 0.1]'),
    ('car', '[0.0, 0.1, 0.9, 0.8]');

-- 余弦距离最近的两条
SELECT content,
       embedding <=> '[0.85, 0.15, 0.0, 0.2]' AS distance
FROM docs
ORDER BY embedding <=> '[0.85, 0.15, 0.0, 0.2]'
LIMIT 2;
```

真实场景中 `vector(4)` 换成模型输出的维度（如 768、1536）。

## 两种索引：HNSW 与 IVFFlat

不建索引时，`ORDER BY ... <=>` 是全表精确扫描；索引建立后自动转为近似检索。索引类型必须与查询操作符匹配（`vector_cosine_ops` 对应 `<=>`）。

**HNSW**（分层可导航小世界图）：召回率高、建索引慢、内存占用大。两个建索引参数加一个查询参数：

```sql
CREATE INDEX ON docs
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

- `m`（默认 16）：每个节点保留的邻居连接数，越大图越稠密、召回越高、内存越大。
- `ef_construction`（默认 64）：建图时的候选队列长度，越大建得越慢、图质量越高。
- `hnsw.ef_search`（默认 40）：**查询时**的候选队列长度，直接决定单次查询的召回-延迟权衡。

**IVFFlat**（倒排文件聚类）：建索引快、内存省，但召回对参数敏感：

```sql
ANALYZE docs;  -- 先让统计信息就绪
CREATE INDEX ON docs
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
SET ivfflat.probes = 10;
```

- `lists`：聚类中心数，经验值是百万行以内取 `行数/1000`，更大规模取 `sqrt(行数)`。
- `ivfflat.probes`（默认 1）：查询时探测的聚类数，取 1 召回通常不可接受，一般调到 `sqrt(lists)` 左右起步。
- IVFFlat 必须在**表里已有数据**后再建索引（要用数据估聚类中心），空表建出来的是坏索引；HNSW 无此要求。

## 查询时调参与精确检索

`SET` 是会话级、`SET LOCAL` 是事务级——做检索服务时用 `SET LOCAL`，让每条查询带自己的召回预算：

```sql
BEGIN;
SET LOCAL hnsw.ef_search = 100;  -- 默认 40，调大换召回
SELECT id, content
FROM docs
ORDER BY embedding <=> $1
LIMIT 20;
COMMIT;
```

不设索引、不设任何参数的 `ORDER BY ... <=>` 就是精确检索（穷举所有行），小表（几万行以内）直接用它反而更简单可靠。判断「近似结果偏差是否可接受」的方法：同一批查询分别跑精确与近似，算 top-k 重合率（recall@k）。

## 带过滤条件的向量查询

RAG 常见需求是「在某个租户/某类文档内做语义检索」，即 `WHERE` + 向量排序混合：

```sql
SELECT id, content
FROM docs
WHERE tenant_id = 42 AND status = 'published'
ORDER BY embedding <=> $1
LIMIT 10;
```

性能与正确性都要注意：

- HNSW 索引扫描会带着过滤条件遍历图，但如果过滤条件很挑剔（命中率低），遍历完 `ef_search` 预算也凑不够 LIMIT 条数，结果会「偏少且偏窄」。缓解手段：调大 `ef_search`、对高频过滤维度建 [partial index](../indexing/partial-indexes)、或升级 pgvector 使用 0.8+ 的迭代式索引扫描。
- 过滤列尽量与向量同表（配合组合索引），跨表 JOIN 会让计划更难走索引。

## 与专用向量数据库的取舍

留在 PostgreSQL 里的理由：embedding 与业务行同库同事务，JOIN、软删除、权限（[RLS](../security/row-level-security)）全部免费获得，不用再维护一套同步管道。需要评估外迁的信号：向量数据量到数十 GB 以上（HNSW 图基本要求整体驻留内存）、单机 QPS 打不满、需要多副本分片检索。规模判断参考 [容量与扩展上限](../performance/capacity-and-scaling-limits)。

## 注意事项与常见坑

- 维度必须与建表时一致，`vector(1536)` 列塞不进 768 维向量；换模型要改列或建新列。
- 索引建好后 `ANALYZE`，否则行数估算失真会影响 [计划选择](../performance/explain-basics)。
- 批量灌数据时先灌完再建索引，边灌边维护 HNSW 图会明显拖慢导入。
- 大于 2000 维的向量建议用 `halfvec`（半精度，上限 4000 维）或先降维，减小索引体积。

## 相关页面

- [扩展管理](./extension-management)
- [GiST 索引](../indexing/gin)
- [索引选型决策树](../indexing/index-selection-decision-tree)
- [选型问答](./when-to-choose-postgresql)
