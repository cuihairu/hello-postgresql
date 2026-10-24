# Write Throughput Optimization

The write throughput bottleneck is usually not the CPU time spent executing INSERTs, but the WAL fsync wait per transaction and the client round trips. Optimizations, ordered by payoff: first cut the number of transactions (batch them), then switch to a faster channel (COPY), only then consider relaxing commit guarantees (synchronous_commit, unlogged tables), and finally prepare dedicated setup for bulk loads. The first three steps are small, low-risk changes appropriate for everyday business work; the dedicated preparation is for one-off data loads.

## Where a Single INSERT Is Slow

Under autocommit each INSERT is its own transaction: write a WAL record, wait for WAL to reach disk, update commit state, possibly trigger a WAL full page image. 1000 individual INSERTs = 1000 fsync waits + 1000 client round trips; the WAL volume of the row data itself is a secondary cost.

```sql
-- anti-example: one transaction per row, one network round trip per row
INSERT INTO events(payload) VALUES ('a');
INSERT INTO events(payload) VALUES ('b');

-- multi-row INSERT: one parse, one transaction, contiguous WAL
INSERT INTO events(payload) VALUES ('a'), ('b'), ('c');

-- the most common application-side form: accumulate a batch, commit one transaction
BEGIN;
INSERT INTO events(payload)
SELECT unnest(ARRAY['a', 'b', 'c']);
COMMIT;
```

What batching amortizes is the fixed cost per transaction: the commit record and fsync, page header changes, parse and planning overhead, network RTT. The "WAL volume of the row data" is about the same for a batch as for individual statements, so do not expect batching to reduce WAL bytes.

## COPY: The Fastest Import Channel

COPY uses a dedicated parsing and protocol path, bypassing the SQL parser; the official docs explicitly recommend COPY for bulk data, and it is usually several times faster than multi-row INSERT:

```sql
-- psql client file import (\copy reads the file in the client process, no server-side file permission needed)
\copy events FROM '/tmp/events.csv' WITH (FORMAT csv, HEADER true)

-- application-side streaming write: data is generated on the client and sent as it goes
COPY events(payload) FROM STDIN WITH (FORMAT text);
```

The row-data WAL COPY generates is the same as INSERT, and the commit semantics are the same—it is faster in parsing and protocol overhead, and it does not skip the fsync wait. So COPY still belongs inside a transaction, or relies on its own single-transaction semantics (COPY is itself one transaction), and item 5 below still governs your commit-guarantee trade-off.

## synchronous_commit=off: Throughput for a Loss Window

With the default `synchronous_commit = on`, a commit waits for WAL to hit disk before returning. Set to off, a commit returns once the WAL reaches the OS cache, and walwriter flushes it asynchronously on a cadence (every `wal_writer_delay`, default 200ms), removing the per-transaction fsync wait:

```sql
-- enable per session
SET synchronous_commit = off;

-- the more common approach: enable only for roles that write heavily and can tolerate small losses
ALTER ROLE metrics_writer SET synchronous_commit = off;
```

Key facts, per the official documentation:

- The loss window is about 3 × `wal_writer_delay` (roughly 600ms by default), and it **only happens on an OS crash or power loss**; a PostgreSQL process crash does not lose committed transactions (the data is still in the OS cache), and a clean shutdown loses nothing.
- **No partial commits and no data corruption**: what is lost is the whole transaction inside the window, and transaction boundaries stay intact. That is PostgreSQL's own transaction guarantee—the only things it cannot cover are hardware/OS-level failures.
- This setting does not reduce WAL bytes; it only changes *when* you wait. If WAL bandwidth is the bottleneck, it does not help.

Applicable: monitoring samples, like counts, IoT telemetry—the kind of writes where losing half a second is fine. Not applicable: orders, payments, accounting.

## unlogged Tables: WAL-Free Staging Tables

`UNLOGGED` tables write no WAL (only a small amount of metadata WAL), so writes are noticeably faster. Two costs: the table is emptied after a crash recovery; and its data is not replicated to streaming replication replicas, so reads on the standby see nothing.

