# Common Bad Plans

Almost every slow query falls into a handful of bad plan shapes: it should have used an index but did a sequential scan, a bad estimate made it pick the wrong join, the Nested Loop outer side blew up, the sort spilled to disk, or DISTINCT and ORDER BY each sort once. This page collects the plan signature, cause, and fix for each class, and closes with a "diagnose → fix → re-verify" three-step loop. All examples are based on the users/orders tables from [Reading EXPLAIN](./explain-basics).

## Seq Scan on a Large Table

Plan signature: a `Seq Scan` on a million-row table with a huge `Rows Removed by Filter`. Three common causes and their fixes:

```sql
-- Cause 1: no index on the filter column at all → build one
EXPLAIN ANALYZE SELECT * FROM orders WHERE user_id = 42;

-- Cause 2: a function wraps the indexed column, so a plain index cannot be used → rewrite as a range condition, or build an expression index
EXPLAIN ANALYZE SELECT count(*) FROM orders
WHERE date(created_at) = current_date;                  -- Seq Scan
EXPLAIN ANALYZE SELECT count(*) FROM orders
WHERE created_at >= current_date
  AND created_at < current_date + interval '1 day';     -- uses the index if created_at is indexed

-- Cause 3: stale statistics, the optimizer thinks many rows match → run ANALYZE
ANALYZE orders;
EXPLAIN SELECT * FROM orders WHERE status = 'paid';
```

Note: not every Seq Scan is a bad plan—when you need more than about 10% of the table, a sequential scan is often faster than an index. The test is whether "scan cost" matches "the number of rows you actually need", not the node name itself. The full list of cases where a function wrap defeats an index is in [Index Failure and Misuse](../indexing/index-failure-and-misuse).

## rows Misestimated: Estimated 1, Actual 100,000

Classic script: a table is bulk-loaded by a script, `ANALYZE` runs once before the load (when the table is nearly empty), and never again afterward. The optimizer estimates 1 row for `status = 'paid'`, so it picks a Nested Loop, but 250,000 rows actually have to be processed:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT o.order_id, u.name
FROM orders o JOIN users u ON u.user_id = o.user_id
WHERE o.status = 'paid';
```

```plaintext
Nested Loop (cost=0.42..233.10 rows=1 width=24)
            (actual time=0.062..41883.224 rows=250010 loops=1)
  ->  Seq Scan on orders o (cost=0.00..224.75 rows=1 width=16)
        Filter: (status = 'paid'::text)
        Rows Removed by Filter: 999999
  ->  Index Scan using users_pkey on users u (cost=0.42..8.44 rows=1 width=8)
        Index Cond: (user_id = o.user_id)
```

Three mismatches clinch the diagnosis: estimated rows=1, actual rows=250010; `Rows Removed by Filter` close to the whole table; execution time orders of magnitude above cost. The fix is one step:

```sql
ANALYZE orders;
```

After the statistics refresh, the same query becomes a Hash Join (estimated 250,000, actual 250,000), and the time drops from tens of seconds to a few hundred milliseconds. Why estimates go wrong and how to make them right: see [Statistics and ANALYZE](./statistics-and-analyze); the pricing mechanics behind it: [Optimizer Cost Model](../internals/optimizer-cost-model).

## Nested Loop Explosion from a Large Outer Side

Total Nested Loop cost ≈ outer rows × per-lookup cost of the inner side. It is the best choice while the outer side is only a few rows, but it scales linearly once the outer side grows:

```plaintext
Nested Loop (actual time=0.048..2380.441 rows=500010 loops=1)
  ->  Index Scan using users_region_idx on users u
        (cost=0.42..8.45 rows=1 width=16)
        (actual time=0.031..45.203 rows=50000 loops=1)     -- estimated 1, actual 50,000
        Index Cond: (region = 'north')
  ->  Index Scan using orders_user_id_idx on orders o
        (cost=0.00..8.12 rows=10 width=16)
        (actual time=0.001..0.045 rows=10.0 loops=50000)   -- 50,000 index probes
        Index Cond: (user_id = u.user_id)
        Buffers: shared hit=350214
```

Recognition points: the inner node's `loops` is in the five digits, and `Buffers` reaches hundreds of thousands. The cause is usually a misestimate on the outer side (estimated 1, actual 50,000 in the example above), or data growth invalidating an old "small outer side" assumption. Fix order: refresh statistics first to restore estimate accuracy—once the estimate is correct the optimizer switches to a Hash Join on its own; if a Nested Loop is genuinely required (the outer side is bound to be small, say), confirm the inner join column is indexed and the queried columns can use an Index Only Scan. And remember actual time must be multiplied by loops—0.045 ms × 50000 ≈ 2.2 seconds.

## Sort Spilling to Disk

Plan signature:

```plaintext
Sort (cost=92314.83..94814.83 rows=1000000 width=46)
     (actual time=998.311..1120.455 rows=1000000 loops=1)
  Sort Key: created_at
  Sort Method: external merge  Disk: 58000kB
  Buffers: shared hit=8801, temp read=7500 written=7502
