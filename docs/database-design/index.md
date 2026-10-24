# Database Design

Normalization, primary and foreign keys, constraints and data quality, partitioning and multi-tenant design, and common anti-patterns: primary and foreign keys, constraints and data quality, partitioning and multi-tenancy, plus a common anti-patterns checklist.

- [The Three Normal Forms and Denormalization](normalization-and-denormalization.md) — 1NF/2NF/3NF derivation, and the redundancy-versus-read-performance trade-off.
- [Primary Key Design](primary-key-design.md) — BIGINT identity vs UUID vs composite keys, and the impact on indexes and cursor pagination.
- [Foreign Keys and Referential Actions](foreign-keys-and-referential-actions.md) — ON DELETE CASCADE/SET NULL, deferred constraints.
- [CHECK and Domain Types](check-and-domains.md) — domain reuse, regex constraints, constraint naming conventions.
- [Table Inheritance and Partitioned Table Design](table-inheritance-and-partitioning-design.md) — declarative PARTITION BY RANGE/LIST/HASH.
- [Views and Updatable Views](views-and-updatable-views.md) — writability of simple views, WITH CHECK OPTION.
- [Materialized Views](materialized-views.md) — REFRESH CONCURRENTLY, incremental refresh ideas and use cases.
- [From Logical Modeling to Physical DDL](logical-to-physical-modeling.md) — E-R diagrams to DDL: sequences, defaults, timestamp conventions.
- [Soft Delete and Tombstones](soft-delete-and-tombstone.md) — deleted_at, unique indexes with NULL, partial indexes in combination.
- [Multi-Tenant Modeling](multi-tenant-modeling.md) — schema-per-tenant vs RLS vs a single table with tenant_id.
- [Modeling Time](time-modeling.md) — timestamptz conventions, timezone handling, validity periods with range types.
- [Money and Numeric Types](money-and-numeric.md) — fixed-point numeric, money columns, rounding rules.
- [Constraints and Data Quality](constraints-and-data-quality.md) — NOT NULL policy, EXCLUSION constraints, triggers as a backstop.
- [Anti-Pattern Checklist](anti-patterns.md) — EAV misuse, the catch-all JSONB table, unbounded self-references.

---

- [Basics](../basics/) · [Indexing](../indexing/) — index support for what the design produces.
