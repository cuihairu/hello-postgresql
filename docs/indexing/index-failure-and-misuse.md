# Index Failures and Misuse

"Built an index but it is not used" is rarely PostgreSQL being broken; in the overwhelming majority of cases the query is written in a way that the optimizer **cannot translate the condition into an index range**, or **the statistics make it believe a full table scan is cheaper**. This page lays out the common failure shapes together: each gets one reproducible example and one fix. The diagnostic mantra is to look at the actual plan from `EXPLAIN` first, then check this page item by item.

## Functions Wrapping the Column

Once you apply a function or an operation to an indexed column, the "original value" stored in the index is no help:

```sql
CREATE TABLE users_f (
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_f_email ON users_f (email);
CREATE INDEX idx_users_f_created ON users_f (created_at);
INSERT INTO users_f (email)
SELECT 'user' || g || '@example.com' FROM generate_series(1, 100000) g;
ANALYZE users_f;

-- failure: function wraps the column; an ordinary index does not recognize lower(email)
EXPLAIN SELECT id FROM users_f WHERE lower(email) = 'user1@example.com';
-- Seq Scan

-- failure: same reason, the column is cast / truncated
EXPLAIN SELECT count(*) FROM users_f WHERE created_at::date = '2026-01-01';
-- Seq Scan (timestamptz to date depends on timezone, and it is no longer the original indexed value)
```

Two ways to fix, both keeping "the column bare on the left":

```sql
-- Route A: rewrite the range condition as comparisons on the column
SELECT count(*) FROM users_f
WHERE created_at >= '2026-01-01' AND created_at < '2026-01-02';

-- Route B: build an expression index for the fixed spelling
CREATE INDEX idx_users_f_email_lower ON users_f ((lower(email)));
```

Rewriting `created_at::date = ...` as a left-closed right-open range hits `idx_users_f_created` directly, and also avoids the timezone ambiguity (`::date` results vary with the session timezone).

## Implicit Type Conversion

PostgreSQL is a strongly typed system, which differs from MySQL: `varchar column = number` will not silently cast the column to a number and compare, it errors outright:

```sql
-- the users table's email is text; if the order number column is varchar:
CREATE TABLE tickets_t (code varchar(20) NOT NULL);
INSERT INTO tickets_t SELECT g::text FROM generate_series(1, 10000) g;
CREATE INDEX idx_tickets_t_code ON tickets_t (code);

EXPLAIN SELECT * FROM tickets_t WHERE code = 12345;
-- ERROR: operator does not exist: character varying = integer
```

The real hazards are the two shapes that "do not error but do misbehave":

- **Parameterized query types are decided by the driver**. If a JDBC/ORM driver sends a primary key parameter as text (`setString`), the server must adjudicate a `bigint = text` type clash — at best it errors, at worst the plan takes a different route. Fix: set parameters to the column's real type at the driver layer, or write `$1::bigint` explicitly in the query.
- **A literal type that is legal but takes a different comparison path**. `code = 12345` errors, while `code = '12345'` is correct (an unknown literal resolves to the column type); conversely a string literal against a numeric column is fine. Inspect the SQL the ORM actually emits in the logs; do not guess.

The rule in one sentence: **let the column participate in the comparison in its original type, with conversion happening only on the constant/parameter side** — conversion on the constant side happens at plan time and does not affect the index.

## Degradation of OR Conditions

A single B-tree index can produce only one range, so conditions joined by `OR` on different columns force the optimizer to merge multiple index results with BitmapOr; if any branch has no usable index, the whole query degrades to a sequential scan:

```sql
CREATE TABLE contacts_c (
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    phone text,
    email text
);
CREATE INDEX idx_contacts_c_phone ON contacts_c (phone);
-- note: there is no index on email
EXPLAIN SELECT * FROM contacts_c WHERE phone = '13800000000' OR email = 'a@b.com';
-- Seq Scan on contacts_c
--   Filter: ((phone = ...) OR (email = ...))
```

After indexing `email` too, the plan becomes a `Bitmap Heap Scan` with `BitmapOr` underneath (the union of two Bitmap Index Scans). If the two branches' selectivity differs enormously (one matches 1 row, the other 100,000), the sturdier spelling is to split with `UNION ALL` so each branch can use its own optimal plan:

```sql
SELECT * FROM contacts_c WHERE phone = '13800000000'
UNION ALL
SELECT * FROM contacts_c
WHERE email = 'a@b.com'
  AND phone IS DISTINCT FROM '13800000000';   -- remove the intersection of the two branches; rows with phone NULL must not be lost either
```

An `IN` list can be regarded as shorthand for an `OR` on the same column, and B-tree handles `col IN (1,2,3)` as multiple index lookups, unaffected by this trap; cross-column `OR` is the risky zone.

## Leading Wildcard LIKE

B-tree is an ordered structure, so prefix-deterministic matches like `LIKE 'abc%'` can be converted into a `>= 'abc' AND < 'abd'` range lookup under the right collation; `LIKE '%abc'` has an unknown prefix, and no ordering helps:

```sql
EXPLAIN SELECT * FROM users_f WHERE email LIKE 'user1%';
-- under a common non-C locale (e.g. zh_CN.UTF-8): Seq Scan
-- only with C collation at the database or column level, or with a text_pattern_ops index, does it use the index

EXPLAIN SELECT * FROM users_f WHERE email LIKE '%example.com';
-- Seq Scan; no B-tree can help
```

Two details:

- **collation matters**: for text columns under a non-C collation, the ordinary B-tree ordering and the byte-wise order that `LIKE` needs do not agree, so even `LIKE 'abc%'` may fail to use the index. The fix is to specify `text_pattern_ops` when building the index (or use C collation for the column): `CREATE INDEX ON users_f (email text_pattern_ops);`
- **Two-sided wildcards (`%kw%`)**: only a trigram GIN index can handle this, see [GIN Indexes](./gin) and [Pattern Matching](../advanced-sql/pattern-matching).

