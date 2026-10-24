# A Tour of Special Types

Beyond the basics like numbers, strings, and dates, PostgreSQL also ships with a set of "structured" types: JSONB, arrays, ranges, enums, and composite types. They let you push many modeling problems that used to require splitting tables, gluing delimiter-separated strings, or handling in application code directly into the database — with type checking and indexing support. This page records the type overview; the concrete usage of each type is in the related SQL pages.

## JSONB: binary JSON

`jsonb` parses JSON and stores it in binary form, and supports indexes plus a rich set of operators. The corresponding `json` type only keeps the raw text, parses it on every access, and cannot be indexed, so in practice you almost always use `jsonb`. `jsonb` does not preserve key order, drops duplicate keys and stray whitespace, and compares by semantics rather than by text.

The commonly used extraction operators:

- `->`: fetch by key, returns `jsonb` (keeps the JSON type).
- `->>`: fetch by key and cast to `text`, so it can be compared and printed directly.
- `@>`: containment, whether the left side contains the JSON fragment on the right — the operator most often paired with a GIN index.

```sql
CREATE TABLE products (
    id    bigserial PRIMARY KEY,
    name  text NOT NULL,
    attrs jsonb NOT NULL DEFAULT '{}'
);

INSERT INTO products (name, attrs) VALUES
    ('Keyboard', '{"color": "Black", "switch": "Red", "tags": ["Wireless", "Backlit"]}'),
    ('Mouse', '{"color": "White", "dpi": 16000}');

-- extract fields: -> returns jsonb, ->> returns text
SELECT name,
       attrs -> 'color'    AS color_jsonb,
       attrs ->> 'color'   AS color_text,
       (attrs ->> 'dpi')::int AS dpi
FROM products;

-- containment query: find red-switch keyboards
SELECT name FROM products WHERE attrs @> '{"switch": "Red"}';
```

You can add a GIN index on a column to speed up `@>`, `?` and similar queries: `CREATE INDEX ON products USING gin (attrs);`. Details are in [JSONB Operations](../advanced-sql/jsonb-operations).

## Arrays

PostgreSQL natively supports arrays of any basic type, such as `text[]` or `int[]`. Array subscripts start at 1; use `ANY` for "equals any of these elements" and `@>` for "contains all of these elements".

```sql
CREATE TABLE articles (
    id    bigserial PRIMARY KEY,
    title text NOT NULL,
    tags  text[] NOT NULL DEFAULT '{}'
);

INSERT INTO articles (title, tags) VALUES
    ('PG Getting Started', ARRAY['Basics', 'Getting Started']),
    ('PG Tuning', '{Performance, Configuration}');

-- does it contain a given element
SELECT title FROM articles WHERE 'Basics' = ANY (tags);

-- array contains another set of elements, value by subscript, length
SELECT title FROM articles WHERE tags @> ARRAY['Basics'];
SELECT tags[1], cardinality(tags) FROM articles;
```

The two literal forms are equivalent; the `ARRAY[...]` constructor is more explicit about the type and is the one to prefer.

## Range types

Range types store "a span of values" as a single value: the built-ins are `int4range`, `int8range`, `numrange`, `tsrange`, `tstzrange`, `daterange`. The default bounds are "left-closed, right-open", `[)`. Common operators: `@>` contains, `&&` overlaps, `-|-` adjacent.

```sql
SELECT int4range(1, 10) @> 5 AS contains_five;   -- t
SELECT daterange('2026-01-01', '2026-02-01') @> '2026-01-15'::date;  -- t

CREATE TABLE room_bookings (
    id      bigserial PRIMARY KEY,
    room_no text NOT NULL,
    period  tsrange NOT NULL
);

INSERT INTO room_bookings (room_no, period) VALUES
    ('301', tsrange('2026-10-12 09:00', '2026-10-12 11:00'));

-- find bookings overlapping a target period
SELECT room_no FROM room_bookings
WHERE period && tsrange('2026-10-12 10:00', '2026-10-12 12:00');
```

