# Data Types Overview

PostgreSQL's type system is what sets it apart from many databases: the built-in types cover numbers, characters, time, boolean, binary, UUID, network addresses and more, and users can define their own types. This page walks through the types most often needed for business tables, plus the trade-off between `serial` and `GENERATED ... AS IDENTITY`. For the full specification of each type see the official [Data Types](https://www.postgresql.org/docs/current/datatype.html) chapter; for JSONB, arrays, ranges and other signature types see [A Tour of Special Types](./special-types-intro).

## Numeric types

| Type | Storage | Range / precision | Typical use |
| --- | --- | --- | --- |
| `smallint` | 2 bytes | -32768 to 32767 | status codes, enum-like values |
| `integer` / `int` | 4 bytes | about ±2.1 billion | general integer counters |
| `bigint` | 8 bytes | about ±9.2×10^18 | large-table primary keys, distributed IDs |
| `numeric(p,s)` | variable | exact to any precision | money, rates, anything needing exact math |
| `real` | 4 bytes | 6 decimal digits | scientific computing, approximations |
| `double precision` | 8 bytes | 15 decimal digits | approximations, statistics |

```sql
CREATE TABLE num_demo (
    qty      integer      NOT NULL,
    price    numeric(10,2) NOT NULL,   -- exactly two decimal places
    ratio    double precision,
    CONSTRAINT qty_positive CHECK (qty > 0)
);

INSERT INTO num_demo VALUES (3, 19.99, 0.375);

-- note that floating-point types do not compare exactly
SELECT 0.1::double precision + 0.2::double precision = 0.3;  -- f
SELECT 0.1::numeric(10,1) + 0.2::numeric(10,1) = 0.3;        -- t
```

Two selection rules:

- **Use `numeric` for money, exchange rates, inventory and any column that needs exact decimals**. `float`/`double` use IEEE 754 binary floating point, where `0.1 + 0.2 != 0.3` — reconciliation is guaranteed to break. `numeric` arithmetic is slower, but correctness comes first.
- **Use `bigint` for primary and foreign keys**. `int`'s 2.1-billion ceiling is not far away on ledger or log tables, and changing the column type later rewrites the whole table. More detail on modeling money is in [Money and Numerics](../database-design/money-and-numeric).

## Character types

```sql
CREATE TABLE char_demo (
    code3   char(3),        -- fixed length, padded with spaces
    name    varchar(64),    -- variable length, errors beyond 64 characters
    bio     text            -- variable length, unlimited
);
```

- `char(n)` is fixed length: shorter values are padded with spaces on insert, and trailing spaces are also ignored on comparison — the semantics are easy to trip over; skip it unless you are interfacing with a fixed-width protocol;
- `varchar(n)` is variable length where n is an upper bound on **characters**, not bytes;
- `text` is variable length with no limit; in PG, `varchar` and `text` use exactly the same underlying storage, with no performance difference.

**Prefer `text`, and when you need a limit, add `CHECK (char_length(bio) <= 500)`**. The benefit is that changing the restriction later only touches the CHECK constraint (or removes it), instead of rewriting the whole column the way `varchar(64)` to `varchar(128)` does. This behavior differs from MySQL: there `varchar` and `text` have clearly different row storage and indexing behavior, so do not carry the old habit over after moving to PG.

## Time types

| Type | Description |
| --- | --- |
| `date` | date only (year, month, day) |
| `time [without time zone]` | time of day |
| `time with time zone` | time of day with a time-zone offset, rarely used |
| `timestamp` | timestamp without time zone |
| `timestamptz` | timestamp with time zone |
| `interval` | a length of time, e.g. `3 days 02:30:00` |

```sql
CREATE TABLE time_demo (
    happened_at  timestamptz NOT NULL DEFAULT now(),
    birthday     date,
    duration     interval
);

INSERT INTO time_demo (birthday, duration) VALUES ('1995-06-01', '90 minutes');

SELECT happened_at AT TIME ZONE 'Asia/Shanghai' FROM time_demo;  -- local time for a time zone
SELECT now() + interval '7 days';                                -- time arithmetic
```

The key point about how `timestamptz` works: **values are converted to UTC for storage** and rendered per the session's `TimeZone` setting at display time. So "which time zone is stored in the column" never gets muddled — only the display changes. For scenarios that store a user's local time and do not care about time zones (such as birthdays), `date` or `timestamp` is the better fit. A full discussion of time modeling is in [Time Modeling](../database-design/time-modeling).

## Boolean, UUID, and binary

```sql
CREATE TABLE misc_demo (
    is_active   boolean NOT NULL DEFAULT true,
    external_id uuid    NOT NULL DEFAULT gen_random_uuid(),
    payload     bytea
);

INSERT INTO misc_demo (payload) VALUES (decode('48656c6c6f', 'hex'));

SELECT is_active FROM misc_demo;                    -- t / f
SELECT external_id FROM misc_demo;                  -- e0a1b2c3-...
SELECT octet_length(payload) FROM misc_demo;        -- 5
```

