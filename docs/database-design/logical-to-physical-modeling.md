# From Logical Model to Physical Table

Logical modeling answers "what entities exist and what are the relationships between them"; physical implementation answers "what DDL expresses these relationships, and which defaults and constraints go on the columns". Doing this step sloppily means migration scripts, ORM mappings, and data quality keep paying debt afterwards. This page gives the table-building pattern for each of the three E-R relationship types, then covers the conventions that land in practice — primary-key generation, timestamp columns, soft-delete fields, and schema/search_path — before tying it all together with a complete order-database script.

## Table Patterns for the Three Relationships

An E-R relationship lands in table structure in only three ways:

- **1:N (one-to-many)**: put the foreign-key column on the "many" side. `orders.user_id` references `users.id`; do not store an `order_ids` array in the `users` table.
- **1:1 (one-to-one)**: add UNIQUE to the foreign-key column, or make the child table's primary key also be the foreign key — a primary key is unique by nature, so you get the constraint for free.
- **N:N (many-to-many)**: build a join table where the two foreign keys form a **composite primary key**, eliminating duplicate associations at the database level.

```sql
-- 1:N: the foreign key lives on the "many" side
CREATE TABLE users (
  id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE orders (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users (id)
);

-- 1:1: the primary key is the foreign key, guaranteeing a one-to-one match with users
CREATE TABLE user_auth (
  user_id       bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  password_hash text NOT NULL
);

-- N:N: join table + composite primary key
CREATE TABLE articles (
  id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL
);

CREATE TABLE tags (
  id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE article_tags (
  article_id bigint NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  tag_id     bigint NOT NULL REFERENCES tags (id)     ON DELETE CASCADE,
  PRIMARY KEY (article_id, tag_id)   -- an article can never be tagged the same way twice
);
```

If the join table carries business attributes (tagging time, operating user), you can switch to `id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY` plus `UNIQUE (article_id, tag_id)` — the constraint effect is equivalent. A composite primary key is itself a query index, so "find tags by article" needs no separate index; for the principle behind column order in composite keys, see [Composite Index Design](../indexing/composite-index-design).

## Primary Key Generation: identity and DEFAULT

