# A Slow Query Governance Workflow

Informally "feeling it is slow and tuning it a bit" does not solve long-term problems; slow query governance needs a fixed pipeline: collect → reproduce → locate → rewrite → verify. This page walks one complete case through all five steps: taking a product order list SQL from 1.8 seconds in production down to 0.2 milliseconds. Tool details live in [EXPLAIN (ANALYZE, BUFFERS, WAL)](./explain-analyze-buffers) and [pg_stat_statements](./pg-stat-statements); this page focuses on the workflow itself.

## Step 1: Collect — Find the SQL Worth Governing

Two collection sources complement each other: logs catch the scene of a "single slow call", pg_stat_statements catches the "cumulatively expensive" regulars.

```sql
-- postgresql.conf: log statements over 500ms (adjust as needed; 0 logs all, -1 disables)
-- log_min_duration_statement = 500
```

```sql
-- pull the regulars with the highest average time from pg_stat_statements
SELECT calls,
       round(mean_exec_time::numeric, 1) AS mean_ms,
       round(total_exec_time::numeric / 1000, 1) AS total_s,
       left(query, 90) AS query
FROM pg_stat_statements
WHERE calls > 100
ORDER BY mean_exec_time DESC
LIMIT 10;
```

The case starts here: number three on the list is `SELECT ... FROM orders WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT $3`, with mean_exec_time 1813ms and about 4000 calls per hour. Slow-but-low-frequency statements deserve fixing too, just at a different priority—total time affects the database as a whole, average time affects what users feel.

## Step 2: Reproduce — Production Parameters + EXPLAIN ANALYZE

Get the real parameters (grab one actual call from the application logs or `pg_stat_activity`) and run it on data at production scale:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT order_id, amount, status, created_at
FROM orders
WHERE user_id = 40021 AND status = 'paid'
ORDER BY created_at DESC
LIMIT 20;
```

Choosing a reproduction environment: prefer a production read replica (read statements have no side effects); without a replica, use a staging environment restored to production data volume. Note that cache warmth can move results by orders of magnitude—run one warm-up, then take the second run's numbers; a parameter like `user_id = 40021` must be a real value, since hot users and cold users can get entirely different plans.

## Step 3: Locate — Bad Node, Bad Estimate, Missing Index

The reproduction output is your entire basis for diagnosis:

```plaintext
Limit (actual time=1798.512..1798.528 rows=20 loops=1)
  Buffers: shared hit=8824
  ->  Sort (actual time=1798.509..1798.514 rows=20 loops=1)
        Sort Key: created_at DESC
        Sort Method: top-N heapsort  Memory: 26kB
        ->  Seq Scan on orders
              (cost=0.00..38833.00 rows=1 width=34)
              (actual time=0.014..1560.201 rows=31852 loops=1)
              Filter: ((user_id = 40021) AND (status = 'paid'::text))
              Rows Removed by Filter: 968148
              Buffers: shared hit=8824
```

All three bad signals are present:

- **Seq Scan on a large table**: the million rows are fully scanned, `Rows Removed by Filter: 968148`—96.8% of the scan was wasted work.
- **Bad estimate**: estimated rows=1, actual 31852 rows, five orders of magnitude apart (the table was bulk-imported and never ANALYZEd).
- **Sort after the scan**: over 30,000 rows are fetched and then top-N heapsorted; if an index could hand back `created_at DESC` order directly, the sort disappears entirely.

Against the pattern list in [Common Bad Plans](./common-bad-plans), this case is "missing index + stale statistics" stacked together, with the missing index being the primary cause.

## Step 4: Rewrite — Index, SQL, Structure

This case does not need the SQL changed—the statement is written sensibly and the problem is in the access path. Design the composite index as "equality conditions first, sort key after":

```sql
CREATE INDEX CONCURRENTLY orders_user_status_created_idx
    ON orders (user_id, status, created_at DESC);
