# Soft Delete and Tombstones

Soft delete means not running `DELETE` at all; instead you write a deletion marker (usually a `deleted_at` timestamp), and rows carrying that marker are called tombstones. The motivation is recoverable from accidental deletion, auditable data, and unbroken foreign-key history — but the cost is that every query must carry a filter, unique constraints hit a NULL trap, and the table keeps bloating. This page gives the standard soft-delete pattern and how it interacts with foreign keys, cascades, and cleanup strategy.

## The deleted_at Pattern

```sql
CREATE TABLE accounts (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email      text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz              -- NULL means alive
);

-- Soft delete
UPDATE accounts SET deleted_at = now() WHERE id = 42;

-- Query active data
SELECT * FROM accounts WHERE deleted_at IS NULL;
```

The reason to use `timestamptz` rather than `is_deleted boolean`: the deletion time supports audit accountability, cleanup by retention period, and the judgment of "restore to a certain point in time" after an accidental delete. For field conventions (alongside `created_at`/`updated_at`) see [From Logical Model to Physical Table](./logical-to-physical-modeling).

## The NULL Trap in Unique Constraints

The most common thing to trip over after soft delete is the unique constraint. Suppose the requirement is "only one live record per email"; the intuitive way to write it:

```sql
CREATE TABLE accounts (
  email      text NOT NULL,
  deleted_at timestamptz,
  UNIQUE (email, deleted_at)      -- idea: composite uniqueness
);

INSERT INTO accounts (email) VALUES ('a@example.com');
INSERT INTO accounts (email) VALUES ('a@example.com');   -- it actually succeeded!
```

The second row was not rejected. The reason: inside a unique constraint, **NULL is not equal to any value, including another NULL** (the official documentation's [unique constraints](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-UNIQUE-CONSTRAINTS) section explains this), so `('a@example.com', NULL)` and `('a@example.com', NULL)` are treated as distinct composite values and live rows can repeat without limit. Two fixes:

```sql
-- Fix 1 (recommended): a partial unique index constraining only live rows
CREATE UNIQUE INDEX accounts_email_live_uidx
  ON accounts (email) WHERE deleted_at IS NULL;

-- Fix 2 (PG 15+): NULLS NOT DISTINCT treats NULLs as equal
ALTER TABLE accounts ADD CONSTRAINT accounts_email_del_key
  UNIQUE NULLS NOT DISTINCT (email, deleted_at);
```

Prefer fix 1. Fix 2 has a side effect: it treats NULLs as equal in **every column combination**, so two tombstone rows with the same `email` and an identical `deleted_at` timestamp will also collide — which can be collateral damage when batch soft-deleting (same `now()` value within one transaction) recently merged duplicate accounts. For more partial-index usage, see [Partial Indexes](../indexing/partial-indexes).

## Every Query Needs a Filter

Soft delete introduces an implicit rule: **business queries always carry `deleted_at IS NULL`**, and missing it once is an incident. A few ways to lower the odds of an omission:

- Configure a default scope in the ORM (SQLAlchemy's `query.filter` wrapper, Django's default manager) so default queries filter automatically.
- Use a view to give statistics and reports a fixed definition:

  ```sql
  CREATE VIEW accounts_live AS
  SELECT * FROM accounts WHERE deleted_at IS NULL;
  ```

- `count(*)`, export scripts without a filter, and cross-database sync tools will all count tombstones; the documented statistic must state which view defines the baseline.

## Bloat and Periodic Cleanup

Tombstone rows are not reclaimed by autovacuum — they are live rows, merely filtered out. Over time: the table and indexes grow, sequential scans slow down, and autovacuum has more dead tuples to maintain (for the background mechanism see [VACUUM and HOT](../internals/vacuum-and-hot)). You must have an archive strategy:

```sql
-- Move expired tombstones into an archive table, then delete them
-- (the archive table can be partitioned monthly or exported to object storage)
CREATE TABLE accounts_tombstones (LIKE accounts INCLUDING ALL);

WITH moved AS (
  DELETE FROM accounts
  WHERE deleted_at < now() - interval '180 days'
  RETURNING *
)
INSERT INTO accounts_tombstones SELECT * FROM moved;
```

For large-scale deletes, avoid deleting millions of rows in one statement — long transactions, locks, and WAL pressure all cause problems. Use `LIMIT` and loop in batches; for the batch-write approach see [Batch Writes](../advanced-sql/batch-and-write).

## Compatibility with Foreign Keys, Cascades, and Auditing

- **Foreign keys still hold**: a soft-deleted parent row still exists for the database, so child tables can keep inserting foreign keys that point at it. If the business rule is "a deleted user can no longer place orders", the database cannot help with that — it needs an application-layer or trigger check.
- **No cascade happens**: `ON DELETE CASCADE` only applies to a real `DELETE`. Soft-deleting a parent does not cascade-soft-delete the children; where cascading is needed, either the application issues explicit per-table `UPDATE`s or a trigger fills the gap.
- **Soft-deleted resources still occupy their slot**: a partial unique index solves "uniqueness among live rows", but if the business requires an email to be reclaimable by a new user after release, you need to allow "a tombstone and a new row to coexist" — which is exactly what a partial unique index indexing only live rows achieves.
- **From an audit perspective**: soft delete is essentially an UPDATE, so a normal audit trigger records it; but be aware that a tombstone can be "restored" (set `deleted_at` back to NULL), so scenarios with high immutability requirements need auditing and permission controls alongside it.

## Hard Delete or Soft Delete

- **When compliance demands true deletion, soft delete is the same as not deleting**: for account closure or the right to delete personal data, you must hard delete or fully anonymize (and clear the tombstone too), otherwise the data is still in the database.
- **Do not use soft delete as a backup**: the correct answer for recovery from accidental deletion is backup with point-in-time recovery (PITR) — see [Backup Strategy](../operations/backup-strategy).
- **A common compromise**: soft delete plus a limited retention period (such as 30/90 days) plus archive-and-hard-delete on expiry, balancing accidental-delete recovery against compliance.

## References

- [PostgreSQL Documentation · 5.5. Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
- [PostgreSQL Documentation · 5.12. Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [From Logical Model to Physical Table](./logical-to-physical-modeling)
- [Design Anti-Patterns](./anti-patterns)
- [Partial Indexes](../indexing/partial-indexes)
- [VACUUM and HOT](../internals/vacuum-and-hot)
- [common-beginner-mistakes](/basics/common-beginner-mistakes.md)
- [anti-patterns](anti-patterns.md)
- [foreign-keys-and-referential-actions](foreign-keys-and-referential-actions.md)
- [index](index.md)
- [logical-to-physical-modeling](logical-to-physical-modeling.md)
- [primary-key-design](primary-key-design.md)
- [partial-indexes](/indexing/partial-indexes.md)
