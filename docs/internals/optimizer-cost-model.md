# The Optimizer Cost Model

The same SQL often has several ways to execute, and the planner uses a single currency, cost, to price every candidate plan and pick the cheapest. cost is not milliseconds, it's a set of weighted estimates; as long as the ratios are trustworthy, the chosen plan is the right one. Understanding the cost model's two inputs — cost parameters and statistics — is what lets you know where the rows and cost in EXPLAIN come from, why they can be wrong, and how to fix them when they are. Official reference: [Query Planning](https://www.postgresql.org/docs/current/planner-stats.html).

## Cost Units and Defaults

All costs are relative units, with the default setting a sequential read of one page (8KB) to 1.0:

| Parameter | Default | Meaning |
| --- | --- | --- |
| seq_page_cost | 1.0 | baseline cost for reading one page sequentially |
| random_page_cost | 4.0 | reading one page randomly, 4x more expensive than sequential; often tuned to 1.1~2.0 on SSDs |
| cpu_tuple_cost | 0.01 | CPU cost to process one row (projection, filtering) |
| cpu_index_tuple_cost | 0.005 | processing one index entry in an index scan |
| cpu_operator_cost | 0.0025 | computing one operator or function |
| parallel_setup_cost | 1000 | overhead of starting one parallel scan |
| parallel_tuple_cost | 0.1 | cost of sending one tuple from a worker back to the leader |

The `cost=0.42..42.17` in EXPLAIN output is `[startup cost..total cost]`: startup cost is the part you must pay before emitting the first row — Sort has to consume all input so its startup cost is high, Index Scan is nearly 0. LIMIT-style queries compare "startup cost + running cost of going N rows", which is exactly why small LIMITs often pick index scans.

## Where the rows Estimate Comes From: pg_statistic

Row-count estimates are the multiplier for every cost calculation; the data comes from pg_statistic (the human-readable version is the pg_stats view), maintained by ANALYZE sampling — by default it samples 300 × statistics_target rows (about 30,000 sample rows when target=100):

```sql
SELECT attname, n_distinct,
       most_common_vals,     -- MCV: most common values
       most_common_freqs,    -- frequency corresponding to the MCVs
       histogram_bounds,     -- histogram: distribution buckets for non-MCV values
       correlation           -- correlation between physical storage order and index order
FROM   pg_stats
WHERE  tablename = 'orders' AND attname = 'status';
```

- **MCV + frequency**: equality conditions like `status = 'paid'` are estimated directly by frequency.
- **Histogram**: range conditions like `amount < 1000` are interpolated by bucket.
- **correlation**: determines the random-page cost discount for Index Scan — the closer the data is physically to index order, the cheaper the index scan.
- **n_distinct**: cardinality estimates for GROUP BY / JOIN; a negative value means a proportion (-0.3 means 30% of rows are distinct from each other).

## Composite Column Statistics: CREATE STATISTICS (PG 10+)

The planner assumes by default that columns are independent, and composite conditions on correlated columns get miscalculated by multiplication:

```sql
CREATE STATISTICS st_orders_city_district (dependencies, ndistinct)
  ON city, district FROM orders;
ANALYZE orders;
```

- `dependencies` (PG 10+): functional dependencies, correcting the underestimation caused by "after the first condition filters, the second condition no longer narrows the range".
- `mcv` (PG 12+): the MCV list for composite columns, correcting estimates of high-frequency combinations.
- Expression statistics of the `CREATE STATISTICS ON (lower(email))` form are supported since PG 14.
- Observation views: pg_stats_ext, pg_stats_ext_exprs.

## The Typical Chain of Estimate Wrong → Plan Wrong

Underestimating join result row count is the most common way to fall over:

```plaintext
rows estimated as 100 (actually 1 million)
  → assume the inner table is only probed 100 times
  → choose Nested Loop + Index Scan
  → actually probed 1 million times, each with random IO
  → the plan "correctly" picks a disaster
```

The reverse holds too: overestimating row count makes the optimizer abandon the index in favor of a full-table scan or Hash Join. The way to localize the problem is to compare estimated rows with actual rows in `EXPLAIN ANALYZE` — if the deviation exceeds an order of magnitude, fix the statistics first (ANALYZE, raise that column's statistics target, add extended statistics) rather than tuning parameters, see [Statistics and ANALYZE](../performance/statistics-and-analyze) and [Common Bad Plans](../performance/common-bad-plans).

## Cost Is Not Execution Time: Only Ratios Are Trustworthy

- cost is only for comparing plans **under the same optimizer and the same set of parameters**; costs across different versions or different parameters cannot be compared across databases, and certainly must not be converted into milliseconds.
- But ratios are basically trustworthy: on the same machine with the same parameters, a plan with 2x cost is usually about 2x slower — provided the rows estimate is correct.
- `random_page_cost` is strongly tied to hardware: 4.0 is reasonable on HDD, and should be lowered on SSD/NVMe (commonly 1.1~2.0), otherwise the optimizer will systematically underestimate the competitiveness of index scans; `effective_cache_size` likewise should truthfully reflect memory.
- Execution time also layers in factors beyond the cost model: cache hit rate, concurrency contention, JIT, network transfer.

## Adjusting Statistical Precision

```sql
SHOW default_statistics_target;   -- 100

-- Tune up globally: more accurate sampling, but slower ANALYZE and a larger pg_statistic
ALTER SYSTEM SET default_statistics_target = 200;
SELECT pg_reload_conf();

-- Recommended: only tune up key columns
ALTER TABLE orders ALTER COLUMN customer_id SET STATISTICS 500;
ANALYZE orders;
```

Rule of thumb: columns appearing on high-frequency WHERE / JOIN / GROUP BY paths, and columns with highly skewed data, are worth a higher target; low-cardinality uniformly distributed columns (like a status field) can stay at the default. Raising target does not change plan logic, it just makes histograms and MCVs finer-grained.

## Notes and Common Pitfalls

- **New table never ANALYZEd**: pg_statistic is empty, and the planner estimates with a fixed default row count, so plans go randomly off the rails; run ANALYZE manually after bulk imports.
- **Expression columns have no statistics**: forms like `lower(email)`, `data->>'city'` only get coarse default estimates unless you create an expression index or expression statistics.
- **enable_xxx switches are not a tuning tool**: they only "push a certain class of plans to unacceptable" for debugging; in production you should tune cost parameters, statistics, and indexes, see [Join Implementations](./join-implementations).
- **pg_statistic requires privilege to read**: ordinary users can just query the pg_stats view, and only see tables they have permission on.
- Statistics **do not update automatically and immediately** after changes: the autovacuum analyze trigger threshold (`autovacuum_analyze_scale_factor`) means on large tables "only analyzed after millions of rows changed"; key tables need scheduled jobs.

## References

- [PostgreSQL Official Docs · 19.7. Query Planning](https://www.postgresql.org/docs/current/runtime-config-query.html)
- [PostgreSQL Official Docs · Chapter 51. Overview of PostgreSQL Internals](https://www.postgresql.org/docs/current/overview.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Statistics and ANALYZE](../performance/statistics-and-analyze)
- [EXPLAIN Basics](../performance/explain-basics)
- [Join Implementations](./join-implementations)
- [Common Bad Plans](../performance/common-bad-plans)
- [index](index.md)
- [join-implementations](join-implementations.md)
- [parallel-query](parallel-query.md)
- [plan-cache-and-generic-plan](plan-cache-and-generic-plan.md)
- [query-execution-pipeline](query-execution-pipeline.md)
- [knowledge](/knowledge.md)
- [common-bad-plans](/performance/common-bad-plans.md)
- [explain-analyze-buffers](/performance/explain-analyze-buffers.md)
- [explain-basics](/performance/explain-basics.md)
- [parameter-tuning](/performance/parameter-tuning.md)
- [statistics-and-analyze](/performance/statistics-and-analyze.md)
Official docs reference: [Planner Cost Constants](https://www.postgresql.org/docs/current/runtime-config-query.html)
