# Pagination and Sorting

`LIMIT/OFFSET` is the most intuitive way to paginate, but its read cost grows linearly with page depth — to reach page 1000 the database still has to scan through the data of the first 999 pages. The alternative is keyset (cursor) pagination: use "the key value of the last row of the previous page" as the filter condition of the next query, giving a constant cost per page. This page covers the implementation of both, the composite index keyset pagination needs, the mechanism by which ordering without a unique key loses or duplicates rows across pages, and the cost of the page-count `count(*)`.

## Sample Table

```sql
CREATE TABLE events (
    id         bigserial PRIMARY KEY,
    user_id    bigint NOT NULL,
    created_at timestamptz NOT NULL,
    amount     numeric(10,2)
);

-- Generate 100,000 rows of test data
INSERT INTO events (user_id, created_at, amount)
SELECT (random() * 999)::bigint + 1,
       now() - (random() * interval '365 days'),
       round((random() * 1000)::numeric, 2)
FROM generate_series(1, 100000);

-- The composite index keyset pagination requires
CREATE INDEX idx_events_user_created ON events (user_id, created_at DESC, id DESC);
```

## OFFSET's Cost Grows Linearly with Page Depth

Two forms first:

```sql
-- Page one: fast
SELECT id, created_at, amount
FROM events
ORDER BY created_at DESC, id DESC
LIMIT 20 OFFSET 0;

-- Page 5000: it must read through the first 99980 rows just to get 20
SELECT id, created_at, amount
FROM events
ORDER BY created_at DESC, id DESC
LIMIT 20 OFFSET 99980;
```

Comparing with `EXPLAIN (ANALYZE, BUFFERS)` shows the gap directly:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM events ORDER BY created_at DESC, id DESC LIMIT 20 OFFSET 99980;
```

The subplan under the Offset node in the plan still has to produce 100000 rows (the first 99980 are discarded), so deep pagination spends almost all its time on "generate then throw away." If the ordering has no index support, there is also an extra Sort node that materializes the whole result. Where OFFSET pagination is appropriate: shallow page depths (the first few dozen pages), small data volumes, or products that explicitly require "jump to any page number."

## Keyset Pagination and Row Value Comparison

The core idea: do not locate by "skipping N rows." Instead, remember the sort key of the last row of the previous page, and have the next page continue "from strictly after that position." PostgreSQL supports row value comparison, which makes the syntax compact:

```sql
-- Page one
SELECT id, user_id, created_at, amount
FROM events
WHERE user_id = 42
ORDER BY user_id, created_at DESC, id DESC
LIMIT 20;

-- The next page: carry in the (created_at, id) of the last row of page one
SELECT id, user_id, created_at, amount
FROM events
WHERE user_id = 42
  AND (created_at, id) < ('2026-01-05 10:00+08', 12345)
