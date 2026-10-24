# Expression Indexes

An expression index (also called a functional index) does not index the column itself but the computed result of an expression on it: `CREATE INDEX ... ON t ((lower(email)))` sorts the values of `lower(email)` into a B-tree. Once you write **the same expression** in a query, it can use the index, so normalization queries like `WHERE lower(email) = ...` no longer degrade to a full table scan.

## Basic Usage and Match Conditions

```sql
CREATE TABLE users_e (
    id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email  text NOT NULL,
    city   text
);

INSERT INTO users_e (email, city)
SELECT 'User' || g || '@Example.COM', 'city-' || (g % 100)
FROM generate_series(1, 100000) g;

-- an ordinary index on the column
CREATE INDEX idx_users_e_email ON users_e (email);

-- expression index: note the two layers of parentheses around email
CREATE INDEX idx_users_e_email_lower ON users_e ((lower(email)));
ANALYZE users_e;
```

Syntactically, the outermost parentheses are the delimiter of the index column list, and the inner parentheses mark `lower(email)` as an expression, so it is written `((lower(email)))`.

A query can only match by using **the same expression**:

```sql
-- hits the expression index
EXPLAIN
SELECT id FROM users_e WHERE lower(email) = 'user50000@example.com';
-- Index Scan using idx_users_e_email_lower

-- hits only the ordinary index: equality conditions must be character-for-character
EXPLAIN
SELECT id FROM users_e WHERE email = 'User50000@Example.COM';
-- Index Scan using idx_users_e_email
```

Each of the two indexes serves one style. `lower(email) = 'user50000@example.com'` does not use `idx_users_e_email` (the index stores the original text, not the lowercased form); and conversely `email = 'User...'` does not use the expression index. The easiest thing to trip over during development is an ORM that emits only `WHERE email = ?` while the team assumes there is a `lower` index as a backstop — one `EXPLAIN` reveals it.

## Normalization Scenarios: Case and Whitespace

User input is uncontrollable, and normalization at the entry layer often cannot catch historical data or the various writers, so normalizing at the index layer is more thorough:

```sql
-- normalize case and leading/trailing whitespace together
CREATE INDEX idx_users_e_email_norm
    ON users_e ((lower(btrim(email))));

-- the query must use the identical expression
SELECT id FROM users_e WHERE lower(btrim(email)) = 'user1@example.com';
```

"Same expression" means semantically the same: the case of the function name (`LOWER` vs `lower`), spaces, and newlines do not affect matching — the optimizer compares the parsed expression tree. But whether phrasing differences like `lower(email)` versus `lower(email::text)`, or `btrim(x)` versus `trim(x)`, are equivalent is not guaranteed; a team convention on a fixed spelling is the most trouble-free approach.

Expression indexes also support `UNIQUE`, which is the common implementation of case-insensitive uniqueness:

```sql
CREATE UNIQUE INDEX uniq_users_e_email_lower
    ON users_e ((lower(email)));

INSERT INTO users_e (email) VALUES ('Alice@Example.com');  -- succeeds
INSERT INTO users_e (email) VALUES ('ALICE@example.com');  -- errors: duplicate key
```

## The IMMUTABLE Requirement

An expression in an index must be immutable: the same input must yield the same result at any time and in any environment. This is the precondition for the index to stay ordered over the long term, and the optimizer uses it to match query expressions:

```sql
-- errors: now() is a volatile function
CREATE INDEX idx_bad ON users_e (id) WHERE id > 1 AND now() > '2026-01-01';
-- ERROR: functions in index predicate must be marked IMMUTABLE

-- errors: a custom function not marked IMMUTABLE
CREATE FUNCTION slugify(t text) RETURNS text
    AS $$ SELECT lower(regexp_replace(t, '\s+', '-', 'g')) $$ LANGUAGE sql;

CREATE INDEX idx_bad2 ON users_e ((slugify(email)));
-- ERROR: functions in index expression must be marked IMMUTABLE
```

The fix is to mark the function `IMMUTABLE` — provided it really depends only on its input parameters. Mislabeling `IMMUTABLE` (for example, if the function secretly depends on a timezone setting or on some table) produces a self-contradictory index, and that class of error is very hard to diagnose afterwards. Expressions that depend on `TimeZone` must pin the timezone explicitly: `(created_at AT TIME ZONE 'Asia/Shanghai')::date` is immutable, but `created_at::date` (on a timestamptz column) is not.

## Expression Indexes on JSONB Fields

When doing equality/range lookups on scalars pulled out of jsonb, a B-tree expression index is more appropriate than GIN:

