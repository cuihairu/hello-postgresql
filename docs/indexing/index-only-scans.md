# Index-Only Scans

A plain index scan still has to fetch the row after finding the index entry: it takes the row pointer to the heap and pulls the full tuple. An Index Only Scan (IOS) skips that step — every column the query needs is read straight out of the index entry, and the heap pages are never touched. The price is two hard preconditions: **every column the query references must be in the index**, and **the index holds no visibility information, so the visibility map decides whether a row is visible**. The second precondition ties its real payoff to vacuum.

## A Reproducible Comparison

```sql
CREATE TABLE ios_demo (
    id    int PRIMARY KEY,
    flag  boolean NOT NULL,
    note  text
);

INSERT INTO ios_demo
SELECT g, g % 2 = 0, 'n' || g
FROM generate_series(1, 200000) g;

CREATE INDEX idx_ios_flag ON ios_demo (flag);

-- the key step: get the whole visibility map set
VACUUM ios_demo;

EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) FROM ios_demo WHERE flag;
```

```plaintext
Aggregate
  ->  Index Only Scan using idx_ios_flag on ios_demo
        Heap Fetches: 0
        Buffers: shared hit=55
```

`Heap Fetches: 0` means not a single heap tuple was touched: half of the 200,000 rows match `flag = true`, yet only 55 index buffer pages were read (plus a few visibility map pages). If the query were written as `SELECT id, flag, note ...`, then `note` is not in the index and the optimizer can only fall back to a plain Index Scan or a sequential scan — if the index cannot supply every column the query needs, "only index" is not on the table.

## Heap Fetches and the Visibility Map

Index entries carry no MVCC visibility information (xmin/xmax live on the heap tuple, see [MVCC and Multi-Versioning](../internals/mvcc-and-multi-version)), so the optimizer cannot tell from the index alone "is this row visible to the current transaction". PostgreSQL's answer is the visibility map: one bit per heap page of each table, set during vacuum for pages where "every row is visible to every transaction" (see [VACUUM and HOT](../internals/vacuum-and-hot)).

- Page bit set: the index entry is trusted outright, no heap fetch.
- Bit not set: **the executor must fetch the row** to check its visibility — this is what `Heap Fetches` counts. The plan still says Index Only Scan, but the "only index" benefit is already lost.

Update a batch of rows in that table and look at the plan again:

```sql
UPDATE ios_demo SET note = note || 'x' WHERE id <= 50000;

-- look at the plan without VACUUM first
EXPLAIN (ANALYZE)
SELECT count(*) FROM ios_demo WHERE flag;
-- Heap Fetches: around 25000
-- (pages holding rows with id <= 50000 lose the all-visible bit, and every row there with flag = true is heap-fetched)

VACUUM ios_demo;

EXPLAIN (ANALYZE)
SELECT count(*) FROM ios_demo WHERE flag;
-- Heap Fetches: 0       (visibility map is clean again)
```

You do not need to update a value that is in the index: any write touching a heap page — even an UPDATE to the non-indexed `note` column — clears that page's all-visible bit, and every subsequent Index Only Scan must fetch those rows from the heap until the next vacuum. So on frequently updated tables, Index Only Scan often "wears that name but does a plain index scan's job".

## Extending Coverage with INCLUDE

`INCLUDE` columns enter index storage but do not participate in key order (see [Composite Index Design](./composite-index-design)), and are purpose-built to complete the columns IOS needs without disturbing the search key:

```sql
CREATE TABLE orders_i (
    id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL,
    amount  numeric(10,2) NOT NULL,
    status  text NOT NULL
);

CREATE INDEX idx_orders_i_user
    ON orders_i (user_id) INCLUDE (amount, status);

EXPLAIN
SELECT amount, status FROM orders_i WHERE user_id = 42;
-- Index Only Scan using idx_orders_i_user (Heap Fetches: 0 after vacuum)
```

Writing `(user_id, amount, status)` as key columns would also cover it, but INCLUDE's semantics are clearer: `amount` and `status` are just "carried along in storage", and the B-tree does not maintain sorting or lookup for them, so index maintenance overhead is slightly lower and queries do not accidentally depend on their positional order. Note that only B-tree (and some operator classes of GiST and SP-GiST) support INCLUDE.

## Which Index Types Support IOS

Per the official documentation: B-tree supports Index Only Scans unconditionally; GiST and SP-GiST support it for some operator classes only; GIN entries store only part of the original value, so it is not supported; BRIN stores only block-range summaries and Hash stores only hash codes, neither can reconstruct a full row from the index, so neither is supported. Only B-tree/GiST/SP-GiST support INCLUDE. That means "covering indexes" as an optimization is basically unavailable for jsonb, array, and full-text (GIN) scenarios; when you need covering, prefer a B-tree expression index (see [Expression Indexes](./expression-indexes)).

## Operational Levers That Make IOS Pay Off

Almost all of an Index Only Scan's real benefit is decided by how clean the visibility map is, which puts the responsibility on routine maintenance:

- **Make sure autovacuum keeps up**: if a table is not vacuumed for a long time after a bulk UPDATE/DELETE, `Heap Fetches` keeps climbing. Running `VACUUM (ANALYZE)` once by hand on a large table is the most direct stopgap.
- **Watch the all-visible ratio of pages**:

  ```sql
  SELECT relname, n_live_tup, n_dead_tup,
         last_autovacuum
  FROM pg_stat_user_tables
  WHERE relname = 'ios_demo';
  ```

- **Long transactions hold back vacuum's cleanup progress** (old snapshots prevent dead tuple reclamation and page bit setting), so put long transactions on the suspect list when diagnosing a sudden IOS slowdown.
- For routine maintenance and bloat governance, see [Index Bloat and Maintenance](./index-bloat-and-maintenance) — falling index page density also increases the number of pages an IOS must read.

## Notes and Common Pitfalls

- Without `ANALYZE`, `EXPLAIN` does not show `Heap Fetches`; reading only the plan type leads you to conclude "it is already using IOS, so it must be fast". You must use `EXPLAIN (ANALYZE, BUFFERS)` to evaluate — see [EXPLAIN ANALYZE and BUFFERS](../performance/explain-analyze-buffers).
- `SELECT *` is fundamentally incompatible with Index Only Scans; if you want a hot query to get IOS, first constrain the query's column list.
- `count(*)`, existence checks, and reporting queries that take only indexed columns are the biggest IOS beneficiaries; the benefit is especially pronounced with low selectivity on a large table.
- On frequently updated tables, do not pile on INCLUDE columns for IOS's sake: each extra column adds a dose of write amplification to the index, and when the VM stays dirty these investments pay nothing back.

## References

- [PostgreSQL Official Documentation · Chapter 11. Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL Official Documentation · 11.2. Index Types](https://www.postgresql.org/docs/current/indexes-types.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [naming-and-style-conventions](/basics/naming-and-style-conventions.md)
- [index-bloat-and-maintenance](index-bloat-and-maintenance.md)
- [index](index.md)- [Composite Index Design](./composite-index-design) — the design details of INCLUDE columns versus key columns.
- [Index Bloat and Maintenance](./index-bloat-and-maintenance) — the effect of index page density and REINDEX on IOS.
- [VACUUM and HOT](../internals/vacuum-and-hot) — how the visibility map gets populated.
- [EXPLAIN ANALYZE and BUFFERS](../performance/explain-analyze-buffers) — how to quantify the real cost of Heap Fetches.

Official documentation: [Index Only Scans and Covering Indexes](https://www.postgresql.org/docs/current/indexes-index-only-scans.html), [Visibility Map](https://www.postgresql.org/docs/current/storage-vm.html).
