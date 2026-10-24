# Constraints and Data Quality

The layered defense lines for data quality, from innermost to outermost, are: NOT NULL → primary key/unique → foreign key → CHECK/EXCLUDE → triggers as a backstop. The principle is to **prefer declarative constraints**: they apply to every write path — psql, scripts, the ORM, manual data fixes — while application-layer validation is only advisory. Here I organize the migration path for adding NOT NULL to large tables, EXCLUDE constraints for preventing time-slot overlaps, the division of labor between CHECK and triggers, deferred validation, and how constraints affect write performance and query pruning.

## NOT NULL Strategy

On a small table, just add it in one statement (no table rewrite since PG 11):

```sql
ALTER TABLE orders ALTER COLUMN remark SET NOT NULL;
```

On a large table, adding it directly triggers a full-table scan for validation with a long-held lock. Since PG 12, `SET NOT NULL` can reuse the conclusion of an existing `CHECK (col IS NOT NULL)` constraint to skip the scan; the standard migration path is four steps:

```sql
-- 1) Add the CHECK as NOT VALID first: takes effect immediately for new writes,
--    existing data is not validated yet
ALTER TABLE orders
  ADD CONSTRAINT orders_remark_nn CHECK (remark IS NOT NULL) NOT VALID;

-- 2) Validate the stock data during an off-peak window, scanning only once
ALTER TABLE orders VALIDATE CONSTRAINT orders_remark_nn;

-- 3) SET NOT NULL reuses the CHECK conclusion and no longer scans
ALTER TABLE orders ALTER COLUMN remark SET NOT NULL;

-- 4) Clean up the temporary constraint
ALTER TABLE orders DROP CONSTRAINT orders_remark_nn;
```

After step one, every new write is intercepted, so data quality is already under control during the intermediate window. Adding a `DEFAULT` to a column is also metadata-only since PG 11 (fast default), with no table rewrite.

## The NOT VALID + VALIDATE Migration Path

`NOT VALID` + `VALIDATE CONSTRAINT` is the general pattern for adding constraints to existing tables, applicable to CHECK and foreign keys:

```sql
ALTER TABLE order_items ADD CONSTRAINT order_items_order_fk
  FOREIGN KEY (order_id) REFERENCES orders (id) NOT VALID;

ALTER TABLE order_items VALIDATE CONSTRAINT order_items_order_fk;
```

- `ADD CONSTRAINT ... NOT VALID` needs only a brief metadata lock and finishes in seconds; from then on new writes are constrained.
- `VALIDATE CONSTRAINT` scans the existing rows but holds only a `SHARE UPDATE EXCLUSIVE` lock, so it **does not block concurrent reads or writes** (CHECK has used this lock level since PG 9.4 and foreign keys since PG 12); it only queues against some DDL and autovacuum.
- If the stock data really does contain dirty rows, clean the data before VALIDATE; otherwise validation fails and the constraint is left in a "partially effective" state.

For the lock levels and limits of each clause, see the official [ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html) and [Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html) documentation.

## EXCLUDE Constraints: A Declarative Weapon Against Overlaps

A unique constraint can only prevent "equality"; an EXCLUDE constraint can prevent "any conflict defined by a GiST operator class", the most typical being **the same room cannot be double-booked for the same time slot**:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- makes GiST support text/numeric equality

CREATE TABLE room_bookings (
  id      bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_no text          NOT NULL,
  during  tstzrange     NOT NULL,
  CONSTRAINT room_bookings_no_overlap
    EXCLUDE USING gist (room_no WITH =, during WITH &&)
);

INSERT INTO room_bookings (room_no, during)
VALUES ('301', tstzrange('2026-03-01 14:00+08', '2026-03-01 16:00+08'));   -- OK

