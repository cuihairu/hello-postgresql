# B-tree Structure and Principles

B-tree (a multi-way balanced search tree) is PostgreSQL's default index type: when `CREATE INDEX` omits `USING`, a B-tree is what you get. It organizes index keys into a "short and wide" tree — starting from the root page, one page read per level, finally landing on leaf pages that are sorted by key and chained together with a doubly linked list. Equality lookups walk a single path, range scans read sequentially along the leaf chain, and `ORDER BY` may need no sorting at all. These three properties make B-tree the first choice for the vast majority of queries. For internal structure details, see the official documentation on [B-tree implementation](https://www.postgresql.org/docs/current/btree.html).

## Tree Shape: Internal Pages Branch, Leaf Pages Form a Chain

A B-tree index consists of three kinds of pages, each 8 KB:

- **Root page**: the entry point of the tree, holding a number of "separator key + child page pointer" pairs.
- **Internal pages**: keep directing the search toward deeper pages according to the separator keys.
- **Leaf pages**: hold the actual index entries `(key, TID)`, where the TID points to a row in the heap table. Adjacent leaf pages are chained together with a doubly linked list.

Range scans are efficient precisely because of the leaf chain: once the start of the range is located, subsequent rows only need to be read sequentially from adjacent leaf pages along the list — no return trip to the root page for a fresh search. Equality lookups are the opposite: a single path from root to leaf, reading as many pages as the tree height.

With the pageinspect extension you can observe the tree height directly (`level` is the number of levels above the leaves; `level=1` means two layers, "root → leaf"):

```sql
CREATE EXTENSION IF NOT EXISTS pageinspect;

CREATE TABLE orders (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    status     text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO orders (status, created_at)
SELECT (ARRAY['new','paid','shipped','done'])[1 + (g % 4)],
       now() - (g || ' minutes')::interval
FROM generate_series(1, 100000) g;

CREATE INDEX orders_created_at_idx ON orders (created_at);
ANALYZE orders;

SELECT level FROM bt_metap('orders_created_at_idx');   -- 100k rows: level = 1
```

## Equality, Range, Prefix, and Sorting

B-tree can serve far more query shapes than plain "equality lookups":

```sql
-- Equality: one tree search
EXPLAIN (COSTS OFF) SELECT * FROM orders WHERE id = 42;
-- Index Scan using orders_pkey on orders
--   Index Cond: (id = 42)

-- Range: locate the start point, then read along the leaf chain
EXPLAIN (COSTS OFF) SELECT * FROM orders WHERE created_at > now() - interval '1 day';
-- Index Scan using orders_created_at_idx on orders
--   Index Cond: (created_at > (now() - '1 day'::interval))

-- Sorting: output directly in index order, backward scan for DESC
EXPLAIN (COSTS OFF) SELECT * FROM orders ORDER BY created_at DESC LIMIT 10;
-- Limit
--   ->  Index Scan Backward using orders_created_at_idx on orders
```

Prefix matches like `LIKE 'ship%'` can also use the index, but with one prerequisite: **the column's collation must be C, or the index must be built with `text_pattern_ops`**. Under a non-C collation (such as `en_US.UTF-8`), the default `text_ops` cannot turn `LIKE 'ship%'` into a range condition, and you get a sequential scan instead:

```sql
CREATE INDEX orders_status_pattern ON orders (status text_pattern_ops);
EXPLAIN (COSTS OFF) SELECT * FROM orders WHERE status LIKE 'ship%';
-- Bitmap Heap Scan on orders
--   ->  Bitmap Index Scan on orders_status_pattern
--         Index Cond: ((status ~>=~ 'ship'::text) AND (status ~<~ 'shiq'::text))
```

Note that `LIKE '%ship'` (trailing wildcard) can never use a B-tree, because the index is ordered by prefix, not by suffix.

## The Leftmost Prefix Rule

The sort order of a multi-column B-tree index `(a, b, c)` is: sort by `a` first, then by `b` among rows with equal `a`, then by `c`. Therefore:

- `WHERE a = ? AND b > ?` can use the index (`a` pins down an equality point, `b` stays ordered within that range).
- `WHERE b = ?` cannot use this index — `b` is not globally ordered across the whole index, so at best you get a full index scan.
- `WHERE a = ? AND c = ?` can only use the `a` part; the `c` condition has to be filtered after fetching rows from the heap.

```sql
-- Index (tenant_id, created_at): tenant_id equality + created_at range, both columns used
EXPLAIN (COSTS OFF) SELECT * FROM events
WHERE tenant_id = 3 AND created_at > now() - interval '1 hour';
-- Index Scan using events_tenant_created_idx on events
--   Index Cond: ((tenant_id = 3) AND (created_at > (now() - '01:00:00'::interval)))

-- Querying created_at alone: unusable (unless tenant_id is also an equality condition)
EXPLAIN (COSTS OFF) SELECT count(*) FROM events WHERE created_at > now() - interval '1 hour';
-- Seq Scan on events
```