```

`CONCURRENTLY` avoids locking writers; use it for production index builds (note that a failure leaves an INVALID index behind, which you must drop and rebuild). Reasoning about column order: `user_id` and `status` are both equality conditions, so either order works; `created_at` last hands back exactly the `ORDER BY created_at DESC` sequence, so the whole plan degrades to scanning the first few rows of the index. If `status='paid'` is a very small share and this combination is a fixed query, you can also consider a partial index `WHERE status = 'paid'`—see [Partial Indexes](../indexing/partial-indexes) and [Composite Index Design](../indexing/composite-index-design). While you are at it, close the stale-statistics gap:

```sql
ANALYZE orders;
```

## Step 5: Verify A/B — Before/After Comparison and Regression

Run the same EXPLAIN command again and compare it item by item against the Step 2 output:

```plaintext
Limit (actual time=0.198..0.206 rows=20 loops=1)
  Buffers: shared hit=5
  ->  Index Scan using orders_user_status_created_idx on orders
        (actual time=0.193..0.199 rows=20 loops=1)
        Index Cond: ((user_id = 40021) AND (status = 'paid'::text))
        Buffers: shared hit=5
```

The comparison: no Sort node, `Rows Removed by Filter` gone, Buffers down from 8824 to 5, time 1798ms → 0.2ms. Work through the verification checklist in order:

1. **Performance comparison**: archive the before/after `(ANALYZE, BUFFERS)` outputs side by side, with one set on a cold cache and one on a warm cache.
2. **Result regression**: any rewritten SQL must have its result set compared (row counts, sampled rows, aggregate values); even index-only changes should confirm the sorted results match the original.
3. **Production confirmation**: the next day check that this statement's mean_exec_time and temp_blks_written in pg_stat_statements have gone to zero, and that load metrics (IO, CPU) have dropped back.

## Establishing a Baseline and Ongoing Tracking

Governance is not one-shot. Leave behind three artifacts so the next round has something to stand on:

- **Baseline snapshot**: weekly, snapshot the top 20 statements' calls/mean_exec_time/total_exec_time into your own table, and use the deltas to spot degradation trends.
- **Alert thresholds**: `log_min_duration_statement` keeps a floor under single slow queries; for top-list statements set a period-over-period threshold on mean_exec_time and alert on sudden changes. For rule design see [Monitoring and Alerting](../operations/monitoring-and-alerting).
- **Plan archive**: keep one `(ANALYZE, BUFFERS)` plan per core SQL, and diff it before/after major version upgrades or statistics parameter changes to catch plans silently flipping. auto_explain (`auto_explain.log_min_duration`) can automatically log the real plan of any statement that exceeds the threshold.

After each governance pass, record "symptom → diagnosis → fix" into the team case library, so the second time a similar problem appears it can be applied directly.

## Caveats and Common Pitfalls

- Skipping reproduction and fixing straight in a test environment: the test table has a few hundred rows, so the plan is entirely different from production and the conclusion is unreliable.
- Reproducing without real parameters: parameters that happen to be estimated correctly will mask parameter-sensitive problems; try both hot values and cold ones.
- Changing several things at once then verifying: you cannot say which change took effect, and they may even cancel each other out; change one, verify one is a discipline.
- Looking only at elapsed time: time varies a lot with cache state, while Buffers and row counts are stable evidence; take a median of several runs for timing too.
- Running result regression only on a test database: for rewritten SQL the result set regression must run on a database with comparable data volume—a row count mismatch means the semantics changed.

## References

- [PostgreSQL Official Documentation · 14.1. Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)
- [PostgreSQL Official Documentation · Chapter 14. Performance Tips](https://www.postgresql.org/docs/current/performance-tips.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [pg_stat_statements](./pg-stat-statements)
- [EXPLAIN (ANALYZE, BUFFERS, WAL)](./explain-analyze-buffers)
- [Common Bad Plans](./common-bad-plans)
- [Connection and ORM Optimization](./connection-and-orm-optimization)
- [pagination-and-sorting](/advanced-sql/pagination-and-sorting.md)
- [connection-and-orm-optimization](connection-and-orm-optimization.md)
- [index](index.md)
- [lock-and-concurrency-bottlenecks](lock-and-concurrency-bottlenecks.md)
- [pg-stat-statements](pg-stat-statements.md)
- [troubleshooting-toolbox](/tools/troubleshooting-toolbox.md)
Official docs: [Performance Tips](https://www.postgresql.org/docs/current/performance-tips.html), [auto_explain](https://www.postgresql.org/docs/current/auto-explain.html).
