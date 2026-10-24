# 索引体系

从 B-tree 到 GIN/GiST/BRIN/SP-GiST/Hash 的完整索引家族，以及部分索引、表达式索引与维护实操。

- [B-tree 结构与原则](/zh/indexing/btree-structure) —— 等值/范围/排序、最左前缀、选择性。
- [组合索引设计](/zh/indexing/composite-index-design) —— 列序、INCLUDE 覆盖、索引跳扫。
- [GIN 索引](/zh/indexing/gin) —— 倒排结构、jsonb/数组/全文、fastupdate 与 pending list。
- [GiST 索引](/zh/indexing/gist) —— 空间/范围/全文、KNN 查询。
- [BRIN 索引](/zh/indexing/brin) —— 块摘要、时序追加表、minmax-multi。
- [SP-GiST 与 Hash](/zh/indexing/spgist-and-hash) —— 分区式结构与等值哈希的适用场景。
- [部分索引](/zh/indexing/partial-indexes) —— WHERE 条件索引、热点行、软删配合。
- [表达式索引](/zh/indexing/expression-indexes) —— 函数索引、大小写归一、与生成列的取舍。
- [仅索引扫描](/zh/indexing/index-only-scans) —— 覆盖扫描与 visibility map 依赖。
- [索引膨胀与维护](/zh/indexing/index-bloat-and-maintenance) —— REINDEX CONCURRENTLY、监测。
- [索引失效与误用](/zh/indexing/index-failure-and-misuse) —— 隐式转换、函数包裹列、优化器放弃索引。
- [索引选型决策树](/zh/indexing/index-selection-decision-tree) —— 按查询形态选索引类型。

---

- [查询调优与性能](/zh/performance/index) —— 用 EXPLAIN 验证索引是否被用上。

<!-- BACKLINKS-AUTO -->
## 相关页面

- [index](/zh/advanced-sql/index)
- [index](/zh/database-design/index)
- [index](/zh/internals/index)
- [index](/zh/performance/index)
