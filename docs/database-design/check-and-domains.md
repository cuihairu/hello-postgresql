# CHECK Constraints and Domains

A CHECK constraint states that only rows "satisfying a boolean condition" may be written to the table; a domain type (DOMAIN) packages a type, a set of CHECKs, and a default value into a reusable custom type. Here I organize the three common CHECK patterns, the NOT VALID add-then-validate workflow, constraint naming conventions and the split-vs-combine tradeoff, and finally how to reuse rules with DOMAIN.

## Three Common CHECK Patterns

```sql
CREATE TABLE products (
    product_id int PRIMARY KEY,
    name       text NOT NULL,
    price      numeric(10,2) NOT NULL,
    status     text NOT NULL,
    sku        text NOT NULL
);

-- 1) Range: price must be positive
ALTER TABLE products ADD CONSTRAINT products_price_positive
    CHECK (price > 0);

-- 2) Enumerated values: status restricted to a fixed set
ALTER TABLE products ADD CONSTRAINT products_status_valid
    CHECK (status IN ('active', 'draft', 'archived'));

-- 3) Regex: SKU allows only uppercase letters, digits, and hyphens
ALTER TABLE products ADD CONSTRAINT products_sku_format
    CHECK (sku ~ '^[A-Z0-9-]+$');

INSERT INTO products VALUES (1, 'Laptop', 4999.00, 'active', 'NB-2026');
INSERT INTO products VALUES (2, 'Mouse', -10, 'active', 'MS-01');
-- ERROR: new row for relation "products" violates
-- check constraint "products_price_positive"

INSERT INTO products VALUES (3, 'Keyboard', 299.00, 'on_sale', 'KB-1');
-- ERROR: new row for relation "products" violates
-- check constraint "products_status_valid"
```

Besides CHECK, a fixed status set can also use the `CREATE TYPE … AS ENUM` enum type, which errors more explicitly and sorts in declaration order. The tradeoff is evolution cost: adding an enum value requires `ALTER TYPE … ADD VALUE` (transactional since PG 12, but the new value cannot be used until commit), while changing a CHECK's set only needs the constraint dropped and recreated — a lower bar; when business statuses will keep expanding, CHECK is less hassle.

## NOT VALID: Add First, Validate Later

Adding a CHECK constraint on a large table scans the whole table while holding locks that throttle writes. The standard approach is two steps: first attach the constraint with `NOT VALID` (it governs only new writes and never touches historical rows), then validate the stock data during an off-peak window:

```sql
CREATE TABLE orders (
    order_id int PRIMARY KEY,
    amount   numeric(10,2) NOT NULL,
    status   text NOT NULL DEFAULT 'pending'
);

-- Step 1: attach quickly, skipping historical rows (CHECK's NOT VALID is supported since PG 9.2)
ALTER TABLE orders ADD CONSTRAINT orders_amount_positive
    CHECK (amount > 0) NOT VALID;

-- Step 2: validate stock data in the background; takes only a shared lock
-- during validation, without blocking reads or writes
ALTER TABLE orders VALIDATE CONSTRAINT orders_amount_positive;

-- Constraint state can be confirmed from the system catalog
SELECT conname, convalidated
FROM pg_constraint
WHERE conrelid = 'orders'::regclass;
```

Two cautions: while `NOT VALID` is in effect, new writes are still validated row by row but historical rows are unconstrained, so illegal old data can exist in the table until VALIDATE finishes; if the stock data really is dirty, `VALIDATE CONSTRAINT` errors out rather than fixing anything — clean it first. Foreign keys also support `NOT VALID` (earlier than CHECK), with identical usage.

## Constraint Naming Conventions

Constraint names appear in every error message, so disciplined naming makes diagnosis much faster. A common convention is `table_column_rule`, for example `orders_amount_positive`:

