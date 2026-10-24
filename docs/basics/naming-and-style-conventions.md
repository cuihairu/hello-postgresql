# Naming and Style Conventions

The point of naming conventions is not aesthetics but **avoiding clashes with PostgreSQL's identifier resolution rules**. PostgreSQL folds unquoted identifiers to lowercase, and that rule is why a table created with "CamelCase + double quotes" later errors out when you write its bare name. This page records that folding rule and its traps, then lists naming conventions for tables, columns, constraints, and indexes plus one consistent SQL writing style, so the schemas and migration scripts your team produces stay maintainable long term.

## Unquoted identifiers fold to lowercase

The SQL standard says unquoted identifiers are normalized by implementation; PostgreSQL's implementation is **to fold everything to lowercase**. That means:

```sql
CREATE TABLE Orders (Id int, UserName text);   -- actually creates orders / id / username
SELECT Id FROM Orders WHERE UserName = 'a';    -- equivalent to SELECT id FROM orders WHERE username = 'a'
```

Whether you write `Orders`, `ORDERS`, or `orders`, what lands in the catalogs is `orders`. The rule applies to **identifiers** (table names, column names, index names, aliases) and not to **string literals** — the `'ABC'` in `WHERE name = 'ABC'` keeps its case as-is. This differs from MySQL: on Linux MySQL table names are case-sensitive by default, on Windows they are not, so cross-platform behavior is inconsistent; PostgreSQL behaves the same on every platform (folds to lowercase). For details see the official [Identifiers and keywords](https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS).

## The trap of quoted, case-preserved identifiers

A quoted identifier is **kept literally, byte for byte**, with no folding. This is a common trap:

```sql
CREATE TABLE "Users" ("Id" int, "Name" text);   -- that is Users / Id / Name in the catalogs

SELECT id FROM users;          -- ERROR: relation "users" does not exist
SELECT * FROM Users;           -- ERROR: relation "users" does not exist (still folded to lowercase)
SELECT * FROM "Users";         -- OK, quotes required everywhere
SELECT "Id" FROM "Users";      -- OK, the column name needs quotes too
```

The consequence is **quote debt**: once you create `"Users"` with quotes, every ORM, migration script, `psql` command, and log lookup has to carry the quotes exactly, and missing one anywhere yields `does not exist`. ORMs (such as SQLAlchemy or Hibernate) that detect a case mismatch add quotes automatically to the SQL they generate, amplifying the confusion further. There is only one conclusion: **identifiers are always lowercase snake_case, and never use double quotes**. For how to repair an existing mess see [Common Beginner Mistakes](./common-beginner-mistakes).

## snake_case and table singular/plural

- **All-lowercase snake_case**: `order_items`, `user_profiles`. Avoid `PascalCase` (it folds), avoid Chinese/special characters, avoid SQL reserved words (`user`, `order`, `group`, `check` are all reserved and need quotes when used as table names). To express "the users table" use `users` or `app_user`, not the bare `user`.
- **Singular vs plural tables**: either mainstream style works; what matters is that the team is consistent. **Plural** (`users`, `orders`) is recommended, because SQL reads naturally (`FROM users` means "take from the set of users") and it matches the default convention of frameworks such as Rails and Django. A singular style (`user_account`) makes ORM class-name mapping easier. Once you pick one, write it into the migration standard.
- **Avoid ambiguous abbreviations**: `usr` and `ord` are less clear than `users` and `orders`; pick one of `create_time` and `created_at` — the latter is preferred (clearer tense semantics, see [Time Modeling](../database-design/time-modeling)).

## Primary and foreign key column naming

- **Call the primary key `id`**: uncontroversial for a single surrogate column. Use `bigint GENERATED ALWAYS AS IDENTITY` (since PG 10, replacing `serial`) or UUIDv7; for the type choice see [Primary Key Design](../database-design/primary-key-design). Composite primary key columns are named by business meaning.
- **Foreign key column = singular form of the referenced table + `_id`**: `orders.user_id` references `users.id`, and `order_items.order_id` references `orders.id`. That way the column name alone hints at the JOIN condition, and tools that generate JOINs have something concrete to go on.
- **Keep names corresponding**: `products.id` corresponds to `orders.product_id`; do not call one side `prod_id` and the other `pid`.

```sql
CREATE TABLE users (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email      text NOT NULL UNIQUE
);

CREATE TABLE orders (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users (id),   -- FK column = singular table name + _id
  created_at timestamptz NOT NULL DEFAULT now()
);
```

## Explicitly naming indexes and constraints

PostgreSQL generates default names for unnamed constraints and indexes, such as `orders_user_id_fkey`, `orders_pkey`, `orders_user_id_idx`. Default names work, but there are two problems: default names for multi-column indexes or composite constraints are long and messy (such as `orders_user_id_created_at_idx`) and hard to type when renaming or dropping, and across environments the default name may differ because of the order in which tables were created. Prefer **explicit names** following a fixed pattern:

