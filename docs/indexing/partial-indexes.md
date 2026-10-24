# Partial Indexes

A partial index builds the index on the subset of rows named by `CREATE INDEX ... WHERE predicate`: only rows satisfying the predicate appear in the index file, and all other rows are absent entirely. When the vast majority of queries care about only a small fraction of the table (only unfinished orders, only non-deleted data), gathering that subset into a small standalone index gives you smaller size, less write amplification, and a more concentrated hot page set all at once.

## Predicate Semantics and Matching Conditions

First, build a representative table: 99% of orders are done, only 1% are pending.

```sql
CREATE TABLE orders_p (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     bigint NOT NULL,
    status      text   NOT NULL DEFAULT 'pending',
    amount      numeric(10,2) NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO orders_p (user_id, status, amount)
SELECT g % 1000,
       CASE WHEN g % 100 = 0 THEN 'pending' ELSE 'done' END,
       g::numeric
FROM generate_series(1, 100000) g;

CREATE INDEX idx_orders_pending ON orders_p (created_at) WHERE status = 'pending';
```

Whether the optimizer can use a partial index depends on **whether the query predicate implies the index predicate**: whenever the query condition holds, the index predicate must necessarily hold. In the example above `WHERE status = 'pending'` is exactly the index predicate, so it matches directly:

```sql
EXPLAIN
SELECT id, user_id, amount
FROM orders_p
WHERE status = 'pending'
  AND created_at >= '2026-10-01';
```

```plaintext
Index Scan using idx_orders_pending on orders_p
  Index Cond: (created_at >= '2026-10-01 00:00:00+08')
```

Note that `status` no longer appears as a filter in the plan: every row fetched from this index must satisfy `status = 'pending'`, so the executor does not need to recheck. The proof of implication happens at **plan time** and is based on the constants written in the query SQL — the same mechanism used by constraint exclusion.

## Hot Rows: Index Only the Unfinished Orders

In an orders table, historical orders are only archived and queried, while almost all active queries concentrate on that small handful of unfinished ones. A partial index collects only those rows, so the whole index may be just a few hundred KB and resident in memory:

```sql
-- only 1000 rows indexed out of 100000
SELECT pg_size_pretty(pg_relation_size('idx_orders_pending'));  -- about 32 kB
SELECT pg_size_pretty(pg_relation_size('orders_p'));            -- the table itself is on the order of several MB

-- only writes to pending rows touch this index
UPDATE orders_p SET amount = amount + 1 WHERE id = 7;    -- done row: does not write this index
UPDATE orders_p SET status = 'paid' WHERE id = 10;       -- done -> paid: neither old nor new value is in the predicate, no write
UPDATE orders_p SET status = 'paid' WHERE id = 200;      -- pending -> paid: one old entry removed, none added
```

A full index may produce index entries on every UPDATE; a partial index confines write amplification to rows covered by the predicate. Rows whose status flips frequently (pending -> paid -> done) stop adding writes to this index once they leave the predicate's scope.

## Combined with Soft Deletes: WHERE deleted_at IS NULL

Nearly all queries on a soft-delete table (see [Soft Delete and Tombstones](../database-design/soft-delete-and-tombstone)) carry `deleted_at IS NULL`, and deleted rows only accumulate, never decrease — a natural fit for a partial index:

```sql
CREATE TABLE users_sd (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email       text NOT NULL,
    deleted_at  timestamptz
);

CREATE INDEX idx_users_sd_email
    ON users_sd (email)
    WHERE deleted_at IS NULL;
```

Login, duplicate-check on registration, and password-reset-by-email all match automatically; deleted accounts no longer occupy index space. The precondition is that the query really does carry `deleted_at IS NULL` — if the ORM's default scope adds it automatically, the index matches; any query that forgets to add it both reads deleted data and fails to use the index, failing at both ends.

## Size and Write Amplification

What a partial index saves is more than disk:

- **Cache hit rate**: leaf pages of a small index stay resident in shared_buffers, so lookups produce almost no physical reads.
- **VACUUM / REINDEX cost**: the smaller the index, the faster the cleanup and rebuild.
- **Write path**: INSERT/UPDATE not satisfying the predicate never touches the index; with several partial indexes, one UPDATE typically updates only a few of them.

