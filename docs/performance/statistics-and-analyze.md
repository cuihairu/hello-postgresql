# Statistics and ANALYZE

Every rows estimate the optimizer makes comes from statistics: how many rows each table has, how many distinct values each column holds, which values are most common, and which ranges the distribution falls into. `ANALYZE` generates these numbers by sampling, and the root cause of the vast majority of bad plans traces back to "stale statistics" or "insufficient statistics granularity". This page covers what the statistics consist of, when autovacuum versus manual ANALYZE trigger, how to control sampling granularity, and how to read the data distribution as the optimizer sees it from `pg_stats`.

## What Is in the Statistics

`ANALYZE` writes its sampling results into the system catalog `pg_statistic` (readable directly only by superusers); day-to-day you use the view `pg_stats`:

```sql
SELECT attname, n_distinct,
       most_common_vals::text   AS mcv,
       most_common_freqs::text  AS freqs,
       correlation
FROM pg_stats
WHERE schemaname = 'public' AND tablename = 'orders'
  AND attname = 'status';
```

```plaintext
-[ RECORD 1 ]------------------------------------------------
attname     | status
n_distinct  | 4
mcv         | {done,paid,pending,canceled}
freqs       | {0.2603,0.2498,0.2451,0.2448}
correlation | 0.0012
```

Four kinds of core data determine how estimates are made:

- **n_distinct**: the number of distinct values. A negative value means a fraction of total rows (-0.3 means about 30% of rows are mutually distinct); the optimizer uses it to estimate selectivity of equality conditions.
- **MCV (most_common_vals / most_common_freqs)**: the most common values and their frequencies. The estimate for `WHERE status = 'paid'` comes straight from here: 0.2498 × 1 million ≈ 249,800 rows.
- **Histogram (histogram_bounds)**: buckets the non-MCV values into equal row counts. The estimate for a range condition `created_at < X` is which bucket X falls into and what share of a bucket it occupies.
- **correlation**: how closely physical storage order matches logical order; it affects how the optimizer prices the random IO of a range scan.

The histogram looks like this:

```sql
SELECT histogram_bounds::text FROM pg_stats
WHERE tablename = 'orders' AND attname = 'user_id';
```

```plaintext
{1,1042,2076,3120,4187,5243, ... ,98771,99912}
```

A million rows are cut into 100 buckets (at the default target), roughly 10,000 rows each; the estimate for `user_id < 5000` is just counting how many bucket boundaries precede 5000, about 5%.

## How Sampling Works and How Much It Samples

ANALYZE randomly picks `300 × statistics_target` rows (default target=100, so 30,000 rows)—not a full table scan—so a single table usually finishes in seconds. Add `VERBOSE` to watch the sampling:

```sql
ANALYZE VERBOSE orders;
```

```plaintext
INFO:  analyzing "public.orders"
INFO:  "orders": scanned 10000 of 10000 pages, containing 1000000 live rows
        and 0 dead rows; 30000 rows in sample, 1000000 estimated total rows
ANALYZE
```

Sampling means estimates carry inherent error: for long-tail values that never appear in the sample, the optimizer can only guess from a heuristic formula. For columns with skewed or long-tail-sensitive distributions, you have to move the target (see below).

## autovacuum's Incidental ANALYZE and Its Thresholds

Besides reclaiming dead tuples, autovacuum also refreshes statistics: once a table's change volume (accumulated insert/update/delete) crosses a threshold, an analyze triggers. The threshold formula:

```plaintext
autovacuum_analyze_threshold + autovacuum_analyze_scale_factor × table row count
```

The default is `50 + 0.1 × row count`: a ten-thousand-row table triggers after 1,050 changes, while a million-row table needs 100,050 changes—the default threshold is clearly too blunt for large tables. Tighten it per table for hot, large ones:

```sql
ALTER TABLE orders SET (
    autovacuum_analyze_scale_factor = 0.02,
    autovacuum_analyze_threshold = 1000
);
```

Now about 21,000 changes refresh the statistics. This assumes `track_counts = on` (on by default) and that the autovacuum processes are running; for the mechanics and overall tuning see [autovacuum Tuning](../internals/autovacuum-tuning) and [VACUUM and HOT](../internals/vacuum-and-hot).

## Manual ANALYZE and When

autovacuum triggers with a delay; a few scenarios demand doing it by hand:

```sql
-- after a bulk import / mass DELETE/UPDATE: mandatory
COPY orders FROM '/path/orders.csv' WITH (FORMAT csv);
ANALYZE orders;

-- refresh just a few columns
ANALYZE orders (user_id, status);

-- whole-database refresh (tables in parallel stages, quickly builds a baseline)
vacuumdb --analyze-in-stages -d appdb;
```

