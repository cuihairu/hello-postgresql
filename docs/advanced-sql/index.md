# Advanced SQL

CTE, window functions, LATERAL, JSONB, arrays, full-text search — the part that actually puts PostgreSQL's expressive power to work.

- [CTE and Non-Recursive WITH](cte-and-non-recursive-with.md) — readability rewrites, the MATERIALIZED-versus-inline trade-off.
- [Recursive CTE](recursive-cte.md) — hierarchical traversal, tree/graph walking, loop termination.
- [Window Functions](window-functions.md) — OVER/PARTITION BY/ORDER BY, frame semantics.
- [Window Functions, Advanced](window-functions-advanced.md) — LAG/LEAD, NTILE, the ranking family, moving averages.
- [Set Operations](set-operations.md) — UNION/INTERSECT/EXCEPT, ALL versus DISTINCT, sort attribution.
- [LATERAL and FROM Subqueries](lateral-and-from-subquery.md) — pushing correlated subqueries down, top-N per group.
- [The Subquery Family](subquery-family.md) — scalar/IN/EXISTS/ANY and decorrelation.
- [JSONB Operations](jsonb-operations.md) — `->`/`->>`/`#>`/`@>`, jsonpath, containment indexes.
- [JSONB Design Patterns](jsonb-design-patterns.md) — document columns, generated columns, partial indexes, the trade-off with relational columns.
- [Array Operations](array-operations.md) — unnest, array containment, GIN in combination.
- [Range Types and EXCLUDE](range-types-and-exclude.md) — tsrange, period-overlap constraints.
- [Full-Text Search](full-text-search.md) — tsvector/tsquery, weights, GIN, dictionaries.
- [Three Kinds of Pattern Matching](pattern-matching.md) — LIKE/ILIKE, regular expressions, pg_trgm similarity and indexes.
- [Generated Columns and CHECK Expressions](generated-columns-and-check.md) — GENERATED ALWAYS AS, making them indexable.
- [Conditional Expressions](conditional-expressions.md) — CASE, FILTER, DISTINCT ON, NULLS FIRST/LAST.
- [Pagination and Sorting](pagination-and-sorting.md) — the OFFSET trap, keyset pagination, unstable sorts.
- [SQL Functions, Advanced](sql-functions-advanced.md) — plpgsql variables and exception blocks, VOLATILE/STABLE/IMMUTABLE.
- [Batching and Writes](batch-and-write.md) — COPY, multi-value INSERT, batched ON CONFLICT.

---

- [Basics](../basics/) · [Indexing](../indexing/) — performance support for advanced queries.
