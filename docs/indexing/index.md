# Indexing

The full index family from B-tree to GIN, GiST, BRIN, SP-GiST and Hash, plus partial indexes, expression indexes, and hands-on maintenance.

- [B-tree Structure and Principles](btree-structure.md) — equality/range/sort, the leftmost-prefix rule, selectivity.
- [Composite Index Design](composite-index-design.md) — column order, INCLUDE for covering, index skip scans.
- [GIN Indexes](gin.md) — the inverted structure, jsonb/arrays/full-text, fastupdate and the pending list.
- [GiST Indexes](gist.md) — spatial/range/full-text, KNN queries.
- [BRIN Indexes](brin.md) — block summaries, time-series append-only tables, minmax-multi.
- [SP-GiST and Hash](spgist-and-hash.md) — when the partitioned structure and equality hashing fit.
- [Partial Indexes](partial-indexes.md) — WHERE-condition indexes, hot rows, pairing with soft deletes.
- [Expression Indexes](expression-indexes.md) — function indexes, case normalization, the trade-off with generated columns.
- [Index-Only Scans](index-only-scans.md) — covering scans and the dependency on the visibility map.
- [Index Bloat and Maintenance](index-bloat-and-maintenance.md) — REINDEX CONCURRENTLY, monitoring.
- [Index Failure and Misuse](index-failure-and-misuse.md) — implicit casts, wrapping a column in a function, the optimizer dropping the index.
- [Index Selection Decision Tree](index-selection-decision-tree.md) — picking the index type by query shape.

---

- [Query Performance](../performance/) — use EXPLAIN to confirm the index is being used.

<!-- BACKLINKS-AUTO -->
## Related Pages

- [index](/advanced-sql/index.md)
- [index](/database-design/index.md)
- [index](/internals/index.md)
- [index](/performance/index.md)