For a surrogate primary key, use `bigint GENERATED ALWAYS AS IDENTITY` (PG 10+); it is more standard than the old `serial`: ownership of the sequence relative to the column is clearer in the catalog, and in `ALWAYS` mode an explicit id insert from the application is rejected, preventing duplicated values from bypassing the sequence (use `OVERRIDING SYSTEM VALUE` when you truly need to insert one). For syntax see the official [CREATE TABLE](https://www.postgresql.org/docs/current/sql-createtable.html) documentation; for type selection (bigint / UUIDv7) and its impact on cursor pagination, see [Primary Key Design](./primary-key-design).

The `DEFAULT` clause is responsible for "supply a value when none is passed": the primary key comes from identity, timestamps from `DEFAULT now()`, and state from `DEFAULT 'pending'`. The principle is to **leave defaults to the database**, so that writes through psql, scripts, the ORM, or manual data fixes down any path never produce a "forgot to fill this in" NULL.

## Timestamp Column Conventions

```sql
created_at timestamptz NOT NULL DEFAULT now(),
updated_at timestamptz NOT NULL DEFAULT now()
```

- Both columns use `timestamptz NOT NULL DEFAULT now()`; for the timezone principle see [Modeling Time](./time-modeling).
- `created_at` is never changed after its single write; `updated_at` needs to be **refreshed automatically on every UPDATE**, with two maintenance options:
  - **Trigger** (recommended): the contrib extension `moddatetime` handles it in one line and covers every write path:

    ```sql
    CREATE EXTENSION IF NOT EXISTS moddatetime;
    CREATE TRIGGER users_set_updated_at
      BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION moddatetime (updated_at);
    ```

  - **ORM layer**: SQLAlchemy's `onupdate` or Rails' `touch` also work, provided every write goes through the ORM; raw SQL, stored procedures, and manual data fixes will all miss it.

## Soft-Delete Field Conventions

The uniform pattern for logical deletion is a single column `deleted_at timestamptz` (NULL means alive); do not use `is_deleted boolean` — a boolean throws away the deletion time, so neither auditing nor periodic cleanup has anything to go on. Soft delete also ripples into unique indexes, foreign keys, and statistical baselines; for the complete solution see [Soft Delete and Tombstones](./soft-delete-and-tombstone).

## Naming and search_path in the Database

Put business objects in an **explicit schema** (such as `sales` or `billing`) rather than piling everything into `public`. Two things get settled at creation time:

```sql
CREATE SCHEMA IF NOT EXISTS sales;

-- Pin search_path per role rather than relying on a manual SET in every session
CREATE ROLE app_rw LOGIN PASSWORD '...';
ALTER ROLE app_rw IN DATABASE shop SET search_path = sales, public;
```

- **Write fully qualified names** in migration scripts (`sales.orders`), to avoid the deployment tool's differing connection parameters creating objects in the wrong schema.
- `pg_catalog` always comes first in the resolution chain, so it does not need to be in `search_path`.
- Naming itself (snake_case, the `_id` suffix on foreign-key columns, constraint naming patterns) follows one written convention; see [Naming and Style Conventions](../basics/naming-and-style-conventions).

## Complete Example: an Order-Database Creation Script

```sql
BEGIN;

CREATE SCHEMA IF NOT EXISTS sales;

CREATE TABLE sales.users (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       text        NOT NULL,
  nickname    text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CONSTRAINT users_email_key UNIQUE (email)   -- after soft delete switch to a partial unique index; see the soft-delete page
);

CREATE TABLE sales.products (
  id          bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title       text          NOT NULL,
  price_cny   numeric(10,2) NOT NULL CHECK (price_cny >= 0),
  stock       int           NOT NULL DEFAULT 0 CHECK (stock >= 0),
  created_at  timestamptz   NOT NULL DEFAULT now(),
  updated_at  timestamptz   NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE TABLE sales.orders (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint        NOT NULL,
  status     text          NOT NULL DEFAULT 'pending',
  total_cny  numeric(12,2) NOT NULL DEFAULT 0 CHECK (total_cny >= 0),
  created_at timestamptz   NOT NULL DEFAULT now(),
  updated_at timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT orders_user_id_fkey  FOREIGN KEY (user_id) REFERENCES sales.users (id),
  CONSTRAINT orders_status_check
    CHECK (status IN ('pending', 'paid', 'shipped', 'done', 'cancelled'))
);

-- A typical N:N artifact: orders and products linked through a join table, carrying snapshot fields
CREATE TABLE sales.order_items (
  order_id   bigint        NOT NULL,
  product_id bigint        NOT NULL,
  qty        int           NOT NULL CHECK (qty > 0),
  unit_price numeric(10,2) NOT NULL,          -- snapshot of the transacted price; it does not drift when the product is repriced
  PRIMARY KEY (order_id, product_id),
  CONSTRAINT order_items_order_fk
    FOREIGN KEY (order_id)   REFERENCES sales.orders (id)   ON DELETE CASCADE,
  CONSTRAINT order_items_product_fk
    FOREIGN KEY (product_id) REFERENCES sales.products (id)
);

CREATE INDEX orders_user_id_created_at_idx ON sales.orders (user_id, created_at DESC);
CREATE INDEX order_items_product_id_idx    ON sales.order_items (product_id);

-- Automatic maintenance of updated_at
CREATE EXTENSION IF NOT EXISTS moddatetime;
CREATE TRIGGER users_set_updated_at    BEFORE UPDATE ON sales.users
  FOR EACH ROW EXECUTE FUNCTION moddatetime (updated_at);
CREATE TRIGGER products_set_updated_at BEFORE UPDATE ON sales.products
  FOR EACH ROW EXECUTE FUNCTION moddatetime (updated_at);
CREATE TRIGGER orders_set_updated_at   BEFORE UPDATE ON sales.orders
  FOR EACH ROW EXECUTE FUNCTION moddatetime (updated_at);

COMMIT;
```

The script can be executed in one piece directly in psql. Three entities plus a join table, covering every convention above: identity primary key, paired timestamptz timestamps, soft-delete field, foreign key + CHECK, composite primary key join table, and indexes on foreign-key columns.

## Caveats and Common Pitfalls

- **Think about the ON DELETE action before writing it**: the default `NO ACTION` (reject deletion if referenced), `CASCADE` (cascade delete), `SET NULL` (null it out). Join tables and accessory tables commonly use CASCADE; use it cautiously on primary business tables — see [Foreign Keys and Referential Actions](./foreign-keys-and-referential-actions).
- **Realign sequences after manual data loads**: after inserting ids explicitly and bypassing identity, use `setval` to advance the sequence past the maximum, or later inserts will hit unique violations; `pg_dump`/`pg_restore` handles this automatically.
- **`CREATE TABLE ... LIKE` does not copy foreign keys**: `INCLUDING ALL` copies defaults, CHECKs, and indexes, but foreign-key references are never copied — patch them by hand after cloning.
- **1:1 table splitting has a cost**: reads always take one extra JOIN, so it is only worth it for low-frequency large fields (such as terms-of-service text); keep high-frequency small fields in the main table.
- **Do not skip the composite primary key on a join table**: relying on the application to deduplicate only guarantees duplicate rows sooner or later.

## References

- [PostgreSQL Documentation · CREATE TABLE](https://www.postgresql.org/docs/current/sql-createtable.html)
- [PostgreSQL Documentation · 5.5. Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Primary Key Design](./primary-key-design)
- [Modeling Time](./time-modeling)
- [Soft Delete and Tombstones](./soft-delete-and-tombstone)
- [Naming and Style Conventions](../basics/naming-and-style-conventions)
- [index](index.md)
- [multi-tenant-modeling](multi-tenant-modeling.md)
- [normalization-and-denormalization](normalization-and-denormalization.md)
- [soft-delete-and-tombstone](soft-delete-and-tombstone.md)
- [toast](/internals/toast.md)