| Object | Pattern | Example |
| --- | --- | --- |
| Primary key constraint | `<table>_pkey` | `orders_pkey` |
| Unique constraint | `<table>_<column>_key` | `orders_order_no_key` |
| Foreign key constraint | `<table>_<column>_fkey` | `orders_user_id_fkey` |
| CHECK constraint | `<table>_<column>_check` or `<table>_<meaning>_check` | `orders_amount_positive_check` |
| Plain index | `<table>_<column...>_idx` | `orders_user_id_created_at_idx` |
| Unique index | `<table>_<column...>_uidx` | `orders_order_no_uidx` |
| Exclusion constraint | `<table>_<meaning>_excl` | `rooms_no_overlap_excl` |

```sql
CREATE TABLE order_items (
  id        bigint GENERATED ALWAYS AS IDENTITY,
  order_id  bigint    NOT NULL,
  sku       text      NOT NULL,
  qty       int       NOT NULL CHECK (qty > 0),
  CONSTRAINT order_items_pkey PRIMARY KEY (id),
  CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT order_items_sku_unique UNIQUE (order_id, sku)
);

CREATE INDEX order_items_order_id_idx ON order_items (order_id);
```

Another benefit of explicit names: ops scripts using `DROP CONSTRAINT` or `ALTER INDEX RENAME` can hard-code the name instead of querying the catalogs first and concatenating.

## SQL writing style

Style does not affect execution, but **a consistent style makes code review, migration-script diffs, and slow-query log comparisons all easier**. Recommended conventions:

- **Keywords all uppercase or all lowercase**, no mixing. `SELECT ... FROM ... WHERE` and `select ... from ... where` are both fine; the team picks one (examples on this site use uppercase keywords).
- **Function names lowercase**: `count(*)`, `now()`, so they are not visually tangled with uppercase keywords like `COUNT(*)`.
- **Put JOIN and filter clauses on separate lines**, with the `ON` condition on the same line as the `JOIN`, and one predicate per line in `WHERE` starting with `AND`, which makes diffs easier.

```sql
SELECT u.id,
       u.email,
       count(o.id)            AS order_cnt,
       max(o.created_at)      AS last_order_at
FROM   users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE  u.email IS NOT NULL
  AND  u.created_at >= '2026-01-01'
GROUP  BY u.id, u.email
HAVING count(o.id) >= 3
ORDER  BY order_cnt DESC
LIMIT  50;
```

- **Leading or trailing commas, pick one consistently**: this example uses trailing commas (`u.email,`), so commenting out the last line does not produce a syntax error.
- **Aliases short but readable**: `u`, `o`, `oi` for `users`, `orders`, `order_items`; avoid `t1`, `tmp`.
- **Do not put `SELECT *` in production code**: a column change can break any code depending on that result set, and it also loses the chance to use an index-only scan (see [Index-Only Scans](../indexing/index-only-scans)).
- **Be explicit about schema**: write full `public.users` for cross-schema objects instead of relying on implicit `search_path` resolution.

## Gotchas and common pitfalls

- **Reserved-word blacklist**: `user`, `order`, `group`, `check`, `primary`, `references` are all reserved. Before creating a new table or column, run `SELECT * FROM pg_get_keywords() WHERE catcode = 'R';` to check.
- **Double underscores and leading/trailing underscores**: the `pg_` prefix is reserved for system objects; do not start custom objects with `pg_`, to avoid colliding with `pg_catalog`.
- **Quote debt is hard to repay**: once you notice a quoted `"Users"` table, the correct cleanup is create a lowercase table → copy the data → rename. `ALTER TABLE "Users" RENAME TO users;` does work, but every view, foreign key, and piece of code depending on `"Users"` still needs to be traced and updated.
- **Constraint names are unique at the schema level**: two tables in the same schema cannot share a CHECK constraint name, so always include the table prefix when naming explicitly.
- **Style tooling**: `pg_format` (from the `sql_formatter` ecosystem, used alongside `psql`) or sqlfluff can unify indentation and casing automatically, handing style enforcement to the tool instead of to review.

## References

- [PostgreSQL official documentation · Part I. Tutorial](https://www.postgresql.org/docs/current/tutorial.html)
- [PostgreSQL official documentation · The SQL Language](https://www.postgresql.org/docs/current/sql.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Common Beginner Mistakes](./common-beginner-mistakes)
- [Databases and Schema Objects](./database-and-schema-objects)
- [Primary Key Design](../database-design/primary-key-design)
- [System Catalogs and Metadata](./system-catalogs-and-metadata)
- [common-beginner-mistakes](common-beginner-mistakes.md)
- [index](index.md)
- [check-and-domains](/database-design/check-and-domains.md)
- [logical-to-physical-modeling](/database-design/logical-to-physical-modeling.md)
- [normalization-and-denormalization](/database-design/normalization-and-denormalization.md)