INSERT INTO room_bookings (room_no, during)
VALUES ('301', tstzrange('2026-03-01 15:00+08', '2026-03-01 17:00+08'));
-- ERROR: conflicting key value violates exclusion constraint "room_bookings_no_overlap"
```

The meaning of `room_no WITH =, during WITH &&`: two rows conflict as soon as the rooms are equal **and** the time slots overlap. Internally it is a GiST index, so this constraint can also serve as a query index (for example `WHERE room_no = '301' AND during && ...`). For the boundary convention of range types see [Modeling Time](./time-modeling), and for operator details see [Range Types and EXCLUDE](../advanced-sql/range-types-and-exclude).

## The Division of Labor between CHECK and Triggers

| | CHECK / EXCLUDE | Triggers |
| --- | --- | --- |
| Validation scope | The current row; EXCLUDE prevents cross-row conflicts via an index | Anything: can query other tables and other rows |
| Deferrable | No | Constraint triggers can be DEFERRED |
| Maintenance cost | Declarative and done | Requires writing functions, testing, and preventing recursion |
| Fits | Ranges, formats, invariants | Cross-table invariants, auditing, cascade actions |

The principle: **use declarative where you can; reserve triggers for cross-table invariants**. For example "an account balance must not go negative" is decidable on a single row, so use CHECK; "the balance must equal the sum of transactions" requires a cross-table lookup, which is what a trigger or a reconciliation job is for. Two limits: CHECK expressions cannot contain subqueries; and do not call non-`IMMUTABLE` functions (such as `now()`) inside a CHECK — the optimizer and migration tools assume the result for a given row is constant. For regex and domain-type reuse patterns, see [CHECK Constraints and Domains](./check-and-domains).

## Deferred Validation

By default constraints validate per statement; after declaring `DEFERRABLE` they can be pushed to a single check at transaction commit, solving writes where "an intermediate state necessarily conflicts":

```sql
CREATE TABLE steps (
  id  int PRIMARY KEY,
  pos int NOT NULL,
  CONSTRAINT steps_pos_key UNIQUE (pos) DEFERRABLE INITIALLY DEFERRED
);

BEGIN;
UPDATE steps SET pos = 2 WHERE id = 1;   -- conflicts with id=2's pos=2 right now, but it is allowed
UPDATE steps SET pos = 3 WHERE id = 2;
COMMIT;                                   -- validated once at commit; the swap succeeds
```

- Constraints that can be declared `DEFERRABLE`: UNIQUE, primary key, foreign key; **CHECK cannot be deferred**.
- Foreign keys commonly use `DEFERRABLE INITIALLY DEFERRED` to solve the "insert the child table before the parent" ordering problem in bulk imports.
- Inside a transaction, `SET CONSTRAINTS ... IMMEDIATE` can pull validation forward to just after a given statement, avoiding bad data surfacing only at commit.
- For the related foreign-key referential actions (CASCADE/SET NULL), see [Foreign Keys and Referential Actions](./foreign-keys-and-referential-actions).

## How Constraints Affect Performance

- **Write amplification**: every unique/EXCLUDE constraint is an index that must be maintained; every foreign key adds one parent-table lookup to each child-table write. The common approach for bulk imports is to drop the constraints, load the data, then re-add with `NOT VALID + VALIDATE` — usually faster than validating row by row with the constraints in place.
- **EXCLUDE has a higher index cost than a btree unique index**: GiST has worse query performance and cache friendliness than btree, so use it only on tables that genuinely need "no overlap/no conflict" semantics.
- **Constraints take part in query pruning**: CHECK constraints on inherited tables, combined with `constraint_exclusion = on`, let the optimizer skip unrelated child tables; the corresponding mechanism for partitioned tables is partition pruning — see [Partition Pruning](../performance/partition-pruning).
- **VALIDATE queues with autovacuum**: VALIDATE on a large table is a long-transaction-shaped scan, so schedule it during off-peak hours to avoid mutual waiting with autovacuum — for background see [autovacuum Tuning](../internals/autovacuum-tuning).

## References

- [PostgreSQL Documentation · ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html)
- [PostgreSQL Documentation · 5.5. Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [CHECK Constraints and Domains](./check-and-domains)
- [Foreign Keys and Referential Actions](./foreign-keys-and-referential-actions)
- [Range Types and EXCLUDE](../advanced-sql/range-types-and-exclude)
- [Partition Pruning](../performance/partition-pruning)
- [generated-columns-and-check](/advanced-sql/generated-columns-and-check.md)
- [check-and-domains](check-and-domains.md)
- [foreign-keys-and-referential-actions](foreign-keys-and-referential-actions.md)
- [index](index.md)
- [money-and-numeric](money-and-numeric.md)
- [time-modeling](time-modeling.md)
- [gist](/indexing/gist.md)
