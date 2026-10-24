# Materialized Views

The essential difference between a materialized view and an ordinary view: it **actually stores the query result**, so it can be indexed and analyzed like a table; the cost is that the data is only a snapshot from the moment of refresh, and must be refreshed manually (or on a schedule). Here I organize the difference between the two refresh modes, the prerequisites for concurrent refresh, refresh strategies and incremental ideas, and the scenarios where it fits.

## The Essential Difference: Materialized, Needs Refreshing

```sql
CREATE TABLE orders (
    order_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    amount     numeric(12,2) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO orders (amount, created_at) VALUES
    (100.00, now() - interval '2 days'),
    (200.00, now() - interval '2 days'),
    (50.00,  now() - interval '1 day');

-- Ordinary view: stores no data, aggregates in real time on every query
-- Materialized view: writes the result to disk as a snapshot
CREATE MATERIALIZED VIEW mv_daily_summary AS
SELECT created_at::date            AS stat_date,
       count(*)                    AS order_count,
       sum(amount)                 AS total_amount
FROM orders
GROUP BY 1
WITH DATA;

SELECT * FROM mv_daily_summary ORDER BY stat_date;

-- New orders will not appear in the snapshot until the next REFRESH
INSERT INTO orders (amount) VALUES (99.00);
SELECT order_count FROM mv_daily_summary;   -- still 3
```

`WITH NO DATA` builds an empty shell first (commonly used when loading during initialization); the default `WITH DATA` populates it as soon as it is created. For syntax, see the official documentation on [CREATE MATERIALIZED VIEW](https://www.postgresql.org/docs/current/sql-creatematerializedview.html).

## Full Refresh vs CONCURRENTLY

```sql
-- Full: reruns the underlying query and replaces it wholesale; takes an exclusive
-- lock during refresh, blocking all reads and writes
REFRESH MATERIALIZED VIEW mv_daily_summary;

-- Concurrent: generates the new data in the background, then swaps it in atomically;
-- reads are not blocked during refresh
CREATE UNIQUE INDEX mv_daily_summary_pk
    ON mv_daily_summary (stat_date);          -- prerequisite: a unique index

REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_summary;
```

The hard requirements of `CONCURRENTLY` (official documentation on [REFRESH MATERIALIZED VIEW](https://www.postgresql.org/docs/current/sql-refreshmaterializedview.html)):

- The materialized view must have at least one unique index (no WHERE clause, and no NULLs in the columns);
- It cannot run inside a transaction block; `BEGIN; REFRESH … CONCURRENTLY; COMMIT;` errors;
- Ordinary queries are unaffected during the refresh, but there are brief locks at the start and end — only a millisecond-scale pause even under heavy concurrent reads.

Using `CONCURRENTLY` without a unique index fails outright:

```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_no_index;
-- ERROR: cannot refresh materialized view "public.mv_no_index" concurrently
-- HINT: Create a unique index with no WHERE clause on one or more columns of the table.
```

The choice is straightforward: an internal refresh that tolerates a brief block uses full refresh; a dashboard or API facing online queries uses `CONCURRENTLY`. On large tables both modes recompute the entire query internally — the only difference is the lock behavior.

## Refresh Strategies and Incremental Refresh

PG natively offers only full refresh — it reruns the underlying query every time, with no native incremental materialization. Common strategies:

- **Scheduled full refresh**: when data freshness requirements are at the minute level or coarser, schedule `REFRESH` on a timer — the simplest and most reliable approach.
- **pg_cron scheduling**: register the refresh job inside the database, without relying on an external crontab:

  ```sql
  CREATE EXTENSION pg_cron;
  SELECT cron.schedule(
      'refresh-daily-summary', '30 2 * * *',
      $job$ REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_summary $job$
  );
  ```

- **A true incremental implementation via extension**: the community extension [pg_ivm](https://github.com/sraoss/pg_ivm) is based on incremental view maintenance (IVM) and updates only the affected parts when the underlying table changes.
- **Application-layer incremental**: maintain your own summary table and update the changed parts with triggers or CDC (logical replication) — this is essentially the redundant summary table described in [Normalization and Denormalization](./normalization-and-denormalization), only with the maintenance logic moved to the application side.

Rule of thumb for refresh timing: day-level or hour-level full refresh is usually enough for report data; only bring in pg_ivm or application-layer incremental when full refresh time approaches the refresh interval. Do not design for incrementality ahead of a data volume that does not exist.

## Scenarios That Suit Materialized Views

- **Reports and dashboards**: the dashboard queries the snapshot directly with millisecond-level response, instead of re-aggregating hundreds of millions of detail rows in real time.
- **Cross-database/cross-service snapshots**: pull external data to local materialization through FDW, and query the local replica.
- **Intermediate results of expensive JOINs**: freeze the result of a multi-table JOIN so several downstream queries can reuse it.
- **Aggregations that are read-heavy and write-light**: when aggregation cost far exceeds an acceptable refresh frequency, trade storage space and freshness for query time.

The unsuitable case is equally clear: you need real-time data, and aggregation itself is cheap — then an ordinary view or a well-indexed live query is the better fit, and you skip the refresh pipeline entirely.

```sql
-- A materialized view is a real table: index it, collect statistics, and
-- keep Vacuum maintenance under your own control
CREATE INDEX idx_mv_stat_date ON mv_daily_summary (stat_date);
ANALYZE mv_daily_summary;
VACUUM (ANALYZE) mv_daily_summary;
```

Two often-overlooked points: a materialized view is not `ANALYZE`d automatically, so statistics are stale after a refresh — remember to analyze manually before complex queries; and it also accumulates dead tuples (especially with `CONCURRENTLY` refresh, which uses an append-and-swap scheme). autovacuum covers materialized views, but frequently refreshed ones are worth monitoring — see [pg_stat Observation](../internals/pg-stat-observation) for the related symptoms.

## References

- [GitHub · sraoss/pg_ivm](https://github.com/sraoss/pg_ivm)
- [PostgreSQL Documentation · 5.5. Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Views and Updatable Views](./views-and-updatable-views)
- [Normalization and Denormalization](./normalization-and-denormalization)
- [FDW and Foreign Data](../ecosystem/fdw-and-foreign-data)
- [Statistics and ANALYZE](../performance/statistics-and-analyze)
- [index](index.md)
- [normalization-and-denormalization](normalization-and-denormalization.md)
- [views-and-updatable-views](views-and-updatable-views.md)
- [timescaledb](/ecosystem/timescaledb.md)
