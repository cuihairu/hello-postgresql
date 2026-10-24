# Design Anti-Patterns

This page collects the most common anti-patterns at the table-design level. Their common trait is that **they are not syntax errors — they all run and ship fine**, only to surface after data volume grows, concurrency rises, or a delete operation happens. Each entry gives the symptom, a minimal reproduction, and the fix, to use when doing code review or checking existing tables.

## EAV: Entity-Attribute-Value

Storing "attributes" as data rather than as column definitions:

```sql
CREATE TABLE entity_attrs (
  entity_id  bigint NOT NULL,
  attr_name  text  NOT NULL,
  attr_value text              -- every attribute is text
);

INSERT INTO entity_attrs VALUES (1, 'age', '30'), (2, 'age', '9');

-- "find entities where age > 30" becomes a text comparison
SELECT entity_id FROM entity_attrs
WHERE attr_name = 'age' AND attr_value > '30';   -- returns 1 and 2: '9' > '30' is true in text order
```

Threefold cost: **type loss** (age, money, and dates all become text, so comparisons and aggregates all rely on casts, and a failed cast errors the whole query); **nowhere to put constraints** ("this attribute is required" and "value restricted to an enum" cannot be expressed at row level); **hard queries and statistics** (building a complete profile of one entity needs an N-row pivot, and report SQL complexity explodes). The fix: honestly build columns for core business fields; use a JSONB column plus expression indexes for the genuinely dynamic handful of extension attributes. For the normalization-level discussion, see [Normalization and Denormalization](./normalization-and-denormalization).

## The Catch-All JSONB Table

The modern variant of EAV — cramming the whole table into a single JSONB column:

```sql
CREATE TABLE data (
  id   bigint PRIMARY KEY,
  body jsonb NOT NULL          -- orders, users, config, and logs all go in this one column
);
```

Symptoms: without a schema there are no constraints, so a misspelled key name silently lands in the database; queries all rely on expressions like `body->>'status'`, and ordinary indexes are out of the question; large JSON is managed by TOAST, so updating a single field rewrites the entire package. The fix: model key entities with relational tables, keeping JSONB only for genuinely semi-structured parts (third-party receipts, config with uncertain structure); promote frequently queried keys to expression indexes or generated columns. For practical patterns see [JSONB Design Patterns](../advanced-sql/jsonb-design-patterns) and [JSONB Operations](../advanced-sql/jsonb-operations).

## Unbounded Self-Reference

A self-referencing foreign key is not itself a problem (nested comment threads, org trees); the problem is that **there is no constraint on depth at all**:

```sql
CREATE TABLE comments (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id bigint REFERENCES comments (id),
  body      text
);

WITH RECURSIVE t AS (
  SELECT id, parent_id, 1 AS depth FROM comments WHERE id = 1
  UNION ALL
  SELECT c.id, c.parent_id, t.depth + 1
  FROM comments c JOIN t ON c.parent_id = t.id
)
SELECT * FROM t;
```

When the data contains a cycle (a descendant of A points back at A) or a path runs too deep, this recursion either runs forever or produces an enormous number of rows, and one interface query takes down the whole database. The fix: cap the hierarchy in the business model and enforce it with a CHECK or application validation; set an upper bound on `depth` in the recursive query, use `UNION` (rather than `UNION ALL`) so deduplication terminates cyclic data, and from PG 14 the `CYCLE` clause can handle it explicitly — see [Recursive CTE](../advanced-sql/recursive-cte).

## Foreign Key With No Index, Parent Table Deleted Frequently

```sql
CREATE TABLE orders (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint REFERENCES users (id)     -- no index on orders(user_id)
);

DELETE FROM users WHERE id = 42;
```

When deleting one parent row, PostgreSQL must confirm no dangling references remain in the child table; with no index on `orders(user_id)`, that check is a sequential scan. The more frequently the parent is deleted and the larger the child table, the slower the delete gets, and row locks pile up on the child table. The fix is fixed: **always index the child table's foreign-key column**, and it belongs in the table-creation standard — for the selection rationale see [Composite Index Design](../indexing/composite-index-design).

## Storing Local Time in timestamp without time zone

Minimal reproduction:

```sql
SET timezone = 'Asia/Shanghai';
SELECT '2026-03-01 12:00:00'::timestamp;    -- 12:00 (12:00 in which timezone?)
SET timezone = 'America/New_York';
INSERT INTO events (at) SELECT '2026-03-01 12:00:00';   -- another 12:00, 12 hours apart
```

Two writers produce mutually contradictory values, and on a DST switchover day "nonexistent instants" appear. The fix: always use `timestamptz` for the absolute instant with conversion at the presentation layer — for the traps and solutions see [Modeling Time](./time-modeling).

## Storing Money in a Character Type

```sql
SELECT '9'::text > '10'::text;    -- true, a lexicographic comparison
```

A database with `amount text` will sooner or later contain formats like `'1,299.00'`, `'$99'`, and whitespace-padded `' 12 '`: sorting by lexicographic order is completely broken, aggregation needs `::numeric` first and errors out on any format mismatch, and precision conventions are impossible. The fix: `numeric(12,2)` or bigint storing the smallest unit — for the tradeoff and rounding rules see [Money and Numeric](./money-and-numeric).

## Using PostgreSQL as a Queue

Implementing a message queue with a job table and polling; [`FOR UPDATE SKIP LOCKED`](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE) since PG 9.5 lets multiple workers grab jobs without blocking each other:

```sql
SELECT id, payload FROM jobs
WHERE status = 'pending'
ORDER BY created_at
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

The verdict in one line: **it is fine to use this way for a small job table**, but treating it as a production-grade message queue runs into these problems one after another — polling consumes connections, message-visibility timeouts must be built yourself, dead-letter and retry logic must be written yourself, and tombstone rows of completed jobs need periodic cleanup. Switch to a dedicated queue when volume is large or reliability requirements are high; for batch writing and cleanup of the job table see [Batch Writes](../advanced-sql/batch-and-write).

## NULL in a Unique Constraint

```sql
CREATE TABLE accounts (
  email      text NOT NULL,
  deleted_at timestamptz,
  UNIQUE (email, deleted_at)       -- trying to prevent duplicate registration
);

INSERT INTO accounts (email) VALUES ('a@example.com');
INSERT INTO accounts (email) VALUES ('a@example.com');   -- both succeed
```

NULLs are not equal to each other inside a unique constraint, so a composite unique with a nullable column is effectively toothless; soft-delete tables will almost certainly hit this (live rows with `deleted_at` NULL can repeat without limit). The fix: a partial unique index `WHERE deleted_at IS NULL`, or `UNIQUE NULLS NOT DISTINCT` from PG 15 — for a comparison of the two approaches' side effects see [Soft Delete and Tombstones](./soft-delete-and-tombstone).

## References

- [PostgreSQL Documentation · SELECT](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)
- [PostgreSQL Documentation · 5.5. Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Normalization and Denormalization](./normalization-and-denormalization)
- [Soft Delete and Tombstones](./soft-delete-and-tombstone)
- [Money and Numeric](./money-and-numeric)
- [JSONB Design Patterns](../advanced-sql/jsonb-design-patterns)
- [generated-columns-and-check](/advanced-sql/generated-columns-and-check.md)
- [jsonb-design-patterns](/advanced-sql/jsonb-design-patterns.md)
- [index](index.md)
- [money-and-numeric](money-and-numeric.md)
- [soft-delete-and-tombstone](soft-delete-and-tombstone.md)
