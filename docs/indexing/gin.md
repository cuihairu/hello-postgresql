# GIN 索引

GIN（Generalized Inverted Index，广义倒排索引）为"一个值里包含多个组成部分"的数据设计：数组、jsonb、tsvector、trigram 字符串。它为每个组成部分（元素、键、词素）单独建条目，查询时直接取"包含该部分的行"列表。代价是结构复杂、更新较慢。本文梳理倒排结构、各类型的操作符配合、pending list 的性能影响与 jsonb 两种操作符类的选择。官方文档见 [GIN 索引](https://www.postgresql.org/docs/current/gin.html)。

## 倒排结构：从组成部分到行

B-tree 的条目是"一行一个"，GIN 的条目是"**一个组成部分一个 posting list**"——记录所有包含该部分的行的 TID。 postings 多到放不进一条链时会转成 posting tree（B-tree 形态）。

```sql
CREATE TABLE articles (
    id   int GENERATED ALWAYS AS IDENTITY,
    tags text[],
    body jsonb
);

INSERT INTO articles (tags, body)
SELECT CASE WHEN g % 100 = 0 THEN ARRAY['common','rare_tag'] ELSE ARRAY['common'] END,
       jsonb_build_object('title', 't' || g,
                          'kind', CASE WHEN g % 50 = 0 THEN 'vip' ELSE 'normal' END)
FROM generate_series(1, 300000) g;

CREATE INDEX articles_tags_idx ON articles USING gin (tags);
ANALYZE articles;
```

查询时 GIN 从索引里取出匹配的 TID 列表，构成位图。这也是 GIN 的一个硬性特征：**只支持 Bitmap Index Scan**，不支持普通 Index Scan 和 Index Only Scan：

```sql
EXPLAIN (COSTS OFF) SELECT id FROM articles WHERE tags @> ARRAY['rare_tag'];
-- Bitmap Heap Scan on articles
--   Recheck Cond: (tags @> '{rare_tag}'::text[])
--   ->  Bitmap Index Scan on articles_tags_idx
--         Index Cond: (tags @> '{rare_tag}'::text[])
```

上面的例子故意让 `rare_tag` 只出现在 1% 的行里。GIN 索引是否被采用与选择性有关——如果条件命中大半张表，优化器会直接顺序扫描。

## 适用类型与操作符配合

内置操作符类及其支持的索引化操作符（见[官方操作符类表](https://www.postgresql.org/docs/current/indexes-opclass.html)）：

| 操作符类 | 索引类型 | 可索引操作符 |
| --- | --- | --- |
| `array_ops` | 任意数组 | `@>` `<@` `&&` `=` |
| `jsonb_ops`（默认） | jsonb | `@>` `?` `?\|` `?&` `@@` `@?` |
| `jsonb_path_ops` | jsonb | `@>` `@@` `@?` |
| `tsvector_ops` | tsvector | `@@` |
| `gin_trgm_ops`（pg_trgm 扩展） | text | `LIKE` `ILIKE` `~` 等 |

两点容易踩坑：

- **数组没有 `?` 操作符**。判断数组是否包含某元素要写 `tags @> ARRAY['x']`，`?` 系列只存在于 jsonb 上。
- **jsonb 的键存在查询 `body ? 'title'` 只有默认的 `jsonb_ops` 能用索引**；`jsonb_path_ops` 建的索引遇到 `?` 只能顺序扫描。

jsonb 与全文检索的查询写法详见 [jsonb 操作](../advanced-sql/jsonb-operations)与[全文检索](../advanced-sql/full-text-search)。

## fastupdate 与 pending list

GIN 更新慢的根源：往表里插一行可能拆出很多组成部分，每个都要写进索引。PG 的缓解机制是 **fastupdate**：新条目先堆积到一个未排序的 pending list，攒够一批再一次性合并进主结构：

- 阈值由 `gin_pending_list_limit` 控制，默认 4 MB（可在索引上用同名存储参数单独设置）。
- 触发合并的时机：表被 `VACUUM`/`ANALYZE`、调用 `gin_clean_pending_list()`、或插入使列表超过阈值（此时**前台插入要付整批合并的成本**）。
- 代价：**每次查询都要扫描 pending list**，列表越大查询越慢、延迟越不稳定。

```sql
SHOW gin_pending_list_limit;                        -- 默认 4MB
SELECT gin_clean_pending_list('articles_tags_idx'); -- 手动清理，返回清理页数
ALTER INDEX articles_tags_idx SET (gin_pending_list_limit = 1024);  -- 单位 KB
```

## 更新密集场景的取舍

对写多读少的表，fastupdate 开着通常是对的：插入快，清理交给 autovacuum。对要求查询延迟稳定的表则反过来——干脆关掉 fastupdate，让每条插入直接进主结构：

```sql
-- 建索引时关闭
CREATE INDEX idx_docs ON documents USING gin (body) WITH (fastupdate = off);
-- 对已有索引关闭
ALTER INDEX idx_docs SET (fastupdate = off);
```

判断依据可以量化：如果查询经常因为 pending list 出现毫秒级抖动、而插入吞吐不是瓶颈，就关；反之如果写入是热点、查询能容忍偶尔的慢，就开着并注意清理节奏（`autovacuum_vacuum_scale_factor` 调低一点让清理更勤快，见 [autovacuum 调优](../internals/autovacuum-tuning)）。

GIN 也会随删除/更新产生垃圾条目，`VACUUM` 会清理它们；结构严重劣化时可以整体重建：

```sql
REINDEX INDEX CONCURRENTLY articles_tags_idx;
```

体积与重建的更多手段见 [索引膨胀与维护](./index-bloat-and-maintenance)。

## jsonb_ops 与 jsonb_path_ops 的选择

两种操作符类对同一个 jsonb 列建索引，结构完全不同：

- `jsonb_ops`：对每个键和每个值分别建条目，支持键存在类查询（`?` `?|` `?&`）和包含查询（`@>`）。
- `jsonb_path_ops`：只对"键路径 + 值"的哈希建条目，**只支持 `@>` `@@` `@?`**，不支持键存在查询；换来的是更小的索引和更快的包含查询。另外它对"不含任何标量值的结构"（如空数组）不建条目，查这些值会漏。

实测同一列两种索引的体积（30 万行 jsonb）：

```sql
CREATE INDEX articles3_body_idx     ON articles3 USING gin (body jsonb_path_ops);
CREATE INDEX articles3_body_ops_idx ON articles3 USING gin (body);
SELECT indexrelid::regclass AS idx, pg_size_pretty(pg_relation_size(indexrelid))
FROM pg_index WHERE indrelid = 'articles3'::regclass ORDER BY 1;
--     idx              |  size
-- ---------------------+--------
--  ..._body_idx        |  5248 kB   -- jsonb_path_ops，明显更小
--  ..._body_ops_idx    |  6440 kB   -- jsonb_ops
```

选择标准：查询只用 `@>`（或 jsonpath 的 `@@`/`@?`）→ 选 `jsonb_path_ops`，小且快；需要 `?` 键存在查询 → 只能 `jsonb_ops`。

trigram 方面的用法（`LIKE '%关键词%'` 走索引）见 [模式匹配](../advanced-sql/pattern-matching)。

## 参考资料

- [PostgreSQL 官方文档 · Chapter 11. Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL 官方文档 · 11.2. Index Types](https://www.postgresql.org/docs/current/indexes-types.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [jsonb 操作](../advanced-sql/jsonb-operations)
- [全文检索](../advanced-sql/full-text-search)
- [索引膨胀与维护](./index-bloat-and-maintenance)
- [索引选型决策树](./index-selection-decision-tree)
- [array-operations](/advanced-sql/array-operations.md)
- [full-text-search](/advanced-sql/full-text-search.md)
- [jsonb-design-patterns](/advanced-sql/jsonb-design-patterns.md)
- [jsonb-operations](/advanced-sql/jsonb-operations.md)
- [pattern-matching](/advanced-sql/pattern-matching.md)
- [pgvector](/ecosystem/pgvector.md)
- [expression-indexes](expression-indexes.md)
- [gist](gist.md)
- [index-failure-and-misuse](index-failure-and-misuse.md)
- [index-selection-decision-tree](index-selection-decision-tree.md)
- [index](index.md)
- [toast](/internals/toast.md)