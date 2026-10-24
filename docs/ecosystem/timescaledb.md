# TimescaleDB: Time Series

TimescaleDB is a PostgreSQL extension for time series / monitoring / IoT workloads: declare a plain table as a hypertable and it is automatically split into chunks along time, with columnar compression, continuous aggregates, and retention policies on top. It is not a separate database but "automation plus storage optimization built on native partitioning", so transactions, SQL, indexes, and the ecosystem all stay as they are. Official documentation is at [docs.timescale.com](https://docs.timescale.com/).

## Installation and Hypertables

```bash
# Debian/Ubuntu (requires adding the Timescale repository)
sudo apt install timescaledb-2-postgresql-16
# Then add shared_preload_libraries to postgresql.conf as prompted
```

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE metrics (
    time        timestamptz NOT NULL,
    device_id   text NOT NULL,
    temperature double precision NOT NULL
);

-- Declare as a hypertable: auto-partition by the time column, each chunk covering 1 day
SELECT create_hypertable('metrics', 'time',
                         chunk_time_interval => INTERVAL '1 day');
```

Chunk interval is the core parameter: too small and the chunk count explodes (every chunk carries its own index and metadata overhead), too large and compression, deletes, and vacuum become coarse-grained. Rule of thumb: keep the decompressed size of a single chunk within what memory can hold (the official guidance is the amount corresponding to 25%-50% of available memory); for monitoring and second-level data you usually take 1 day to 1 week. Note that you need `shared_preload_libraries = 'timescaledb'` — this is the biggest difference between its install flow and that of other extensions.

After inserting data you can observe the partitioning directly:

```sql
INSERT INTO metrics
SELECT t, 'dev-' || g, 20 + random() * 10
FROM generate_series(now() - interval '7 days', now(), interval '1 minute') AS t,
     generate_series(1, 20) AS g;

SELECT show_chunks('metrics');
```

## Compression: segmentby and orderby

TimescaleDB compression is columnar compression done per chunk. The official figures put the compression ratio above 90% in general (an order of magnitude, about 10x); the real number depends on how regular the data is:

```sql
ALTER TABLE metrics SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'device_id',
    timescaledb.compress_orderby   = 'time DESC'
);

-- Auto-compress chunks older than 7 days
SELECT add_compression_policy('metrics', INTERVAL '7 days');
```

The two parameters decide how the data is batched for compression:

- **segmentby**: groups rows by the values of these columns, so contiguous rows in the same group get compressed into one batch. Pick columns you "often filter on with equality in queries" (such as a device ID), so an entire batch can be skipped during filtering.
- **orderby**: the sort key within the group. Once time series data is sorted by time, neighboring values are highly similar, which is where delta and dictionary encoding get the most benefit.

Compressed chunks can still be queried (only the needed batches are decompressed), but heavy random point lookups get slower. So the usual policy is "do not compress hot data; auto-compress after N days".

## Continuous Aggregates: Auto-Materialized Time Series Aggregates

A continuous aggregate is an auto-materialized view over a `time_bucket` aggregation: when new data arrives, a background job refreshes incrementally per policy, and queries can layer in the non-materialized realtime portion:

```sql
CREATE MATERIALIZED VIEW metrics_hourly
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', time) AS bucket,
       device_id,
       avg(temperature) AS avg_temp,
       max(temperature) AS max_temp
FROM metrics
GROUP BY bucket, device_id
WITH NO DATA;

-- Refresh the "3 hours ago ~ 1 hour ago" window every half hour
SELECT add_continuous_aggregate_policy('metrics_hourly',
    start_offset      => INTERVAL '3 hours',
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '30 minutes');

-- Query it exactly like a normal table
SELECT bucket, device_id, avg_temp
FROM metrics_hourly
WHERE bucket > now() - interval '1 day'
ORDER BY bucket;
```

With the default settings, a query reads the combination of "materialized results + unmaterialized realtime data" (realtime aggregation). If you do not want the realtime part (say you only need historical reports), set `WITH (timescaledb.materialized_only = true)`. The difference from hand-maintaining a [materialized view](../database-design/materialized-views) is that you do not write refresh scripts yourself, and the refresh is incremental per window rather than a full recompute.

## Retention: drop_chunks

The most common cleanup for time series data is "keep only N days", and TimescaleDB does that automatically via a policy:

```sql
-- Manually drop chunks older than 90 days (a whole-chunk DROP, no large volume of dead tuples)
SELECT drop_chunks(INTERVAL '90 days', 'metrics');

-- Or attach a policy to run it daily
SELECT add_retention_policy('metrics', INTERVAL '90 days');
```

Dropping by chunk is far cheaper than `DELETE`: no dead tuples, no vacuum pressure, and the disk space is returned immediately. This is also why time series workloads prefer hypertables over hand-run `DELETE` cleanup, and it ties directly to the delete cost discussed in [VACUUM and HOT](../internals/vacuum-and-hot).

## TimescaleDB vs. Native Partitioning

Cases where PostgreSQL's native declarative partitioning (see [Table Inheritance and Partitioning](../database-design/table-inheritance-and-partitioning-design)) is good enough for time series:

- Partition counts in the dozens to hundreds range, and partition creation / cleanup can be managed with simple scripts or pg_partman;
- You do not need columnar compression and the disk cost is acceptable;
- No need for automatic incremental materialized aggregation, or a plain materialized view plus scheduled refresh will do;
- The environment will not allow extensions (a managed allowlist restriction, licensing concerns).

TimescaleDB's incremental value concentrates on: automatic chunk creation and parameter adaptation, high compression ratios, continuous aggregates, retention policies as one integrated story, and dedicated optimization of the high-concurrency write path. The decision criterion is plain: if native partitioning plus cron scripts meets your needs, do not bring in the extension. Once data reaches the TB scale, or you need compression to save cost, the extension's automation starts to pay off.

## License and Common Pitfalls

On licensing, TimescaleDB is dual-licensed: the core such as hypertables is Apache 2 open source, while features like compression and continuous aggregates fall under the Timescale License (free to use, but not an OSI open source license, and redistribution as a database service is not permitted). Before commercial integration, check the official license page and the extension allowlist of the managed platform you use.

Common pitfalls: forgetting to configure `shared_preload_libraries`, which makes extension creation fail; setting the chunk interval too small (seconds / minutes) and ending up with tens of thousands of chunks, where metadata overhead drags the planner down; a compression policy covering a time range still being written to heavily; making the `time_bucket` window far finer than the query granularity, which lets continuous aggregate size run away. When choosing, you can also compare against [Choosing PostgreSQL](./when-to-choose-postgresql).

## References

- [wiki.postgresql.org/wiki/Foreign_data_wrappers](https://wiki.postgresql.org/wiki/Foreign_data_wrappers)
- [GitHub · pgvector/pgvector](https://github.com/pgvector/pgvector)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Table Inheritance and Partitioning](../database-design/table-inheritance-and-partitioning-design)
- [Partition Pruning](../performance/partition-pruning)
- [Modeling Time](../database-design/time-modeling)
- [Extension Management](./extension-management)
- [time-modeling](/database-design/time-modeling.md)
- [index](index.md)
- [brin](/indexing/brin.md)
- [knowledge](/knowledge.md)