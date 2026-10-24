# JSONB Design Patterns

jsonb is only a storage format in itself; whether you get value from it depends on modeling discipline: which fields go into relational columns, which go into jsonb, who guarantees structural correctness, and how you fill in indexes. This page records a battle-tested hybrid modeling pattern, plus the criteria for judging "when to use it and when not to."

## The Document Column Pattern: Relational Columns + Extended Attributes

The most common shape: put stable fields that participate in queries and constraints in relational columns, and put the varying, optional fields that are only ever read or written whole with the row into a single jsonb column:

```sql
CREATE TABLE orders (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     bigint NOT NULL,
    status      text NOT NULL,
    total_cents bigint NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    attributes  jsonb NOT NULL DEFAULT '{}'::jsonb
);

INSERT INTO orders (user_id, status, total_cents, attributes) VALUES
    (101, 'paid',    19900, '{"channel": "app", "coupon": {"code": "NEW10", "off_cents": 1000}}'),
    (102, 'pending',  8800, '{"channel": "web"}'),
    (103, 'paid',    45000, '{"channel": "web", "gift_wrap": true}');
```

The one-sentence dividing line: **Will this field end up in a WHERE, JOIN, GROUP BY, foreign key, or CHECK? If yes, put it in a relational column; only presentational data that is merely read and written along with the row belongs in jsonb.** In the example above, `status` and `total_cents` clearly need to participate in filtering and aggregation, while low-frequency, structurally variable attributes like `coupon` belong in jsonb.

## Pulling Hot Fields Back Out with Generated Columns

Once a jsonb field starts participating frequently in filtering or sorting, pull it out as a generated column (STORED is supported from PG 12). That keeps the flexibility on the write side while recovering a relational column's indexes and statistics:

```sql
CREATE TABLE products (
    id    int PRIMARY KEY,
    name  text NOT NULL,
    attrs jsonb NOT NULL DEFAULT '{}'::jsonb,
    color text GENERATED ALWAYS AS (attrs ->> 'color') STORED
);

CREATE INDEX products_color_idx ON products (color);

-- Ordinary equality query, using the B-tree index
SELECT * FROM products WHERE color = 'black';
```

Essentials:

- A generated column cannot be written manually; inserts and updates only manage `attrs`, and `color` follows automatically.
- The generated column expression must be IMMUTABLE, so `attrs ->> 'color'` works (the operator itself is immutable), but `now()` and subqueries do not.
- The single-argument form of `to_tsvector` is stable, so inside a generated column it must be written as the two-argument, configuration-carrying form.
- You can build indexes on generated columns, they can participate in query paths referenced by foreign keys, and their statistics are ANALYZEd normally.

For more generated column usage, see [Generated Columns and CHECK Constraints](./generated-columns-and-check).

## Covering jsonb Conditions with Partial Indexes

Some jsonb conditions only matter for rows in a specific state, and a partial index can keep the index size minimal:

```sql
-- Index only the creation time of orders that carry a coupon, serving "find recent couponed orders"
CREATE INDEX orders_with_coupon
    ON orders (created_at)
    WHERE attributes ? 'coupon';

-- Index only the channel of pending orders
CREATE INDEX orders_pending_channel
    ON orders (user_id, (attributes ->> 'channel'))
    WHERE status = 'pending';
```

A query's predicate must match the index's predicate (or be derivably contained in it) for the index to be chosen; for example, `WHERE status = 'pending' AND attributes ->> 'channel' = 'app'` hits the second index. For details on the syntax, see [Partial (local) indexes](../indexing/partial-indexes).

## Validating jsonb Structure in the Database

jsonb accepts anything by default, so the first line of defense is a CHECK constraint that pins down the top-level shape:

```sql
-- At minimum, guarantee it is an object, preventing arrays and scalars from slipping in
ALTER TABLE orders
    ADD CONSTRAINT attributes_is_object
    CHECK (jsonb_typeof(attributes) = 'object');

-- Validate the shape of a sub-structure you care about: if coupon exists, it must be an object with a code key
ALTER TABLE orders
    ADD CONSTRAINT coupon_shape
    CHECK (attributes -> 'coupon' IS NULL
           OR (jsonb_typeof(attributes -> 'coupon') = 'object'
               AND attributes -> 'coupon' ? 'code'));
```

For more complete schema validation you can use a community extension (such as pg_jsonschema, which implements JSON Schema validation) to validate the whole document before writing, but for most business cases a handful of CHECKs pinning the types and existence of key fields is enough. For the full validation approach, see [CHECK and Domains](../database-design/check-and-domains).

## When to Go Pure Document, and When to Go Hybrid

- **Pure document**: the whole row is a document — configuration archives, snapshots of external system messages, log payloads. The table has only a primary key plus jsonb (maybe also a timestamp), performs no relational queries, and does not split fields.
- **Hybrid modeling**: the great majority of business tables. Stable fields as relational columns, variable/optional fields in jsonb, hot fields pulled back out as generated columns.
- Order of judgment: first ask "will it be filtered, JOINed, or constrained," then ask "will the structure change," and finally ask "how often is it updated." When all three lean toward "no," jsonb is the answer.

## Avoiding the "Swiss Army Knife JSONB Table"

The anti-pattern looks like this: a table with only `id` and `data` columns, with every business entity stuffed into `data`. The consequences are systemic:

- No foreign keys can be added and no CHECKs can be applied to inner fields, so data quality rests entirely on application-layer self-discipline.
- The optimizer cannot see statistics inside jsonb, row count estimates are off, and plans are unstable.
- Every query has to dig fields out of jsonb, with `->>` and casts everywhere, and the indexes swell along with it.
- The table schema loses its documentation value, and new teammates can only reverse-engineer the schema by reading code.

The correct role of jsonb is to complement the relational model, not replace it; for more traps like this, see [The Anti-Pattern List](../database-design/anti-patterns).

## Caveats and Common Traps

- Burying fields that are filtered or JOINed frequently inside jsonb and then bolting on a pile of expression indexes is worse than just putting them in relational columns from the start.
- Pulling fields out as generated columns slows writes (every update must recompute them), so do it only for genuinely "hot" fields — not for every field in the table.
- Literals in a partial index's predicate must exactly match those in the query (`'pending'` vs `"pending"` in spelling and type), or the planner will not recognize it.
- A CHECK validates "at the moment of writing"; historical data is not governed by a newly added constraint (adding a constraint validates the whole table by default; add NOT VALID to proceed in stages).
- Frequent small updates to a large jsonb column repeatedly rewrite the TOAST value; in update-heavy scenarios consider moving hot fields out.

## References

- [PostgreSQL official documentation · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL official documentation · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [JSONB Operations](./jsonb-operations)
- [Generated Columns and CHECK Constraints](./generated-columns-and-check)
- [The Anti-Pattern List](../database-design/anti-patterns)
- [GIN indexes](../indexing/gin)
- [index](index.md)
- [jsonb-operations](jsonb-operations.md)
- [anti-patterns](/database-design/anti-patterns.md)
- [knowledge](/knowledge.md)
Official documentation: [Generated columns](https://www.postgresql.org/docs/current/ddl-generated-columns.html), [JSON types](https://www.postgresql.org/docs/current/datatype-json.html).
