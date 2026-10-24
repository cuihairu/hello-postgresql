# Foreign Keys and Referential Actions

A foreign key enforces referential integrity between two tables: values in the child table (the referencing side) must exist in the parent table (the referenced side). When a parent row is deleted or updated, how the matching child rows are handled is decided by the `ON DELETE` / `ON UPDATE` referential action. This page records the five actions, deferred constraints, the index gap foreign keys leave, and two traps with hierarchical deletes and soft deletes.

## Referential Actions at a Glance

```sql
CREATE TABLE customers (
    customer_id int PRIMARY KEY,
    name        text NOT NULL,
    email       text NOT NULL UNIQUE,
    deleted_at  timestamptz
);

CREATE TABLE orders (
    order_id    int PRIMARY KEY,
    customer_id int REFERENCES customers(customer_id)
        ON DELETE SET NULL      -- deleting the customer orphans the order instead of erroring
        ON UPDATE CASCADE       -- if the customer's key changes, the order follows
);
```

The five referential actions (`ON DELETE` / `ON UPDATE` share them):

| Action | Behavior |
|---|---|
| `CASCADE` | When the parent row is deleted/updated, matching child rows are deleted/updated too |
| `SET NULL` | The child's foreign-key column is set to NULL |
| `SET DEFAULT` | The child's foreign-key column is restored to the default declared at table creation |
| `RESTRICT` | If child rows exist, the parent delete/update is rejected immediately |
| `NO ACTION` | Also rejects, but the check timing can be deferred to transaction end (the default) |

Two details:

- To use `SET NULL` / `SET DEFAULT`, the foreign-key column must be nullable (or have a default), otherwise deleting the parent row immediately violates the NOT NULL constraint.
- `RESTRICT` and `NO ACTION` both mean "cannot delete if child rows exist" — the difference is timing: `RESTRICT` checks immediately and cannot be deferred; `NO ACTION` also checks at statement end by default, but after the constraint is declared `DEFERRABLE` the check can be pushed back to commit.

## DEFERRABLE INITIALLY DEFERRED

During bulk imports and circular-dependency cases, the insert order can be temporarily "illegal": the child row arrives first and the parent row is still behind it. Declaring the foreign key deferrable pushes validation to transaction commit, where it is checked all at once:

```sql
CREATE TABLE users (
    user_id int PRIMARY KEY,
    email   text NOT NULL UNIQUE
);

CREATE TABLE shipments (
    shipment_id int PRIMARY KEY,
    user_id     int NOT NULL REFERENCES users(user_id)
        DEFERRABLE INITIALLY DEFERRED
);

BEGIN;
-- users has no 42 yet, but validation is deferred
INSERT INTO shipments VALUES (9001, 42);
INSERT INTO users VALUES (42, 'alice@example.com');
COMMIT;   -- validated once at commit; succeeds if everything is legal
```

You can also defer temporarily within a session without changing the table — but it only works for constraints declared `DEFERRABLE`:

```sql
BEGIN;
SET CONSTRAINTS ALL DEFERRED;
-- out-of-order writes ...
COMMIT;
```

Note: `CHECK` constraints and `NOT NULL` do not support deferral; what is deferrable is foreign keys, unique constraints, and exclusion constraints. Changing foreign keys to `INITIALLY DEFERRED` by default is a deliberate architecture choice that moves where errors surface from "statement execution" to "transaction commit" — when debugging, get used to looking at the COMMIT.

## Referencing Columns Are Usually Missing an Index

A foreign key only requires a unique index on the referenced column (the parent table); **no index is created automatically on the child table's referencing column**. Two consequences:

- When deleting or updating a parent row, PG must find matching rows in the child table — without an index that is a sequential scan;
- Queries like `WHERE customer_id = ?` in your application also have no index to use.

```sql
-- Add the referencing-column index manually
CREATE INDEX idx_orders_customer_id ON orders (customer_id);
```

"Index the foreign-key column" therefore becomes a general rule of thumb, unless the child table is tiny, or you are certain the parent is never deleted or updated and you never query by the referencing column.

## Hierarchical Deletes and Orphan Rows

A self-referencing foreign key (org charts, comment trees) can delete an entire tree with `CASCADE`; without an action (the default `NO ACTION`), deleting a parent row is blocked by its children and you must work level by level:

```sql
CREATE TABLE staff (
    staff_id   int PRIMARY KEY,
    name       text NOT NULL,
    manager_id int REFERENCES staff(staff_id)   -- default NO ACTION
);

INSERT INTO staff VALUES (1, 'Boss Zhang', NULL), (2, 'Xiao Li', 1), (3, 'Xiao Wang', 2);

DELETE FROM staff WHERE staff_id = 1;
-- ERROR: update or delete on table "staff" violates foreign key
-- constraint "staff_manager_id_fkey" on table "staff"

-- Delete bottom-up manually, or reassign the subordinate first
DELETE FROM staff WHERE staff_id = 3;
DELETE FROM staff WHERE staff_id = 2;
DELETE FROM staff WHERE staff_id = 1;
```

Two risks are worth remembering: `CASCADE` amplifies the delete scope on a deep tree, so deleting one node may empty an entire subtree — confirm before going live that this is the semantics you want. And a circular dependency where A references B and B references A usually means the model should be split with an intermediate table; where it is truly needed, use `DEFERRABLE INITIALLY DEFERRED` to complete the bidirectional insert in one transaction.

Orphan rows (child rows with no match in the parent) do not appear on the normal foreign-key path — they only come from historical data loaded with `NOT VALID` to skip validation, or from writing after disabling triggers in the session (`ALTER TABLE … DISABLE TRIGGER ALL`). When you suspect orphans, use `LEFT JOIN ... WHERE parent.key IS NULL` to hunt them down.

## Soft Deletes and Foreign Keys Are Incompatible

Soft delete (setting `deleted_at` to the current time instead of physically deleting) has a fundamental conflict with foreign keys: **a foreign key requires the referenced row to exist, but a soft-deleted row is already "gone" for business purposes**.

```sql
-- Physically cleaning up a soft-deleted customer is blocked by orders
DELETE FROM customers WHERE customer_id = 42;
-- ERROR: update or delete on table "customers" violates foreign key
-- constraint "orders_customer_id_fkey" on table "customers"
```

Two common bind spots: to clean up soft-deleted users you must first handle every order they own (or drop the reference); and if a user soft-deletes and then re-registers with the same email, `UNIQUE (email)` errors. The second is solved with a partial unique index that guarantees uniqueness only for "not deleted" rows:

```sql
CREATE UNIQUE INDEX customers_email_active
    ON customers (email) WHERE deleted_at IS NULL;
```

For the complete soft-delete design (tombstones, unique indexes, query filtering), see [Soft Delete and Tombstones](./soft-delete-and-tombstone).

For an overview of the constraint system, see the official documentation on [DDL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html).

## References

- [PostgreSQL Documentation · 5.5. Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
- [PostgreSQL Documentation · 5.12. Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Primary Key Design](./primary-key-design)
- [Soft Delete and Tombstones](./soft-delete-and-tombstone)
- [Constraints and Data Quality](./constraints-and-data-quality)
- [CHECK Constraints and Domains](./check-and-domains)
- [recursive-cte](/advanced-sql/recursive-cte.md)
- [join-family](/basics/join-family.md)
- [check-and-domains](check-and-domains.md)
- [constraints-and-data-quality](constraints-and-data-quality.md)
- [index](index.md)
- [logical-to-physical-modeling](logical-to-physical-modeling.md)
- [normalization-and-denormalization](normalization-and-denormalization.md)
- [primary-key-design](primary-key-design.md)