ORDER BY user_id, created_at DESC, id DESC
LIMIT 20;
```

`(created_at, id) < (v1, v2)` is a lexicographic comparison that expands to `(created_at < v1) OR (created_at = v1 AND id < v2)`; the database handles the row value as a whole, so the planner can use the `(user_id, created_at DESC, id DESC)` index to jump straight to the starting point. **The sort key must put a unique column (the primary key id) at the end as a backstop**, otherwise the order among multiple rows with the same sort key is indeterminate (detailed next). Every page of keyset pagination is one index range scan whose cost is independent of page depth; the price is no random page jumping, only "previous page / next page."

## Unstable Ordering: Lost and Duplicated Rows Across Pages

When the sort key is not unique and the data changes between two pages (or there are concurrent writes), the same record can appear on both pages, or both pages can miss it. The mechanism is direct:

```sql
-- created_at has many duplicates; two runs of the same query may return different orders
SELECT id, created_at FROM events ORDER BY created_at LIMIT 20 OFFSET 0;
SELECT id, created_at FROM events ORDER BY created_at LIMIT 20 OFFSET 20;
```

Without a unique key backstop, the relative order among rows with the same `created_at` has no guarantee whatsoever; two queries (even two executions inside one transaction) may return different orders, and the boundary rows get dropped or duplicated. There is only one defensive measure: **always append a unique column at the end of ORDER BY** (the primary key or `id DESC`). This is also the precondition for keyset pagination to be correct.

Another kind of "instability" comes from the sort key itself being updated: a user paginates ordered by `updated_at`, and a row is updated in the meantime, so its position shifts. For scenarios that cannot tolerate drift (such as exporting the full dataset), use `REPEATABLE READ` isolation inside a transaction or switch to snapshot-based export. See [Transactions and Isolation Levels](../internals/transactions-and-isolation).

## TABLESAMPLE Random Sampling

When you do not need "genuinely random pagination" and just want a random sample, `TABLESAMPLE` from PG 9.5 is several orders of magnitude faster than `ORDER BY random()`:

```sql
SELECT id, amount FROM events TABLESAMPLE SYSTEM (0.1);   -- about 0.1% of the blocks
```

`SYSTEM` samples randomly by data block — fast, but the sample is contiguous within a block; `BERNOULLI` samples row by row, which is more uniform and also slower. Both only guarantee an "approximate" percentage. It is not a replacement for pagination; it just avoids using `ORDER BY random()` on a large table.

## The Cost of count(*) and Page Numbers

Page navigation needs a total row count, and `SELECT count(*) FROM events WHERE user_id = 42` is itself a full index scan that easily runs to hundreds of milliseconds on a large table. Common alternative strategies:

- **No exact total**: show only a "next page" button, or have the front end "load more" — keyset pagination needs no total at all.
- **An estimate**: the row-count estimate from `EXPLAIN`, or `pg_class.reltuples` (for whole-table counts); the error is usually acceptable for reports.
- **Cached counts**: for lists whose totals are not very volatile, cache in Redis or refresh a materialized summary table on a schedule.
- **Converge the condition**: give the count query the same filters as the list, avoiding an unfiltered whole-table count like `count(*) FROM events`.

A page total precise to the individual row is continuous pure overhead on tens-of-millions-of-rows tables; confirm at the product level that it is really needed.

## Caveats and Common Traps

- `LIMIT 20 OFFSET 99980` is not just slow: data changes during a deep OFFSET also scramble the pages, compounding the unstable-ordering problem.
- In a row value comparison `(a, b) < (v1, v2)`, the parenthesized form on both sides must match; a row value on one side and a loose set of conditions on the other gives different semantics.
- The cursor value for keyset pagination must be encoded before passing it to the front end (such as base64 of `created_at|id`); do not let the client splice raw SQL fragments.
- When ordering by a nullable column in `ORDER BY`, pay attention to the default behavior of `NULLS FIRST/LAST`. See [Conditional Expressions](./conditional-expressions).
- The column order of a composite index must match the direction of `ORDER BY` (including DESC); mixed-direction ordering needs an index with the matching direction. See [Composite Index Design](../indexing/composite-index-design).

## References

- [PostgreSQL official documentation · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL official documentation · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Conditional Expressions](./conditional-expressions)
- [Composite Index Design](../indexing/composite-index-design)
- [Slow Query Governance](../performance/slow-query-governance)
- [Common Bad Execution Plans](../performance/common-bad-plans)
- [conditional-expressions](conditional-expressions.md)
- [index](index.md)
- [window-functions-advanced](window-functions-advanced.md)
- [primary-key-design](/database-design/primary-key-design.md)
- [composite-index-design](/indexing/composite-index-design.md)
- [knowledge](/knowledge.md)
- [connection-and-orm-optimization](/performance/connection-and-orm-optimization.md)
Official documentation: [LIMIT and OFFSET](https://www.postgresql.org/docs/current/queries-limit.html), [Row value comparison](https://www.postgresql.org/docs/current/functions-comparisons.html#ROWWISE-COMPARISON), [TABLESAMPLE](https://www.postgresql.org/docs/current/sql-select.html#SQL-TABLESAMPLE).