## Stale Statistics Making the Optimizer Give Up

The index is available, but the optimizer estimates from statistics: this condition has to fetch 80% of the rows, so heap fetches are worse than a sequential scan. The problem is that the estimate is based on the sample taken at `ANALYZE` time — without re-analyzing after a bulk import or a large delete, the estimate can be off by several orders of magnitude and the plan goes haywire:

```sql
INSERT INTO users_f (email)
SELECT 'new' || g || '@example.com' FROM generate_series(1, 500000) g;

-- query without ANALYZE; the estimated rows may be in the thousands while reality is hundreds of thousands
EXPLAIN ANALYZE SELECT * FROM users_f WHERE email LIKE 'new%';

ANALYZE users_f;   -- afterwards the plan recovers
```

When diagnosing, compare the estimated rows in the `EXPLAIN` output (`rows=...`) with the actual rows (`actual ... rows=...`); a gap of more than one order of magnitude means suspect the statistics first. `ANALYZE` after bulk writes and autovacuum's analyze threshold adjustment are covered in [Statistics and ANALYZE](../performance/statistics-and-analyze).

## Forcing Switches as a Debugging Technique

When you suspect "the optimizer should not be choosing a sequential scan", you can temporarily suppress sequential scans to squeeze out an index plan:

```sql
SET enable_seqscan = off;

EXPLAIN ANALYZE SELECT * FROM users_f WHERE email LIKE '%example.com';
-- even if this forces a Bitmap/Index Scan, the elapsed time is usually still far higher than a Seq Scan

RESET enable_seqscan;
```

Mind the boundary of this switch:

- It only multiplies the sequential scan cost by `disable_cost` (an astronomical number), **it is not a prohibition** — if there is genuinely no usable index, the plan is still a Seq Scan, which nicely proves "the index is unavailable" rather than "the optimizer despises it".
- Session-level diagnosis only; **never use it as a production fix** baked into application configuration. Turning it off globally makes the genuinely appropriate full-scan large queries all slow down at once.
- Rather than flipping the switch, read the costs and row estimates in `EXPLAIN (ANALYZE, BUFFERS)` to find the optimizer's real reason for "despising the index" (see [EXPLAIN ANALYZE and BUFFERS](../performance/explain-analyze-buffers)).

## Index Behavior for NOT, <> and IS NULL

The conditions B-tree can use for index positioning are `=`, `<`, `<=`, `>`, `>=` (and forms convertible to a range). `<>` and `NOT IN` mean "everything except this range", which cannot itself form a contiguous index range:

```sql
EXPLAIN SELECT count(*) FROM users_f WHERE email <> 'user1@example.com';
-- Seq Scan: too many matching rows, and the condition is not a range

EXPLAIN SELECT count(*) FROM users_f WHERE email IS NOT NULL;
-- may use Bitmap Index Scan / Index Only Scan:
-- NULL values are concentrated at one end of the B-tree, so IS NOT NULL can be converted to a range scan over the non-null end
```

Practical conclusions:

- When `col <> 'x'` is slow, first confirm whether you really do need to fetch the large majority of rows — in that case a sequential scan is simply correct. If the negation covers only a tiny fraction, consider a **partial index** (see [Partial Indexes](./partial-indexes)): `CREATE INDEX ... WHERE status <> 'done'` collects just "the remaining few rows".
- `NOT IN (subquery)` also has the semantic trap of NULL three-valued logic; prefer `NOT EXISTS` whenever you can use it.
- Both `col IS NULL` and `col IS NOT NULL` can exploit a B-tree (NULL values are concentrated at one end of the index), and when these conditions are highly selective on a nullable column the index works normally.

## Notes and Common Pitfalls

- Before calling something a "failure", read the plan type and estimated rows in `EXPLAIN`: the optimizer choosing a sequential scan on a small table is correct behavior, not a failure.
- Implicit conversion problems cannot be reproduced in a test environment with literals (a hand-typed `'12345'` has the right type) and usually only fire on the production parameterized path, so reproduce against the driver's actual SQL.
- One query hitting several traps at once (function wrapping + leading wildcard) is very common; peel them apart one by one, then look at the plan.
- Every "does not match" on this page is about B-tree; the same condition has its own usable operators on GIN/GiST, and the deciding factor is the operator class, not intuition.

## References

- [PostgreSQL Official Documentation · Chapter 11. Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL Official Documentation · 11.2. Index Types](https://www.postgresql.org/docs/current/indexes-types.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [where-and-expressions](/basics/where-and-expressions.md)
- [postgis](/ecosystem/postgis.md)
- [btree-structure](btree-structure.md)
- [composite-index-design](composite-index-design.md)
- [expression-indexes](expression-indexes.md)
- [index](index.md)
- [partial-indexes](partial-indexes.md)
- [join-implementations](/internals/join-implementations.md)
- [knowledge](/knowledge.md)
- [common-bad-plans](/performance/common-bad-plans.md)- [Expression Indexes](./expression-indexes) — the standard fix for a function-wrapped column.
- [Partial Indexes](./partial-indexes) — another escape hatch for `<>`-style conditions.
- [Statistics and ANALYZE](../performance/statistics-and-analyze) — systematic governance of estimate drift.
- [EXPLAIN Basics](../performance/explain-basics) — the prerequisite for reading every plan output on this page.

Official documentation: [Optimizer Switches](https://www.postgresql.org/docs/current/runtime-config-query.html), [Pattern Matching](https://www.postgresql.org/docs/current/functions-matching.html), [Indexes and Collations](https://www.postgresql.org/docs/current/indexes-collations.html).
