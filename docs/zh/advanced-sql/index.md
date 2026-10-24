# 高级 SQL

CTE、窗口函数、LATERAL、JSONB、数组、全文检索——把 PostgreSQL 表达能力真正用起来的部分。

- [CTE 与非递归 WITH](/zh/advanced-sql/cte-and-non-recursive-with) —— 可读性改写、MATERIALIZED 与内联的取舍。
- [递归 CTE](/zh/advanced-sql/recursive-cte) —— 层级遍历、树/图遍历、循环终止。
- [窗口函数](/zh/advanced-sql/window-functions) —— OVER/PARTITION BY/ORDER BY、frame 语义。
- [窗口函数进阶](/zh/advanced-sql/window-functions-advanced) —— LAG/LEAD、NTILE、排名族、移动平均。
- [集合运算](/zh/advanced-sql/set-operations) —— UNION/INTERSECT/EXCEPT、ALL 与去重、排序归属。
- [LATERAL 与 FROM 子查询](/zh/advanced-sql/lateral-and-from-subquery) —— 相关子查询下推、top-N per group。
- [子查询家族](/zh/advanced-sql/subquery-family) —— 标量/IN/EXISTS/ANY 与去相关化。
- [JSONB 操作](/zh/advanced-sql/jsonb-operations) —— `->`/`->>`/`#>`/`@>`、jsonpath、containment 索引。
- [JSONB 设计模式](/zh/advanced-sql/jsonb-design-patterns) —— 文档列、生成列、部分索引、与关系列的取舍。
- [数组操作](/zh/advanced-sql/array-operations) —— unnest、数组包含、GIN 配合。
- [范围类型与 EXCLUDE](/zh/advanced-sql/range-types-and-exclude) —— tsrange、期间重叠约束。
- [全文检索](/zh/advanced-sql/full-text-search) —— tsvector/tsquery、权重、GIN、词典。
- [三种模式匹配](/zh/advanced-sql/pattern-matching) —— LIKE/ILIKE、正则、pg_trgm 相似度与索引。
- [生成列与 CHECK 表达式](/zh/advanced-sql/generated-columns-and-check) —— GENERATED ALWAYS AS、索引化。
- [条件表达式](/zh/advanced-sql/conditional-expressions) —— CASE、FILTER、DISTINCT ON、NULLS FIRST/LAST。
- [分页与排序](/zh/advanced-sql/pagination-and-sorting) —— OFFSET 陷阱、keyset 分页、不稳定排序。
- [SQL 函数进阶](/zh/advanced-sql/sql-functions-advanced) —— plpgsql 变量与异常块、VOLATILE/STABLE/IMMUTABLE。
- [批量与写入](/zh/advanced-sql/batch-and-write) —— COPY、多值 INSERT、批量 ON CONFLICT。

---

- [基础知识](/zh/basics/index) · [索引体系](/zh/indexing/index) —— 高级查询的性能配套。
