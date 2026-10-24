# Checkpoints and Buffers

PostgreSQL manages its own shared buffer pool (shared_buffers): data pages are modified in the pool first and then written out to disk in batches by mechanisms such as checkpoint. Writing the WAL to disk first guarantees crash recovery is possible at any moment (see [The WAL Mechanism](./wal-mechanism)). A checkpoint is the periodic action of "flushing dirty pages in a batch + advancing the recovery point", and its rhythm directly determines how smooth the IO curve stays and how long crash recovery takes.

## Double buffering: 8KB pages and OS pages

- PostgreSQL page size is fixed at 8KB while the OS filesystem page is usually 4KB, which stacks up into "double buffering": the same data may exist in shared_buffers and the OS page cache at the same time;
- `shared_buffers` defaults to only 128MB; on a dedicated server a common starting point is around 25% of physical memory. There is no point chasing a big value — the OS cache also serves full scans and temporary files, and with double buffering both sides are drawing on the same physical memory budget;
- The buffer pool is managed in units of 8KB pages, and a read that hits the pool bypasses the OS entirely.

## Buffer lookup and eviction: clock-sweep

- A backend locates a buffer through the shared buffer mapping hash table by (tablespace, relation, block number) — a single hash lookup tells you whether the page is in memory;
- On a miss, one buffer is evicted: the clock-sweep algorithm uses circular scanning plus an access counter (usage_count) to approximate LRU. Frequently accessed pages have a high count and are harder to evict;
- A buffer in use (pinned) cannot be evicted. Evicting a dirty page requires writing it to disk first — which is exactly the value of bgwriter: it cleans dirty pages ahead of time so the foreground backend does not have to do the writing itself on eviction.

## Observing the hit rate

```sql
-- Heap page hit rate across all user tables in the instance (check shared_buffers and the working set if it stays below 95%)
SELECT sum(heap_blks_hit) AS heap_hits, sum(heap_blks_read) AS heap_reads,
       round(100.0 * sum(heap_blks_hit)
             / nullif(sum(heap_blks_hit) + sum(heap_blks_read), 0), 2) AS hit_pct
FROM pg_statio_user_tables;
```

```sql
-- Find the source of read amplification per table: tables with high heap_blks_read are the buffer pool pressure points
SELECT relname, heap_blks_hit, heap_blks_read,
       round(100.0 * heap_blks_hit / nullif(heap_blks_hit + heap_blks_read, 0), 1) AS hit_pct
FROM pg_statio_user_tables
ORDER BY heap_blks_read DESC
LIMIT 10;
```

From PG 16 you can use `pg_stat_io` to break observations down by operation context (ordinary reads, vacuum, bulkread, and so on):

```sql
SELECT backend_type, context, hits, reads, evictions
FROM pg_stat_io
WHERE object = 'relation'
ORDER BY reads DESC;
```

A low hit rate is not necessarily a bad thing: full-scan style reports push large volumes of pages through the pool, dragging the overall hit rate down without that necessarily being a configuration problem — judge it against the business workload.

## What triggers a checkpoint

Any one of the following triggers one:

- more than `checkpoint_timeout` (default 5 minutes) has passed since the last checkpoint;
- the estimated WAL consumption is about to reach `max_wal_size`. This is a soft limit: exceeding it does not raise an error immediately, it triggers a checkpoint at once, and WAL can still keep growing to 1.5–2x — in the extreme case the disk fills and the instance PANICs;
- administrative operations such as running the `CHECKPOINT` command manually, starting an online backup, or shutting down cleanly.

If the logs show `checkpoints are occurring too frequently (N seconds apart)`, WAL generation speed has pushed against `max_wal_size`, and `checkpoint_warning` (default 30 seconds) is what reminds you to raise it.

## Spread: flattening the IO peak

