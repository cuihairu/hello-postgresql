# Basics & Core SQL

The core pages I come back to when creating databases, writing queries, handling transactions and diagnosing problems. They are arranged by topic, but if you already have a database background you can jump straight to the problem you are hitting.

- [What Is PostgreSQL](/basics/what-is-postgresql) — history, license, the ACID and MVCC stance, and where it fits.
- [Installation and First Connection](/basics/install-and-quickstart) — apt/yum/Homebrew/Windows installs, bootstrapping a cluster with `initdb`, and running your first query.
- [Everyday psql](/basics/psql-getting-started) — connection flags, meta-commands like `\dt`, `\d`, `\timing` and `\x`, and personalising with `psqlrc`.
- [Databases and Schema Objects](database-and-schema-objects.md) — the cluster/database/schema/table hierarchy, ownership, and `search_path`.
- [Data Types Overview](data-types-overview.md) — numeric, text, timestamp, boolean and UUID types, and the `serial` versus `identity` choice.
- [A Tour of Special Types](special-types-intro.md) — the minimum viable knowledge for JSONB, arrays, ranges, enums and composite types.
- [CRUD and ON CONFLICT](crud-and-on-conflict.md) — INSERT, UPDATE, DELETE, upserts and `RETURNING`.
- [WHERE and Expressions](where-and-expressions.md) — comparisons, `LIKE`/`ILIKE`, `IN`, and NULL semantics.
- [Aggregation and GROUP BY](aggregate-and-group-by.md) — aggregate functions, `HAVING`, `FILTER`, and NULLs in groups.
- [The JOIN Family](join-family.md) — inner, left, right, full and cross, `USING` and `NATURAL`, and self joins.
- [Functions and Operators](functions-and-operators.md) — the `::` cast, `COALESCE`, and SQL and PL/pgSQL function basics.
- [Transaction Basics](transaction-basics.md) — `BEGIN`, `COMMIT`, `ROLLBACK`, SAVEPOINTs, and the fact that DDL rolls back too.
- [System Catalogs and Metadata](system-catalogs-and-metadata.md) — `pg_class`, `pg_tables`, `information_schema`, and queries for table sizes.
- [Naming and Style Conventions](naming-and-style-conventions.md) — the case-folding rules, the double-quote trap, and naming conventions.
- [Common Beginner Mistakes](common-beginner-mistakes.md) — a checklist of frequent traps: NULL comparisons, implicit casts, time zones and more.

---

- [Dev Notes](../knowledge.md) — cross-topic notes.

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Advanced SQL](/advanced-sql/index.md)
- [Database Design](/database-design/index.md)
- [Tools & Cases](/tools/index.md)