Paired with an `EXCLUDE USING` exclusion constraint you can forbid "overlapping periods in the same room" directly at the database level; details in [Range Types and Exclusion Constraints](../advanced-sql/range-types-and-exclude).

## Enum types

`CREATE TYPE ... AS ENUM` defines an ordered set of fixed values, well suited to stable fields like status or category. Enum values sort by declaration order, not lexicographically.

```sql
CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'closed');

CREATE TABLE orders (
    id     bigserial PRIMARY KEY,
    status order_status NOT NULL DEFAULT 'pending'
);

INSERT INTO orders (status) VALUES ('paid');
SELECT * FROM orders WHERE status = 'paid' ORDER BY status;
```

To add a value use `ALTER TYPE order_status ADD VALUE 'refunded' AFTER 'closed';` (since PG 12 this may run inside a transaction block, provided the new value is not used within that same transaction). Enums cannot drop an existing value directly — you have to rebuild the type — so model a set as an enum only when you are sure it will stay stable.

## A look at composite types

A composite type bundles several fields into a single value, often used as a function return type or to express a small structure like an address.

```sql
CREATE TYPE address AS (
    city   text,
    street text
);

CREATE TABLE customers (
    id   bigserial PRIMARY KEY,
    name text NOT NULL,
    addr address
);

INSERT INTO customers (name, addr) VALUES ('John Smith', ROW('Shanghai', '100 Nanjing West Road'));

-- accessing a field needs parentheses: (addr).city
SELECT name, (addr).city FROM customers;
```

## A word on hstore

`hstore` is an early key-value type that requires `CREATE EXTENSION hstore;` to enable. Once `jsonb` matured, there is basically no reason for a new project to choose hstore; knowing about it is enough.

## Where to use them, and don't overuse them

| Type | Good for | Bad for |
| --- | --- | --- |
| JSONB | uncertain-structure external data, configuration, third-party callback payloads | core business entities (orders, accounts, etc.), which should have real columns, constraints, and foreign keys |
| Arrays | a set of homogeneous short tags, multi-valued attributes | situations needing frequent per-element updates, or where elements must be foreign-key referenced (split into a child table) |
| Ranges | time periods, interval-based billing, validity windows | a single point in time — plain `timestamptz` is enough there |
| Enums | classifications with almost fixed values | frequently changing state machines; consider a `text` column with a CHECK constraint or a lookup table |
| Composite types | function return structures, transient bundling | fields that need to be queried or indexed independently (make them plain columns) |

Two general reminders:

1. The more "free-form" a type is, the fewer checks the database can do. Inside JSONB there is no NOT NULL, no foreign keys, and no accurate statistics; putting master data there shifts data-quality problems into the application layer.
2. Large JSONB and array values go through the TOAST mechanism as out-of-row storage, adding overhead when the whole row is updated frequently, see [TOAST and Out-of-Row Storage](../internals/toast).

## References

- [PostgreSQL official documentation · Part I. Tutorial](https://www.postgresql.org/docs/current/tutorial.html)
- [PostgreSQL official documentation · The SQL Language](https://www.postgresql.org/docs/current/sql.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Data Types Overview](./data-types-overview)
- [JSONB Operations](../advanced-sql/jsonb-operations)
- [Array Operations](../advanced-sql/array-operations)
- [Range Types and Exclusion Constraints](../advanced-sql/range-types-and-exclude)
- [data-types-overview](data-types-overview.md)
- [index](index.md)
- [what-is-postgresql](what-is-postgresql.md)
Official documentation: [JSON types](https://www.postgresql.org/docs/current/datatype-json.html), [Arrays](https://www.postgresql.org/docs/current/arrays.html), [Range types](https://www.postgresql.org/docs/current/rangetypes.html), [Enums](https://www.postgresql.org/docs/current/datatype-enum.html).
