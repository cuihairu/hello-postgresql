# BRIN Indexes

BRIN (Block Range Index) is built for very large tables: it does not create an entry per row, but groups the heap into ranges of consecutive pages (128 pages by default) and **stores only a min/max summary of the indexed column per range**. At query time it checks the summaries first: a range that cannot possibly intersect the condition is skipped entirely, and a range that might intersect is handed to the executor to filter. Its size is several orders of magnitude smaller than a B-tree, but its precision depends entirely on the physical order of the data. See the official documentation on [BRIN Indexes](https://www.postgresql.org/docs/current/brin.html).

## Size: A Difference of Several Orders of Magnitude

BRIN entry count = heap pages / pages_per_range, independent of row count. A 1M-row time-series table (about 12,500 heap pages) has only about 100 summary entries under the default configuration, and the index totals 3 pages:

```sql
CREATE TABLE brin_events (id bigint, sensor_id int, ts timestamptz);
INSERT INTO brin_events
SELECT g, g % 100, now() - (g || ' seconds')::interval   -- ts increases monotonically with insert (decreasing here)
FROM generate_series(1, 1000000) g;

CREATE INDEX brin_events_ts_idx ON brin_events USING brin (ts);
CREATE INDEX brin_events_ts_btree ON brin_events USING btree (ts);

SELECT indexrelid::regclass AS idx, pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_index WHERE indrelid = 'brin_events'::regclass ORDER BY 1;
--         idx               |  size
-- ---------------------------+--------
--  brin_events_ts_idx        | 24 kB    -- BRIN
--  brin_events_ts_btree      | 21 MB    -- B-tree, about 900x
```

Queries use a bitmap scan; the plan looks like:

```sql
EXPLAIN (COSTS OFF) SELECT count(*) FROM brin_events WHERE ts > now() - interval '10 minutes';
-- Aggregate
--   ->  Bitmap Heap Scan on brin_events
--         Recheck Cond: (ts > (now() - '00:10:00'::interval))
--         ->  Bitmap Index Scan on brin_events_ts_idx
--               Index Cond: (ts > (now() - '00:10:00'::interval))
```

## Applicable Scenarios: Column Values Correlated with Physical Order

A BRIN summary is "range min/max", so it has selectivity only when **column values vary monotonically with physical storage position**. The official wording: best suited to columns where "values are highly correlated with the physical order of table rows". Typical shapes:

- **Append-only time-series tables**: `created_at`/event time increases with each insert, each range's ts interval does not overlap the others, and BRIN can skip 99% of the data.
- **Columns ordered by physical position**: such as an auto-increment id or a batch number from batched imports.

The direct way to judge is to look at `correlation` in the statistics (close to +1 or -1 both count as strong; the sign only indicates direction):

```sql
SELECT correlation FROM pg_stats
WHERE tablename = 'brin_events' AND attname = 'ts';
--  correlation
-- --------------
--            -1    -- monotonic, physical order and column values match exactly (opposite direction)
```

Conversely, a UUID primary key or a frequently and randomly updated status column has correlation near 0, and BRIN is essentially useless.

## pages_per_range and Precision

By default each summary covers 128 pages (1 MB of heap data). A larger range means a smaller index, but a wider "range min/max" and fewer pages skipped; smaller is the opposite:

```sql
CREATE INDEX brin_sh_ts32 ON brin_shuffled USING brin (ts) WITH (pages_per_range = 32);
SELECT relname, reloptions FROM pg_class WHERE relname = 'brin_sh_ts32';
--    relname     |       reloptions
-- ---------------+-------------------------
--  brin_sh_ts32  | {pages_per_range=32}
```

pages_per_range is fixed at index-creation time; changing it requires a rebuild. General approach: for fully monotonic data the default is fine; for slightly out-of-order data, lower the value (32 or 16) for finer granularity.

## minmax-multi and bloom Variants (PG 14+)

PG 14 introduced two kinds of extended opclass that address minmax's weak spots:

- **minmax-multi** (such as `timestamptz_minmax_multi_ops`): each range stores **multiple** min/max sub-intervals, tolerating outliers — for instance, with 99% of rows inserted in time order and 1% backfilled history data, a plain minmax range gets blown out wide by the outliers, while the multi variant keeps its skip ability.
- **bloom** (such as `int4_bloom_ops`): stores a bloom filter in each range, serving **equality** queries — minmax has almost no selectivity for `=` on a randomly distributed column, but bloom can do it.

```sql
CREATE INDEX brin_events_sensor_mm ON brin_events
    USING brin (sensor_id int4_minmax_multi_ops);
```

Both can control the per-range storage budget with `values_per_range` (default 32). The opclass must be named explicitly; a plain `USING brin (col)` is always minmax.

## Why It Breaks When Physical Order Is Disrupted

BRIN's failure mode is direct: **once out-of-order data mixes in, the range min/max widens, every range summary starts covering the whole value domain, and the index degenerates into "always returns the whole table"**. Common causes:

- Backfilling/restoring historical data (timestamps far earlier than existing data).
- Message-queue rebalancing, or out-of-order arrival from multiple writers.
- Non-HOT UPDATEs that write new row versions to other locations in the heap (if the column value is unchanged the summary is unaffected, but if the indexed column itself is updated it is affected).

Controlled experiment: rebuild that correlation -1 table in shuffled order, and correlation drops to near 0:

```sql
CREATE TABLE brin_shuffled AS SELECT * FROM brin_events ORDER BY md5(random()::text);
CREATE INDEX brin_shuffled_ts_idx ON brin_shuffled USING brin (ts);
ANALYZE brin_shuffled;

SELECT correlation FROM pg_stats WHERE tablename = 'brin_shuffled' AND attname = 'ts';
--  correlation
-- --------------
--  0.0062408457
```

At this point BRIN still exists and is still chosen, but every query has to recheck almost every page and the benefit is zero. Countermeasures: sort by time on the writer side (single-partition Kafka is ordered, `ORDER BY` before bulk imports); use `minmax_multi_ops` when outliers are known to occur; when disorder is severe, give up BRIN or rebuild the index periodically.

## Time-Series Workloads Combined with Partitioned Tables

A common combo for time-series loads: **partition by time + a BRIN per partition**. Partition pruning first drops partitions outside the time range, then the intra-partition BRIN skips pages by min/max — two layers of pruning stack up:

```sql
CREATE TABLE metrics (
    ts timestamptz NOT NULL,
    value numeric
) PARTITION BY RANGE (ts);

CREATE TABLE metrics_2026_10 PARTITION OF metrics
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE INDEX ON metrics_2026_10 USING brin (ts);
```

BRIN is not a replacement for the usual indexes on each partition, but a complement to them: B-tree for hot columns, BRIN on the time column to control storage cost. For partition design see [Partition Table Design](../database-design/table-inheritance-and-partitioning-design), for the pruning mechanism see [Partition Pruning](../performance/partition-pruning); for a managed time-series option see [TimescaleDB](../ecosystem/timescaledb).

## References

- [PostgreSQL Official Documentation · Chapter 11. Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL Official Documentation · 11.2. Index Types](https://www.postgresql.org/docs/current/indexes-types.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Partition Table Design](../database-design/table-inheritance-and-partitioning-design)
- [Partition Pruning](../performance/partition-pruning)
- [The Index Selection Decision Tree](./index-selection-decision-tree)
- [B-tree Structure and Principles](./btree-structure)
- [index-selection-decision-tree](index-selection-decision-tree.md)
- [index](index.md)
