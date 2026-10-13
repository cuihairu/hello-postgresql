# 第5部分：索引体系

从 B-tree 到 GIN/GiST/BRIN/SP-GiST/Hash 的完整索引家族，以及部分索引、表达式索引与维护实操。

- [B-tree 结构与原则](btree-structure.md) —— 等值/范围/排序、最左前缀、选择性。
- [组合索引设计](composite-index-design.md) —— 列序、INCLUDE 覆盖、索引跳扫。
- [GIN 索引](gin.md) —— 倒排结构、jsonb/数组/全文、fastupdate 与 pending list。
- [GiST 索引](gist.md) —— 空间/范围/全文、KNN 查询。
- [BRIN 索引](brin.md) —— 块摘要、时序追加表、minmax-multi。
- [SP-GiST 与 Hash](spgist-and-hash.md) —— 分区式结构与等值哈希的适用场景。
- [部分索引](partial-indexes.md) —— WHERE 条件索引、热点行、软删配合。
- [表达式索引](expression-indexes.md) —— 函数索引、大小写归一、与生成列的取舍。
- [仅索引扫描](index-only-scans.md) —— 覆盖扫描与 visibility map 依赖。
- [索引膨胀与维护](index-bloat-and-maintenance.md) —— REINDEX CONCURRENTLY、监测。
- [索引失效与误用](index-failure-and-misuse.md) —— 隐式转换、函数包裹列、优化器放弃索引。
- [索引选型决策树](index-selection-decision-tree.md) —— 按查询形态选索引类型。

---

- [查询调优与性能](../performance/) —— 用 EXPLAIN 验证索引是否被用上。

<!-- BACKLINKS-AUTO -->
## 相关页面

- [index](/advanced-sql/index.md)
- [index](/database-design/index.md)
- [index](/internals/index.md)
- [index](/performance/index.md)
