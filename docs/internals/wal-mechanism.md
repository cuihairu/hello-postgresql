# The WAL Mechanism

WAL (Write-Ahead Log, pre-write log) is the foundation of PostgreSQL's durability: before any modification of a data page is allowed out to disk, the log record describing that modification is written to the WAL and flushed. The same mechanism supports three things at once: crash recovery (replaying WAL after a restart), streaming and logical replication (downstreams consume the WAL), and point-in-time recovery, PITR (replaying to an arbitrary moment in combination with a base backup).

## WAL records and LSN

The WAL is an append-only stream of bytes, and each record describes "what physical change happened to some page" rather than SQL logic. Position within the stream is expressed as an LSN (Log Sequence Number), formatted like `16/B374D848`:

```sql
SELECT pg_current_wal_lsn();                    -- current write position
SELECT pg_walfile_name(pg_current_wal_lsn());   -- the corresponding segment file name

-- Estimate the WAL generation rate: take two LSNs a while apart and diff them in bytes
SELECT pg_current_wal_lsn();
-- ... after waiting a while:
SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '16/B374D848') AS bytes_elapsed;
```

```sql
-- PG 14+: WAL volume statistics since instance start (wal_fpi is the count of full page image records)
SELECT wal_records, wal_fpi, pg_size_pretty(wal_bytes) AS wal_volume
FROM pg_stat_wal;
```

## WAL first, data pages second

- On commit, the backend must flush the WAL records it produced to disk (with `synchronous_commit = on` this happens before the commit returns); the data pages may keep living in shared_buffers and are written out later in batches by the checkpointer/bgwriter;
- So at the instant of a crash, the data pages on disk are a mix of "old pages + some new pages". Recovery uses WAL replay to push the pages into a consistent state — this is exactly why data pages may be written out of order and with delay;
- `full_page_writes` (default on): the **first** time a page is modified after a checkpoint, the complete 8KB image of the page is written into the WAL. Purpose: to fight torn pages — the OS writes to disk in 4KB units, so a crash can leave an 8KB data page half new and half old. Such a page cannot be repaired from incremental log records and can only be overwritten as a whole page.

FPW noticeably amplifies the first round of writes after a checkpoint. This is where `wal_compression` comes in.

## wal_buffers and the commit path

- `wal_buffers` is the WAL buffer in shared memory. The default of -1 means take 1/32 of `shared_buffers`, floored at 64kB and capped at one WAL segment (default 16MB). An instance with high write throughput can set it explicitly to 16MB–64MB to reduce buffer contention;
- The commit path: the backend writes the commit record into the WAL buffer itself and is responsible for flushing it. The `walwriter` process flushes accumulated WAL pages ahead of time outside of commits, so that when a given backend commits it does not have to flush a large backlog of WAL left by other transactions all at once.

## Segment files and managing the pg_wal directory

- WAL is organized into segment files, each 16MB by default. Since PG 11 you can adjust this at initialization time with `initdb --wal-segsize` to a power of two from 1MB to 1GB;
- When a segment fills up it is switched, and new records go into the next segment. `pg_switch_wal()` forces a switch manually;
- A filled segment is not deleted immediately: it is archived first (if archiving is enabled), then either reclaimed according to the `min_wal_size`/`max_wal_size` policy (renamed for reuse) or deleted;
- `wal_keep_size` (PG 13+, replacing the old wal_keep_segments) guarantees at least this much WAL is retained in pg_wal for streaming replication. In addition, **replication slots** prevent segments that downstreams have not consumed yet from being deleted — an abandoned slot that was never removed is the classic reason pg_wal fills the disk.

```sql
-- Current state of the pg_wal directory
SELECT count(*) AS segment_files, pg_size_pretty(sum(size)) AS total_size
FROM pg_ls_waldir();

-- Who is holding back WAL reclamation
SELECT slot_name, active, wal_status, xmin, catalog_xmin
FROM pg_replication_slots;
```

## wal_compression

The full page images from FPW are usually highly compressible. Once `wal_compression` is enabled, only these full page images are compressed:

- The parameter was introduced in PG 9.6 but supported only pglz, with mediocre compression ratio and speed. **Since PG 15 you can choose lz4 and zstd**; on PG 15+ set `lz4` or `zstd`.
- The benefit shows up directly in WAL volume: write volume, archive volume, and replication traffic all benefit, at the cost of a little CPU. High-write workloads usually find it worth enabling.

```sql
SELECT name, setting FROM pg_settings
WHERE name IN ('wal_compression', 'full_page_writes', 'wal_buffers',
               'wal_keep_size', 'max_wal_size', 'min_wal_size', 'wal_segment_size');
```

## Notes and common pitfalls

- `synchronous_commit = off` makes commit skip waiting for the WAL flush, giving a clear throughput gain. The risk is losing the most recent few hundred milliseconds of committed transactions on crash (data consistency is not corrupted). Do not turn it off for billing or money-related systems where nothing can be lost. See [Write Throughput Optimization](../performance/write-throughput-optimization).
- Put the pg_wal volume under capacity monitoring together with the data directory. WAL filling the disk PANICs the instance outright. When existing WAL growth looks abnormal, check the inactive slots in `pg_replication_slots` first.
- Common causes of an abnormally high WAL generation rate: a large volume of FPW right after a checkpoint, a long transaction bunching up a great many changes into one commit, and a big batch UPDATE/DELETE. Use `pg_stat_wal` alongside the diff of two LSNs to locate the cause against your actual write volume.

## References

- [PostgreSQL official documentation · Chapter 28. Reliability and the Write-Ahead Log](https://www.postgresql.org/docs/current/wal.html)
- [PostgreSQL official documentation · 28.5. WAL Configuration](https://www.postgresql.org/docs/current/wal-configuration.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [glossary](/appendix/glossary.md)
- [checkpoint-and-buffer](checkpoint-and-buffer.md)
- [index](index.md)
- [logical-replication-internals](logical-replication-internals.md)
- [streaming-replication-and-sync](streaming-replication-and-sync.md)
- [knowledge](/knowledge.md)
- [disaster-recovery-drills](/operations/disaster-recovery-drills.md)
- [physical-backup-and-pitr](/operations/physical-backup-and-pitr.md)
- [streaming-replication-setup](/operations/streaming-replication-setup.md)
- [capacity-and-scaling-limits](/performance/capacity-and-scaling-limits.md)
- [vacuum-stall-and-performance](/performance/vacuum-stall-and-performance.md)
- [write-throughput-optimization](/performance/write-throughput-optimization.md)- [Checkpoints and Buffers](./checkpoint-and-buffer) — when dirty pages are written out after the WAL hits disk.
- [Streaming Replication and Synchronous Replication](./streaming-replication-and-sync) — how downstreams consume the WAL.
- [Physical Backup and PITR](../operations/physical-backup-and-pitr) — WAL archiving and point-in-time recovery.

Official docs: <https://www.postgresql.org/docs/current/wal.html> and <https://www.postgresql.org/docs/current/wal-configuration.html>