- `boolean` takes three states, `true` / `false` / `NULL`, and output usually displays as `t` / `f`;
- `uuid` stores a UUID in 16 bytes, smaller than storing the UUID as `text`, and directly comparable; since PG 13, `gen_random_uuid()` is built in (the old `pgcrypto`-based recipe is no longer needed);
- `bytea` stores arbitrary binary (images, encrypted blocks); large objects go through the TOAST mechanism, see [TOAST and Large Fields](../internals/toast).

## serial versus GENERATED ... AS IDENTITY

There are two ways to write an auto-increment primary key:

```sql
-- the old way: serial is a pseudo-type that creates and attaches a sequence behind the scenes
CREATE TABLE orders_old (
    id serial PRIMARY KEY,
    note text
);

-- the recommended way: standard SQL syntax since PG 10
CREATE TABLE orders (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    note text
);

INSERT INTO orders (note) VALUES ('a') RETURNING id;
--  id
-- ----
--   1
```

The problem with `serial`: it is only sugar — it actually creates a standalone sequence object, and the dependency between the column and the sequence is recorded loosely. `pg_dump` can lose the default-value association in complex scenarios, and changing owners or moving tables easily leaves the sequence behind or drops it. `GENERATED ... AS IDENTITY` is standard SQL syntax (since PG 10, see the identity clause of [CREATE TABLE](https://www.postgresql.org/docs/current/sql-createtable.html)) and manages the sequence as an attachment of the column:

- `GENERATED ALWAYS AS IDENTITY`: refuses manual id inserts by default; to override explicitly you must write `OVERRIDING SYSTEM VALUE`, which keeps applications from inserting arbitrary primary keys;
- `GENERATED BY DEFAULT AS IDENTITY`: behaves close to `serial`, allowing manually supplied values;
- `ALTER TABLE orders ALTER COLUMN id RESTART WITH 1000;` resets the counter directly, with no need to touch the sequence object.

There is no rush to migrate `serial` columns in existing tables, but new tables should standardize on the identity form. For a deeper comparison of primary key choices (identity vs UUID) see [Primary Key Design](../database-design/primary-key-design).

## Type aliases

PG keeps a set of SQL-standard and historical aliases, so do not be surprised to see names like `int4` or `varchar` in `pg_catalog`:

| What you write | Real name in the system | Note |
| --- | --- | --- |
| `int` / `integer` | `int4` | the internal number 4 means 4 bytes |
| `bigint` | `int8` | 8 bytes |
| `smallint` | `int2` | 2 bytes |
| `real` | `float4` | 4-byte float |
| `double precision` | `float8` | 8-byte float |
| `varchar(n)` | `character varying(n)` | same type |
| `timestamptz` | `timestamp with time zone` | same type |

Aliases only affect how you write things, not storage or behavior; when you query the system catalogs (`pg_attribute`, `\d table`), what you see are the real names.

## Gotchas and common pitfalls

- **`numeric` has no precision ceiling, but do not abuse it**: heavy `numeric` math is slower than integer math; use the integer family for counters and auto-increment ids;
- **Mixing `timestamp` with `timestamptz`** muddles cross-time-zone data; standardizing business tables on `timestamptz` is the easier default;
- **The space-padding behavior of `char(n)`** makes comparisons like `WHERE code3 = 'AB'` "look equal", which easily hides dirty data;
- **The `money` type is not recommended**: locale settings affect its output and its division behaves oddly; `numeric` is more predictable;
- **Changing a column type may lock and rewrite the table**: `int` to `bigint` rewrites the whole table in PG (`ALTER TYPE ... USING`), so plan a maintenance window for large tables, see [The Lock System](../internals/lock-system).

## References

- [PostgreSQL official documentation · Chapter 8. Data Types](https://www.postgresql.org/docs/current/datatype.html)
- [PostgreSQL official documentation · CREATE TABLE](https://www.postgresql.org/docs/current/sql-createtable.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [A Tour of Special Types](./special-types-intro)
- [Databases and Schema Objects](./database-and-schema-objects)
- [Primary Key Design](../database-design/primary-key-design)
- [Money and Numerics](../database-design/money-and-numeric)
- [common-beginner-mistakes](common-beginner-mistakes.md)
- [database-and-schema-objects](database-and-schema-objects.md)
- [functions-and-operators](functions-and-operators.md)
- [index](index.md)
- [special-types-intro](special-types-intro.md)
- [money-and-numeric](/database-design/money-and-numeric.md)
- [time-modeling](/database-design/time-modeling.md)
- [comparison-with-mysql](/ecosystem/comparison-with-mysql.md)