`--analyze-in-stages` is especially useful after pg_upgrade or restoring a logical backup: it first gets coarse statistics onto the system catalogs and frequently queried columns at minimal cost, so you are not immediately slapped by terrible plans right after recovery. In routine operations, "ANALYZE after every import" should be a fixed step in the data pipeline.

## default_statistics_target and Per-Column SET STATISTICS

`default_statistics_target` (default 100) controls two things: the number of rows sampled (300 × target) and the number of histogram buckets (target). Raising it globally affects every table; the more precise approach is per-column:

```sql
-- user_id has 100,000 distinct values; the default 100 buckets are too coarse
ALTER TABLE orders ALTER COLUMN user_id SET STATISTICS 500;
ANALYZE orders (user_id);
```

When to raise it: range-query row estimates are clearly off, histogram buckets are too sparse, or a JOIN key's n_distinct is misestimated. When not to bother: low-cardinality columns like booleans and status flags—100 buckets are more than enough. One more layer of tooling is extended statistics, aimed at the "two correlated columns break the independence assumption" case (city versus postcode, say), see `CREATE STATISTICS` (https://www.postgresql.org/docs/current/sql-createstatistics.html).

## Symptoms of Stale Statistics

Stale statistics have one highly recognizable symptom: **estimated 1 row (or a few), actual tens of thousands**. Because the statistics date from the empty-table era, n_distinct runs high, MCV is empty, and equality conditions get estimated as "almost no matches". Self-check query:

```sql
-- find large tables whose statistics have not been refreshed in a long time
SELECT relname, n_live_tup,
       last_analyze, last_autoanalyze, last_analyze_time, last_autoanalyze_time
FROM pg_stat_user_tables
WHERE n_live_tup > 100000
  AND coalesce(last_autoanalyze, last_analyze) < now() - interval '1 day';
```

Accompanying symptoms: execution time wildly out of proportion to cost, a huge `Rows Removed by Filter` in the plan, and the same SQL flipping its plan right after an autoanalyze. When you hit "it was fine yesterday, suddenly slow today", first check the statistics refresh timeline, then the data import logs—the worked example is in [Common Bad Plans](./common-bad-plans).

## The Trade-off of Bigger Samples

The gain from a bigger target is more accurate estimates: finer histogram buckets, long-tail values more likely to enter MCV, more stable n_distinct inference. The costs are threefold: ANALYZE time and sampled rows grow linearly (target 1000 means a 300,000-row sample); `pg_statistic` gets bigger; and the planner gets slightly slower at selectivity math. Practical advice:

- The default 100 covers the vast majority of columns; do not double it globally "just in case";
- For columns that have shown estimation drift, set 200-1000 per column, and verify with `ANALYZE <column>` that the estimate converges;
- Tables with stable distributions (historical partitions partitioned by month, say) do not need a high target; tables with actively written new data do.

The deciding criterion is always behavioral evidence: the estimated-versus-actual ratio in `EXPLAIN`. Tuning sampling without evidence just buys reassurance at the price of longer ANALYZE runs.

## Caveats and Common Pitfalls

- `ANALYZE` only refreshes statistics, it **does not reclaim dead tuples**—it is not a substitute for `VACUUM`, and the two are often confused.
- Statistics are not synced across instances: a logical replication subscriber and a freshly restored instance each need their own ANALYZE run.
- Sampling is random, so two ANALYZE runs can produce different plans; estimate confidence depends on sample size—that is exactly why large targets exist.
- Queries on expressions (like `lower(email)`) rely on the statistics that come with an expression index; plain column statistics cannot help.
- For staging tables that are TRUNCATEd and reloaded frequently, autovacuum may never trigger an analyze (row count drops to zero then climbs back)—put manual ANALYZE for such tables into the import procedure.

## References

- [PostgreSQL Official Documentation · PostgreSQL: Not Found](https://www.postgresql.org/docs/current/sql-createstatistics.html)
- [PostgreSQL Official Documentation · 14.1. Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Reading EXPLAIN](./explain-basics)
- [Common Bad Plans](./common-bad-plans)
- [Optimizer Cost Model](../internals/optimizer-cost-model)
- [autovacuum Tuning](../internals/autovacuum-tuning)
- [materialized-views](/database-design/materialized-views.md)
- [fdw-and-foreign-data](/ecosystem/fdw-and-foreign-data.md)
- [btree-structure](/indexing/btree-structure.md)
- [index-failure-and-misuse](/indexing/index-failure-and-misuse.md)
- [optimizer-cost-model](/internals/optimizer-cost-model.md)
- [plan-cache-and-generic-plan](/internals/plan-cache-and-generic-plan.md)
- [knowledge](/knowledge.md)
- [common-bad-plans](common-bad-plans.md)
- [explain-analyze-buffers](explain-analyze-buffers.md)
- [explain-basics](explain-basics.md)
- [index](index.md)
Official docs: [Planner Statistics](https://www.postgresql.org/docs/current/planner-stats.html), [Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html).
