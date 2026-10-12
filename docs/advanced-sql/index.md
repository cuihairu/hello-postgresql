# 第3部分：高级 SQL

CTE、窗口函数、LATERAL、JSONB、数组、全文检索——把 PostgreSQL 表达能力真正用起来的部分。

- [CTE 与非递归 WITH](cte-and-non-recursive-with.md) —— 可读性改写、MATERIALIZED 与内联的取舍。
- [递归 CTE](recursive-cte.md) —— 层级遍历、树/图遍历、循环终止。
- [窗口函数](window-functions.md) —— OVER/PARTITION BY/ORDER BY、frame 语义。
- [窗口函数进阶](window-functions-advanced.md) —— LAG/LEAD、NTILE、排名族、移动平均。
- [集合运算](set-operations.md) —— UNION/INTERSECT/EXCEPT、ALL 与去重、排序归属。
- [LATERAL 与 FROM 子查询](lateral-and-from-subquery.md) —— 相关子查询下推、top-N per group。
- [子查询家族](subquery-family.md) —— 标量/IN/EXISTS/ANY 与去相关化。
- [JSONB 操作](jsonb-operations.md) —— `->`/`->>`/`#>`/`@>`、jsonpath、containment 索引。
- [JSONB 设计模式](jsonb-design-patterns.md) —— 文档列、生成列、部分索引、与关系列的取舍。
- [数组操作](array-operations.md) —— unnest、数组包含、GIN 配合。
- [范围类型与 EXCLUDE](range-types-and-exclude.md) —— tsrange、期间重叠约束。
- [全文检索](full-text-search.md) —— tsvector/tsquery、权重、GIN、词典。
- [三种模式匹配](pattern-matching.md) —— LIKE/ILIKE、正则、pg_trgm 相似度与索引。
- [生成列与 CHECK 表达式](generated-columns-and-check.md) —— GENERATED ALWAYS AS、索引化。
- [条件表达式](conditional-expressions.md) —— CASE、FILTER、DISTINCT ON、NULLS FIRST/LAST。
- [分页与排序](pagination-and-sorting.md) —— OFFSET 陷阱、keyset 分页、不稳定排序。
- [SQL 函数进阶](sql-functions-advanced.md) —— plpgsql 变量与异常块、VOLATILE/STABLE/IMMUTABLE。
- [批量与写入](batch-and-write.md) —— COPY、多值 INSERT、批量 ON CONFLICT。

---

- [基础知识](../basics/) · [索引体系](../indexing/) —— 高级查询的性能配套。