```sql
-- Counterexample: unnamed, PG auto-generates orders_amount_check, which is still readable,
-- but with several constraints you get orders_check1, orders_check2 — meaningless
ALTER TABLE orders ADD CHECK (amount > 0);

-- Good example: once named, errors point straight at the problem
ALTER TABLE orders ADD CONSTRAINT orders_amount_positive CHECK (amount > 0);
-- ERROR: new row for relation "orders" violates
-- check constraint "orders_amount_positive"
```

To unify this with object naming across the whole database, see [Naming and Style Conventions](../basics/naming-and-style-conventions).

## Multi-Condition Constraint vs. Splitting

Whether to put several conditions in one CHECK or split them into several constraints comes down to debugging precision and later evolution:

```sql
-- Combined: one validation, but the error only says "orders_valid failed",
-- and you must read the constraint definition to tell amount from status
ALTER TABLE orders ADD CONSTRAINT orders_valid
    CHECK (amount > 0 AND status <> 'cancelled');

-- Split: errors name the exact condition, and each constraint can later be
-- dropped or rewritten individually
ALTER TABLE orders ADD CONSTRAINT orders_amount_positive CHECK (amount > 0);
ALTER TABLE orders ADD CONSTRAINT orders_status_open CHECK (status <> 'cancelled');
```

Rule of thumb: split when conditions are independent — error messages get sharper, and each can get its own `NOT VALID` or be dropped alone; combine when the conditions form one integral rule (such as `start_ts < end_ts`, or array length coupled with element range).

## DOMAIN: Packaging CHECKs for Reuse

Encapsulate "base type + a set of CHECKs + default value" as a domain type, and every table reuses the same set of rules:

```sql
CREATE DOMAIN positive_int AS integer
    CHECK (VALUE > 0);

CREATE DOMAIN email AS text
    CHECK (VALUE ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

CREATE TABLE products_v2 (
    product_id  int PRIMARY KEY,
    stock       positive_int NOT NULL DEFAULT 0,
    owner_email email
);

INSERT INTO products_v2 VALUES (1, 5, 'ops@example.com');

INSERT INTO products_v2 VALUES (2, -1, 'ops@example.com');
-- ERROR: value for domain positive_int violates check constraint "positive_int_check"

INSERT INTO products_v2 VALUES (3, 5, 'not-an-email');
-- ERROR: value for domain email violates check constraint "email_check"
```

Usage notes:

- Domain types evolve less nimbly than table constraints: adding a CHECK uses `ALTER DOMAIN … ADD CONSTRAINT`, changing an existing rule requires `DROP CONSTRAINT` first and then re-adding, and changing the definition rescans every column using the domain.
- Domains suit values "reused in many places with stable rules" (emails, phone numbers, positive integers); a rule used in only one place is lighter as a plain CHECK.
- Domains also support `NOT VALID` followed by validation, same as table constraints.

For full syntax, see the official documentation on [CREATE DOMAIN](https://www.postgresql.org/docs/current/sql-createdomain.html) and [DDL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html).

## References

- [PostgreSQL Documentation · CREATE DOMAIN](https://www.postgresql.org/docs/current/sql-createdomain.html)
- [PostgreSQL Documentation · 5.5. Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Foreign Keys and Referential Actions](./foreign-keys-and-referential-actions)
- [Constraints and Data Quality](./constraints-and-data-quality)
- [Generated Columns and CHECK](../advanced-sql/generated-columns-and-check)
- [Naming and Style Conventions](../basics/naming-and-style-conventions)
- [generated-columns-and-check](/advanced-sql/generated-columns-and-check.md)
- [jsonb-design-patterns](/advanced-sql/jsonb-design-patterns.md)
- [range-types-and-exclude](/advanced-sql/range-types-and-exclude.md)
- [constraints-and-data-quality](constraints-and-data-quality.md)
- [foreign-keys-and-referential-actions](foreign-keys-and-referential-actions.md)
- [index](index.md)
- [normalization-and-denormalization](normalization-and-denormalization.md)
