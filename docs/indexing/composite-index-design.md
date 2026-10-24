# Composite Index Design

A composite index (multi-column index) organizes the values of multiple columns into one B-tree in dictionary order — "first column first, second column second". Its value is this: one index simultaneously serves equality filters, range filters, and `ORDER BY`, and it can often replace two or three single-column indexes. The core question in designing a composite index is only one — **the order of the columns**. For the behavioral details of multi-column indexes, see the official documentation on [Multi-column Indexes](https://www.postgresql.org/docs/current/indexes-multicolumn.html).

## Column Order: Equality Conditions First, Range/Sort After

The principle: **put the equality-condition column(s) first, and the range or sort column(s) after**. The reason is the leftmost prefix — only when the leading column is an equality can the following column be used for range positioning inside the index; once a column is a range condition, the columns after it are no longer ordered within the index and must be filtered after fetching from the heap.

Take the most common `WHERE tenant_id = ? AND created_at > ?` as an example:

```sql
CREATE TABLE events (
    tenant_id  int NOT NULL,
    status     text,
    created_at timestamptz NOT NULL
);
CREATE INDEX ev_tenant_created ON events (tenant_id, created_at);

-- Both columns use the index: tenant_id pins the equality, created_at does the range scan
EXPLAIN (COSTS OFF) SELECT * FROM events
WHERE tenant_id = 3 AND created_at > now() - interval '1 hour';
-- Index Scan using ev_tenant_created on events
--   Index Cond: ((tenant_id = 3) AND (created_at > (now() - '01:00:00'::interval)))
```

Counter-example: if you put the range column first and build `(created_at, tenant_id)`, the same query can only use the single `created_at` condition (and it matches a huge number of rows), and the `tenant_id` filter degrades to a heap fetch.

## Covering ORDER BY: Eliminating the Sort Node

The index is itself ordered, so a query with "equality condition + sort by a later column" can read directly in index order and skip the explicit sort:

```sql
EXPLAIN (COSTS OFF) SELECT * FROM events
WHERE tenant_id = 3 ORDER BY created_at DESC LIMIT 20;
-- Limit
--   ->  Index Scan Backward using ev_tenant_created on events
--         Index Cond: (tenant_id = 3)
```

This shape matters a lot for pagination queries: `LIMIT 20` stops after reading 20 index entries, whereas a plan that scans and then `Sort`s must process every matching row. For pagination patterns, see [Pagination and Sorting](../advanced-sql/pagination-and-sorting).

Two additions:

- Mixed sort directions (such as `ORDER BY created_at ASC, status DESC`) require the index columns to be declared in the same directions (`CREATE INDEX ... (created_at ASC, status DESC)`).
- When the sort keys do not exactly match the index order, PG 13+ can use **Incremental Sort** (it exploits the prefix that the index has already ordered and sorts only the remainder), which is far cheaper than a full Sort:

```sql
EXPLAIN (COSTS OFF) SELECT * FROM events
WHERE tenant_id = 3 ORDER BY created_at, status LIMIT 20;
-- Limit
--   ->  Incremental Sort
--         Sort Key: created_at, status
--         Presorted Key: created_at          -- the index already guarantees created_at order
--         ->  Index Scan using ev_tenant_created on events
```

## INCLUDE Columns: Stored in the Index but Not Part of the Key Order (PG 11+)

`INCLUDE` shoves extra columns into the index leaf pages, but they **do not participate in key sorting or constraints**. The use is covering indexes: if every column the query needs is already in the index, there is no heap fetch (Index Only Scan):

```sql
CREATE INDEX ev_tenant_inc_status ON events (tenant_id) INCLUDE (status);
VACUUM (ANALYZE) events;    -- Index Only Scan needs the visibility map to be up to date

EXPLAIN (COSTS OFF) SELECT tenant_id, status FROM events WHERE tenant_id = 3;
-- Index Only Scan using ev_tenant_inc_status on events
--   Index Cond: (tenant_id = 3)
```

`\d` shows that INCLUDE columns are not keys:

```plaintext
 Index "public.ev_tenant_inc_status"
  Column   |  Type   | Key? | Definition
-----------+---------+------+------------
 tenant_id | integer | yes  | tenant_id
 status    | text    | no   | status
btree, for table "public.events"
```

Difference between INCLUDE columns and key columns: key columns participate in sorting and leftmost prefix matching, INCLUDE columns do not. Both can be read by an Index Only Scan. `UNIQUE (a) INCLUDE (b)` means "require only that a is unique, but carry b along for covering queries" — something a plain `UNIQUE (a, b)` cannot do. The cost is a larger index and slower writes, so put only columns that are "needed by high-frequency queries but you do not want in the key" into INCLUDE.

## Index Skip Scan: PostgreSQL Does Not Have It

`(tenant_id, created_at)` cannot serve a query that filters on `created_at` only, and PostgreSQL (as of 17) **does not implement index skip scan**: it will not automatically enumerate the values of tenant_id to reuse the index in segments.

Workable alternatives:

1. **Put the list of tenant_id values in the query**. An `IN` list expands into multiple segment scans over the index:

```sql
EXPLAIN (COSTS OFF) SELECT count(*) FROM events
WHERE tenant_id IN (1, 2, 3) AND created_at > now() - interval '1 hour';
-- Bitmap Heap Scan on events
--   ->  Bitmap Index Scan on ev_tenant_created
--         Index Cond: ((tenant_id = ANY ('{1,2,3}'::integer[]))
--                      AND (created_at > (now() - '01:00:00'::interval)))
```

2. **Build a partial index for a leading column with few, fixed values**, such as `CREATE INDEX ... WHERE tenant_id = 1`, see [Partial Indexes](./partial-indexes).
3. **Partition by the leading column**, so each partition's own index contains only the later column(s), see [Partition Table Design](../database-design/table-inheritance-and-partitioning-design).

## Redundant Index Detection: Duplicate Left Prefix

If the table has both `(tenant_id)` and `(tenant_id, created_at)`, the former is redundant — any query that can use the former can use the latter, but it wastes space and slows writes. How to find them: look for the combination where "one index's key columns are exactly the left prefix of another index's key columns":

```sql
SELECT pa.indexrelid::regclass AS redundant_index,
       pb.indexrelid::regclass AS keeping_index
FROM pg_index pa
JOIN pg_index pb
  ON  pb.indrelid = pa.indrelid
  AND pb.indexrelid <> pa.indexrelid
  AND (pb.indkey::int2[])[0:pa.indnkeyatts-1] = (pa.indkey::int2[])[0:pa.indnkeyatts-1]
  AND pb.indnkeyatts > pa.indnkeyatts
  AND (NOT pa.indisunique OR pb.indisunique)
WHERE pa.indisprimary = false;
-- redundant_index | keeping_index
-- -----------------+------------------
-- ev_tenant_only   | ev_tenant_created
```

Before dropping, confirm that no query depends on its special properties (such as uniqueness, or the maintenance benefit that comes from its smaller size). For quantifying index size and maintenance cost, see [Index Bloat and Maintenance](./index-bloat-and-maintenance).

## Composite Index vs. Several Single-Column Indexes

| Scenario | Recommendation |
| --- | --- |
| Queries are always `WHERE a = ? AND b > ?` or with `ORDER BY` | One composite index `(a, b)` |
| Queries filter on a only or b only, each with high traffic | Two single-column indexes |
| Queries filter on a or b but every combined condition has a high hit rate | Composite index + one single-column index if needed |
| Multiple single-column indexes are all usable | The optimizer can merge bitmaps with BitmapAnd, but at the cost of two extra index scans and bitmap-merging overhead versus a single composite index |

Rule of thumb: **one composite index covers one high-frequency query shape**. Rather than building an index for every combination of conditions, let the most frequent shape use the optimal index and let the low-frequency shapes degrade to a wider index scan or a sequential scan — the impact of index count on write throughput is linear, see [Write Throughput Optimization](../performance/write-throughput-optimization).

## References

- [PostgreSQL Official Documentation · Chapter 11. Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL Official Documentation · 11.2. Index Types](https://www.postgresql.org/docs/current/indexes-types.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [B-tree Structure and Principles](./btree-structure)
- [Partial Indexes](./partial-indexes)
- [Index Failures and Misuse](./index-failure-and-misuse)
- [Reading EXPLAIN](../performance/explain-basics)
- [lateral-and-from-subquery](/advanced-sql/lateral-and-from-subquery.md)
- [pagination-and-sorting](/advanced-sql/pagination-and-sorting.md)
- [anti-patterns](/database-design/anti-patterns.md)
- [logical-to-physical-modeling](/database-design/logical-to-physical-modeling.md)
- [btree-structure](btree-structure.md)
- [index-only-scans](index-only-scans.md)
- [index-selection-decision-tree](index-selection-decision-tree.md)
- [index](index.md)
- [join-implementations](/internals/join-implementations.md)
- [vacuum-and-hot](/internals/vacuum-and-hot.md)
- [common-bad-plans](/performance/common-bad-plans.md)
- [slow-query-governance](/performance/slow-query-governance.md)
- [real-world-cases](/tools/real-world-cases.md)