The cost is maintaining two sources of "truth": the predicate condition is written into the index definition, so when the business state set changes (a new `processing` state that must also go through the hot path) you have to remember to change the index predicate and rebuild.

## Unique Partial Indexes as Business Uniqueness Constraints

A `UNIQUE` partial index is the standard implementation of "unique within a scope" — duplicates allowed across the table, but not within the predicate:

```sql
-- each user may have at most one in-progress order at a time
CREATE UNIQUE INDEX uniq_orders_user_pending
    ON orders_p (user_id)
    WHERE status = 'pending';

INSERT INTO orders_p (user_id, amount) VALUES (42, 9.90);          -- succeeds
INSERT INTO orders_p (user_id, amount) VALUES (42, 5.00);          -- errors
```

The second insert yields `ERROR: duplicate key value violates unique constraint "uniq_orders_user_pending"`. The same technique expresses rules like "non-deleted email is unique within a tenant" and "a product has only one active promotion in a given time slot", far more reliable than an application-layer check-then-insert — under concurrency an application-layer check inevitably has a race window.

## The Index Is Unusable When the Predicate Does Not Match

If the implication is slightly off, the optimizer will not touch this index:

```sql
-- one way matching fails: the condition is broader than the index predicate
EXPLAIN
SELECT count(*) FROM orders_p WHERE status IN ('pending', 'paid');
-- the predicate is status = 'pending'; IN across two statuses does not imply it -> Seq Scan

-- another way matching fails: NOT IN / <> cannot be proven to imply =
EXPLAIN
SELECT count(*) FROM orders_p WHERE status <> 'done';
-- Seq Scan as well
```

Both queries touch only a few rows semantically, but the optimizer performs only a formal predicate-implication proof and does not "guess". To cover `IN` usage, write the index predicate as `WHERE status IN ('pending', 'paid')` as well — matching the query and index literally is the safest.

## Notes and Common Pitfalls

- **The index predicate must be an immutable expression**. Time-varying functions like `now()` or `CURRENT_DATE` are not allowed in a predicate; `WHERE created_at > now() - interval '7 days'` errors outright. Fixed date constants (`WHERE created_at >= '2026-01-01'`) are fine, but the query must write the same constant to match.
- **Bound variables break matching**. `WHERE status = $1` cannot prove that `$1` implies `'pending'` when a generic plan is generated, so prepared statements and ORM parameterized queries may bypass the partial index. If you see "hand-typed SQL uses the index but the application does not", check here first.
- **Do not use a partial index as a substitute for partitioning**. A predicate only decides "whether this row goes into the index"; the data still lives in one table. If you need query isolation by status at high data volume, consider table partitioning.
- **Statistics are computed over the whole table**. The optimizer knows a partial index covers only part of the rows and estimates accordingly, so you usually do not need to intervene; but if statistics on the predicate column are badly stale, the estimate distorts and the index gets abandoned as well.

## References

- [PostgreSQL Official Documentation · Chapter 11. Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL Official Documentation · 11.2. Index Types](https://www.postgresql.org/docs/current/indexes-types.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [jsonb-design-patterns](/advanced-sql/jsonb-design-patterns.md)
- [soft-delete-and-tombstone](/database-design/soft-delete-and-tombstone.md)
- [pgvector](/ecosystem/pgvector.md)
- [btree-structure](btree-structure.md)
- [composite-index-design](composite-index-design.md)
- [expression-indexes](expression-indexes.md)
- [index-failure-and-misuse](index-failure-and-misuse.md)
- [index](index.md)
- [slow-query-governance](/performance/slow-query-governance.md)- [Expression Indexes](./expression-indexes) — expressions are common in WHERE predicates too; the two can be combined.
- [Index Failures and Misuse](./index-failure-and-misuse) — a mismatched predicate is one form of "unusable", and there are more shapes.
- [Soft Delete and Tombstones](../database-design/soft-delete-and-tombstone) — the complete design of the `deleted_at` approach.
- [B-tree Structure and Principles](./btree-structure) — a partial index is still most commonly a B-tree underneath.

Official documentation: [Partial Indexes](https://www.postgresql.org/docs/current/indexes-partial.html), [CREATE INDEX Predicate Restrictions](https://www.postgresql.org/docs/current/sql-createindex.html).