```

`external merge Disk: 58000kB` means the sort data exceeded work_mem (default 4MB): part of it went to temp files and was merged back, and speed drops by an order of magnitude. Fixes in priority order:

1. **Eliminate the sort with an index**: for a case like `ORDER BY created_at DESC LIMIT 20`, an index on `(created_at)` turns the plan directly into an Index Scan with no Sort node.
2. **Reduce the data being sorted**: fetch only the columns you need (smaller width), filter before sorting, add a LIMIT to get top-N heapsort.
3. **Raise work_mem**: the safest change is session-scoped—`SET work_mem = '64MB';` then run the query; raising it globally requires weighing concurrent connections × per-sort memory, see [Parameter Tuning](./parameter-tuning).

Related spills are HashAggregate's `Batches: N` (N>1 means the grouping spilled) and Hash Join overflow—the way to tell is the same.

## DISTINCT + ORDER BY: Two Sorts

When the dedup key and the sort key disagree, the plan shows two sorting stages (or a hash dedup plus a sort):

```sql
EXPLAIN
SELECT DISTINCT user_id, status, created_at::date AS d
FROM orders
ORDER BY d;
```

```plaintext
Sort  (cost=72833.02..73833.02 rows=400000 width=22)
      (actual time=1023.44..1101.20 rows=3600 loops=1)
  Sort Key: ((created_at)::date)
  Sort Method: external merge  Disk: 9432kB
  ->  HashAggregate  (cost=42833.00..46833.00 rows=400000 width=22)
        Group Key: user_id, status, ((created_at)::date)
        ->  Seq Scan on orders  (cost=0.00..37833.00 rows=1000000 width=22)
```

The inner stage maintains 400,000 groups for the dedup, and the outer stage then sorts everything again—both steps are expensive. The fix is to **align the sort key with the dedup key so the two steps merge into one**:

```sql
-- when the sort key is a prefix of the dedup key, one Sort does Unique + ORDER BY
SELECT DISTINCT user_id, status FROM orders ORDER BY user_id, status;
```

```plaintext
Unique  (cost=48836.94..51211.94 rows=4 width=18)
  ->  Sort  (cost=48836.94..50024.44 rows=1000000 width=18)
        Sort Key: user_id, status
```

When the business genuinely needs to sort on a non-dedup key, either accept the extra sort, or consider switching to `GROUP BY` with aggregate semantics (say, taking `min(created_at)`) to reduce the grouping cardinality.

## The Three-Step Loop: Diagnose → Fix → Re-verify

When you hit a slow query, follow a fixed rhythm and do not skip steps:

1. **Diagnose**: run `EXPLAIN (ANALYZE, BUFFERS)` once and find the node with the largest "time × loops" top-down; at the same time check each node's estimated/actual row ratio—if it exceeds an order of magnitude, make "stale statistics / skewed distribution" the prime suspect; look for `temp read/written` and huge `Rows Removed by Filter`.
2. **Fix**: change one thing at a time. Priority: refresh statistics (ANALYZE, cheapest) → add an index or rewrite the SQL so the filter/sort can be satisfied by an index → restructure the statement (turn a subquery into a JOIN, hoist the LIMIT) → only then consider parameter changes.
3. **Re-verify**: run the same command again and compare Buffers and elapsed time; confirm the result set is unchanged (an index never changes results, a SQL rewrite must have a result regression check); a day or two later use [pg_stat_statements](./pg-stat-statements) to see whether that statement's mean_exec_time actually came down.

## Caveats and Common Pitfalls

- The root cause of bad plans is usually statistics, not parameters—suspect a missing ANALYZE before you suspect configuration.
- In a test environment where a table has only a few hundred rows, the optimizer picks a Seq Scan—a sequential scan is genuinely cheaper on a small table, so do not compare a small-table plan against production.
- You added an index and the plan did not change: check for a function wrap, an implicit type cast (`user_id = '42'` on a text column), or statistics telling the optimizer the index is not worth it.
- Switches like `SET enable_seqscan = off` are only for verifying "why is the optimizer not using the index"—never leave any enable switch off in production.
- Plan jitter (fast one moment, slow the next) is often tied to generic plan / custom plan switching, see [Plan Cache and Generic Plans](../internals/plan-cache-and-generic-plan).

## References

- [PostgreSQL Official Documentation · 14.1. Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)
- [PostgreSQL Official Documentation · Chapter 14. Performance Tips](https://www.postgresql.org/docs/current/performance-tips.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [EXPLAIN (ANALYZE, BUFFERS, WAL)](./explain-analyze-buffers)
- [Statistics and ANALYZE](./statistics-and-analyze)
- [Index Failure and Misuse](../indexing/index-failure-and-misuse)
- [Composite Index Design](../indexing/composite-index-design)
- [pagination-and-sorting](/advanced-sql/pagination-and-sorting.md)
- [optimizer-cost-model](/internals/optimizer-cost-model.md)
- [explain-analyze-buffers](explain-analyze-buffers.md)
- [explain-basics](explain-basics.md)
- [index](index.md)
- [pg-stat-statements](pg-stat-statements.md)
- [slow-query-governance](slow-query-governance.md)
- [statistics-and-analyze](statistics-and-analyze.md)
Official docs: [Performance Tips](https://www.postgresql.org/docs/current/performance-tips.html), [Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html).