- A checkpoint must write out every dirty page, which is naturally an IO spike. `checkpoint_completion_target` (default 0.9 from PG 14) controls the target completion time: finish at roughly the 90% point before the next checkpoint arrives, spreading the write-out across the whole cycle;
- Flattening keeps the IO curve smooth, at the cost of dirty pages lingering longer and crash recovery having to replay more WAL (recovery time scales with the WAL volume after the last checkpoint);
- The tuning direction: on high-write instances raise `max_wal_size` a lot (start probing at 8GB–32GB) to reduce how often checkpoints occur, and keep `checkpoint_completion_target = 0.9`, rather than shortening the timeout to make checkpoints denser.

Observation (PG 16 and earlier, where checkpoint statistics live in `pg_stat_bgwriter`):

```sql
SELECT checkpoints_timed, checkpoints_req,
       checkpoint_write_time, checkpoint_sync_time,
       buffers_checkpoint, buffers_clean, maxwritten_clean
FROM pg_stat_bgwriter;
```

From PG 17, checkpoint statistics move to `pg_stat_checkpointer`:

```sql
SELECT num_timed, num_requested, write_time, sync_time, buffers_written
FROM pg_stat_checkpointer;
```

`checkpoints_timed` far exceeding `checkpoints_req` means the rhythm is healthy (driven by the timeout). A persistently high `checkpoints_req` means WAL is frequently hitting `max_wal_size`, and you should raise it.

## The division of labor between bgwriter and walwriter

- **bgwriter**: wakes every `bgwriter_delay` (default 200ms), scans along clock-sweep, and writes out the dirty pages "about to be evicted" (bounded by `bgwriter_lru_maxpages` and `bgwriter_lru_multiplier`). The goal is to hand the foreground a clean page when it evicts a buffer;
- **walwriter**: flushes the accumulated pages from the WAL buffer every `wal_writer_delay` (default 200ms), spreading out the flush volume on the commit path;
- Neither of them carries the hard requirement that "a transaction commit must be durable" — committing WAL is flushed by the backend that performs the commit itself, and the batch write-out of a checkpoint is executed by the checkpointer process.

## Notes and common pitfalls

- Changing `shared_buffers` requires a restart to take effect. Beyond a few tens of GB, adding more gives diminishing returns — look at the hit rate and working set size first, and see [Capacity and Scaling Limits](../performance/capacity-and-scaling-limits) for capacity assessment.
- PostgreSQL writes go through ordinary write (not O_DIRECT), so OS cache writeback behavior stacks on top of the checkpoint peak. During load tests, analyze the IO curve against checkpoint timestamps with iostat.
- On systems with a hard recovery time objective (RTO), `max_wal_size` cannot be made unlimited: the sparser the checkpoints, the longer crash recovery takes. This is the trade-off between throughput and recovery time.

## References

- [PostgreSQL official documentation · 28.5. WAL Configuration](https://www.postgresql.org/docs/current/wal-configuration.html)
- [PostgreSQL official documentation · 19.4. Resource Consumption](https://www.postgresql.org/docs/current/runtime-config-resource.html#RUNTIME-CONFIG-RESOURCE-BACKGROUND-WRITER)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [architecture-and-memory](architecture-and-memory.md)
- [index](index.md)
- [process-architecture](process-architecture.md)
- [wal-mechanism](wal-mechanism.md)
- [benchmark-tools](/performance/benchmark-tools.md)
- [explain-analyze-buffers](/performance/explain-analyze-buffers.md)
- [parameter-tuning](/performance/parameter-tuning.md)
- [write-throughput-optimization](/performance/write-throughput-optimization.md)- [The WAL Mechanism](./wal-mechanism) — the other half of write the log first.
- [Architecture and Memory](./architecture-and-memory) — where shared_buffers sits in the overall memory picture.
- [Parameter Tuning](../performance/parameter-tuning) — a global view of related parameters.
- [EXPLAIN ANALYZE and BUFFERS](../performance/explain-analyze-buffers) — buffer hits as seen from a single query.

Official docs: <https://www.postgresql.org/docs/current/wal-configuration.html> and <https://www.postgresql.org/docs/current/runtime-config-resource.html#RUNTIME-CONFIG-RESOURCE-BACKGROUND-WRITER>