For column-order design of composite indexes, see [Composite Index Design](./composite-index-design).

## Selectivity and Statistics: Why the Optimizer Picks It

Whether the optimizer uses an index depends on its estimate of "how many rows the index can filter out", and that estimate comes from the statistics in `pg_stats`:

```sql
SELECT attname, n_distinct FROM pg_stats
WHERE tablename = 'orders' AND attname IN ('id', 'status');
--  attname | n_distinct
-- ---------+------------
--  id      |         -1      -- -1 means "nearly every row differs" (high cardinality)
--  status  |          4      -- only 4 distinct values (low cardinality)
```

A negative `n_distinct` denotes the ratio of distinct values (-1 means unique across the table). Rules of thumb:

- **High-cardinality columns** (id, email, created_at): equality or range queries filter out most rows, so an index pays off.
- **Low-cardinality columns** (status, gender, booleans): a standalone index usually does not pay off — after matching a few thousand rows, the random I/O of heap fetches is slower than a sequential scan, and the optimizer will simply abandon the index. The right use of low-cardinality columns is as the leading column of a composite index, or paired with a partial index (see [Partial Indexes](./partial-indexes)).

Statistics are maintained by `ANALYZE`; stale statistics mislead the optimizer, see [Statistics and ANALYZE](../performance/statistics-and-analyze).

## Height Scale: About 3 Levels for a Million Rows

B-tree's capacity comes from "each page holding hundreds of index entries": a leaf entry is roughly 16–24 bytes (key + TID), and an 8 KB page fits hundreds of them. So:

| Table size | Tree height (level) | Page reads per equality lookup |
| --- | --- | --- |
| 100k rows | 1 (root → leaf) | 2 |
| 1M rows | 2 (root → internal → leaf) | 3 |
| 100M rows | 3 | 4 |

Measured cross-check (a B-tree index on a 1M-row table):

```sql
SELECT level FROM bt_metap('brin_events_ts_btree');   -- 1M rows: level = 2
```

That is, even a ten-million-row table needs only 3 page reads for one primary-key lookup, and the root page and upper internal pages almost always stay resident in shared_buffers, so actual disk I/O is often just 1 read. This is the fundamental reason B-tree can carry large tables.

## Write Cost and Random Key Inserts

Indexes are not free: every `INSERT`/`UPDATE` must maintain all indexes in sync, and more indexes mean slower writes. B-tree write cost also depends on key distribution:

- **Monotonically increasing keys** (`serial`/`identity`, timestamps): new rows always append to the rightmost leaf page, fewer page splits, faster writes.
- **Random keys** (UUID v4): new rows land at random positions in the tree, page splits happen on random pages, page utilization drops, and the tree grows taller more easily. Measured on the same 200k rows: sequential key `level = 1`, random UUID `level = 2`.

```sql
CREATE TABLE uuid_t (id uuid DEFAULT gen_random_uuid(), v text);
INSERT INTO uuid_t (v) SELECT 'x' || g FROM generate_series(1, 200000) g;
CREATE INDEX uuid_t_id_idx ON uuid_t (id);
SELECT level FROM bt_metap('uuid_t_id_idx');   -- 2: one level deeper than a sequential key at the same scale
```

Two mitigation options:

1. **B-tree deduplication (PG 13+)**: multiple TIDs for the same key are merged into one entry, significantly shrinking duplicate-key indexes and reducing splits.
2. **Switch to UUID v7 / time-ordered UUIDs**: keys increase monotonically with time, giving a write pattern close to sequential keys.

Random keys cause another problem: index entries scatter across disk, increasing random I/O for range scans and index scans. If the business does not need globally random keys, prefer time-ordered ones.

## References

- [PostgreSQL Official Documentation · Chapter 11. Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL Official Documentation · 11.2. Index Types](https://www.postgresql.org/docs/current/indexes-types.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Composite Index Design](./composite-index-design)
- [Index Failures and Misuse](./index-failure-and-misuse)
- [Reading EXPLAIN](../performance/explain-basics)
- [Statistics and ANALYZE](../performance/statistics-and-analyze)
- [conditional-expressions](/advanced-sql/conditional-expressions.md)
- [common-beginner-mistakes](/basics/common-beginner-mistakes.md)
- [primary-key-design](/database-design/primary-key-design.md)
- [brin](brin.md)
- [composite-index-design](composite-index-design.md)
- [index-bloat-and-maintenance](index-bloat-and-maintenance.md)
- [index-selection-decision-tree](index-selection-decision-tree.md)
- [index](index.md)
- [partial-indexes](partial-indexes.md)
- [spgist-and-hash](spgist-and-hash.md)
- [knowledge](/knowledge.md)