```sql
CREATE TABLE events_j (
    id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    payload  jsonb NOT NULL
);

INSERT INTO events_j (payload)
SELECT jsonb_build_object('order_no', 'A' || g, 'type', 'pay')
FROM generate_series(1, 100000) g;

CREATE INDEX idx_events_j_order_no
    ON events_j ((payload->>'order_no'));

EXPLAIN
SELECT id FROM events_j WHERE payload->>'order_no' = 'A50000';
-- Index Scan using idx_events_j_order_no
```

`->>'order_no'` returns text and uses a standard B-tree equality lookup. If the requirement is a containment query (`payload @> '{"order_no": "A50000"}'`, or querying on arbitrary keys), that is where GIN comes in, see [GIN Indexes](./gin). The two paths do not conflict: high-frequency equality queries use a B-tree expression index, and general-purpose retrieval over sparse keys uses GIN.

## Expression Indexes vs. Generated Columns

Generated columns (`GENERATED ALWAYS AS (...) STORED`, PG 12+) are another normalization approach, see [Generated Columns and CHECK](../advanced-sql/generated-columns-and-check):

```sql
ALTER TABLE users_e ADD COLUMN email_norm text
    GENERATED ALWAYS AS (lower(btrim(email))) STORED;

CREATE INDEX idx_users_e_norm ON users_e (email_norm);

-- SELECT can reference it directly; the query side does not repeat the expression
SELECT id, email_norm FROM users_e WHERE email_norm = 'user2@example.com';
```

Both require the expression to be `IMMUTABLE`, and their retrieval performance is on a par; the difference is on the engineering side:

- **Discoverability**: a generated column is a real column, visible in `SELECT *`, EXPLAIN output, and ORM models; an expression index is hidden inside the index definition, and new team members easily do not know it exists, so a casual `WHERE email = ...` bypasses it.
- **Usage cost**: generated columns let the query side write a plain column name; an expression index requires every query to repeat the expression, and a single typo kills it.
- **Storage and writes**: a generated column stores the normalized value in the heap tuple, widening the table, and every write must maintain it; an expression index only takes index space. For a table where `SELECT *` is frequent and the normalized value is not always queried, an expression index is the more restrained choice.
- **Constraints and references**: a generated column can be `NOT NULL` and referenced by CHECK; as a foreign-key target it is only supported from PG 18 (PG 17 and earlier do not allow it), so do not treat generated columns as foreign-key anchors when designing cross-table constraints. An expression index solves only retrieval.

Simply put: if you only need to speed up a handful of queries, use an expression index; if the normalized value is data the business references (external output, cross-table validation), use a generated column.

## Notes and Common Pitfalls

- If the expression does not match character for character, you degrade to a sequential scan — confirm with `EXPLAIN` before shipping; this is the most frequent way expression indexes backfire.
- The selectivity of the expression result can differ greatly from the original column (e.g. `lower(city)` merges `Beijing`/`BEIJING`); the optimizer has statistics for expressions, but remember to `ANALYZE` after creating a new index.
- The write path computes the expression on every write, so the more complex the function, the more pronounced the write amplification; avoid stacking complex functions (such as regex replacement) in indexes on high-write tables.
- When the expression definition changes (say, the normalization rule is upgraded from `lower` to `lower(btrim(...))`), old indexes do not follow automatically and must be rebuilt: `REINDEX` is not enough — drop and recreate with the new expression.

## References

- [PostgreSQL Official Documentation · Chapter 11. Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL Official Documentation · 11.2. Index Types](https://www.postgresql.org/docs/current/indexes-types.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [generated-columns-and-check](/advanced-sql/generated-columns-and-check.md)
- [jsonb-operations](/advanced-sql/jsonb-operations.md)
- [pattern-matching](/advanced-sql/pattern-matching.md)
- [sql-functions-advanced](/advanced-sql/sql-functions-advanced.md)
- [where-and-expressions](/basics/where-and-expressions.md)
- [index-failure-and-misuse](index-failure-and-misuse.md)
- [index-only-scans](index-only-scans.md)
- [index](index.md)
- [partial-indexes](partial-indexes.md)- [Partial Indexes](./partial-indexes) — expressions combine with WHERE predicates to index a "normalized hot subset".
- [Index Failures and Misuse](./index-failure-and-misuse) — `WHERE upper(col) = ...` cannot use an ordinary index; that is exactly where expression indexes earn their keep.
- [Generated Columns and CHECK](../advanced-sql/generated-columns-and-check) — the full account of generated column syntax.
- [GIN Indexes](./gin) — the other route for jsonb containment queries.

Official documentation: [Expression Indexes](https://www.postgresql.org/docs/current/indexes-expressional.html), [Function Volatility Classes](https://www.postgresql.org/docs/current/xfunc-volatility.html).