```sql
CREATE UNLOGGED TABLE staging_events (
  id bigint GENERATED ALWAYS AS IDENTITY,
  payload jsonb
);

-- since PG 15 you can switch between normal and unlogged
ALTER TABLE staging_events SET UNLOGGED;
```

The role is ETL transit, temporary aggregate results, and re-runnable staging data—essentially "session-level/job-level temporary data", where crashing and re-running is fine. Do not put any loss-critical data here; in a primary-standby setup be aware its data does not exist on the replica.

## commit_delay

`commit_delay` (in microseconds) makes the first backend to reach the commit point in a group pause briefly, gathering more transactions to do one shared fsync (group commit), and requires `commit_siblings` concurrent transactions. Default is 0 (disabled); instances with an extreme number of tiny transactions and many cores occasionally see a gain, but keep the default generally and prefer the measures above.

## Bulk Import Checklist

Run in this order, largest payoff first:

```plaintext
1. Use COPY instead of INSERT, instead of sending SQL one row at a time;
2. Drop indexes and triggers first, rebuild them after the load—rebuilding an index is a sort
   operation, an order of magnitude faster than maintaining it row by row;
3. Raise maintenance_work_mem in the import session (say 1GB);
   both index rebuilds and sorts draw on that memory;
4. Raise max_wal_size (say 4-8GB) to avoid repeated checkpoints during the import
   and repeated flushing of the same set of pages;
5. If a loss window is acceptable, SET synchronous_commit = off in the import session;
6. After the load, run VACUUM ANALYZE so the visibility map and statistics catch up;
7. For initial loading of an empty database you can temporarily set wal_level = minimal
   (needs a restart, and only takes effect when max_wal_senders = 0), and combined
   with COPY cuts WAL by nearly half;
8. During a one-off import you can ALTER TABLE ... SET (autovacuum_enabled = off) on the
   target table; remember to switch it back after the load.
```

## Caveats and Common Pitfalls

- Bigger batches are not always better: an oversized transaction means a long transaction holding xmin, longer lock hold times, and a concentrated WAL peak. Start load testing from 1,000-10,000 rows per batch to find the knee—see [Batch and Write](../advanced-sql/batch-and-write).
- `synchronous_commit = off` and `fsync = off` are different things: the latter disables WAL fsync itself and can corrupt the database on a crash—never enable it in production.
- Treat unlogged tables as caches: do not count critical data into monitoring or alerting scripts.
- If queries slow down after an import, suspect unrefreshed statistics first—ANALYZE before arguing about anything else.

## References

- [PostgreSQL Official Documentation · 14.4. Populating a Database](https://www.postgresql.org/docs/current/populate.html)
- [PostgreSQL Official Documentation · 28.4. Asynchronous Commit](https://www.postgresql.org/docs/current/wal-async-commit.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [batch-and-write](/advanced-sql/batch-and-write.md)
- [when-to-choose-postgresql](/ecosystem/when-to-choose-postgresql.md)
- [composite-index-design](/indexing/composite-index-design.md)
- [wal-mechanism](/internals/wal-mechanism.md)
- [benchmark-tools](benchmark-tools.md)
- [capacity-and-scaling-limits](capacity-and-scaling-limits.md)
- [connection-and-orm-optimization](connection-and-orm-optimization.md)
- [index](index.md)
- [lock-and-concurrency-bottlenecks](lock-and-concurrency-bottlenecks.md)
- [parameter-tuning](parameter-tuning.md)
- [vacuum-stall-and-performance](vacuum-stall-and-performance.md)- [WAL Mechanics](../internals/wal-mechanism)——why a commit has to wait for fsync, and where WAL volume comes from.
- [Checkpoint and Buffer](../internals/checkpoint-and-buffer)——the relationship between max_wal_size and the flush cadence.
- [Parameter Tuning](./parameter-tuning)——value choices for maintenance_work_mem and max_wal_size.
- [Benchmark Tools](./benchmark-tools)——use pgbench to quantify the actual payoff of each step above.

Official docs: <https://www.postgresql.org/docs/current/populate.html> and <https://www.postgresql.org/docs/current/wal-async-commit.html>
