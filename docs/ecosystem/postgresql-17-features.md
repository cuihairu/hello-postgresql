# PostgreSQL 17 Highlights

PostgreSQL 17 was released on September 26, 2024. It is a release polished around "operating large volumes of data": a rewritten vacuum memory model, native incremental backup, turning a physical standby into a logical subscriber with one command, plus standard SQL completion for `JSON_TABLE` and `MERGE`. Below I group the entries that matter most to day-to-day development and operations; the full list is in the [official release notes](https://www.postgresql.org/docs/release/17.0/).

## vacuum and Memory Management

- **Rebuilt dead tuple storage (TidStore)**: the internal structure vacuum uses to collect dead tuple addresses is replaced by a radix-tree-based TidStore. The same amount of memory now holds far more dead tuples, improving overall vacuum performance.
- **The implicit 1GB cap is gone**: in older versions, no matter how large you set `maintenance_work_mem` / `autovacuum_work_mem`, the dead tuple store actually used only about 1GB; PG 17 removes that limit, so vacuuming large tables no longer spills to disk too early.
- **More efficient removal and freezing**: the WAL vacuum writes is also more compact, and `pg_stat_progress_vacuum` gains index progress columns (`indexes_total` / `indexes_processed`), so a long vacuum finally shows you "stuck on which index".
- **Renamed observation columns**: `max_dead_tuples` becomes `max_dead_tuple_bytes`, measured in bytes rather than tuple count.

The direct operational effect: on databases with high update/delete load, autovacuum has more tuning headroom and each vacuum round takes less time. For the background, see [VACUUM and HOT](../internals/vacuum-and-hot) and [autovacuum tuning](../internals/autovacuum-tuning).

## EXPLAIN Enhancements

- **`BUFFERS` reports local I/O timing**: `EXPLAIN (ANALYZE, BUFFERS)` can now distinguish read/write time for shared blocks from local/temp blocks, making the local buffers of temp tables and `$$` anonymous blocks finally observable.
- **`MEMORY` option**: reports the memory the planner consumed.
- **`SERIALIZE` option**: estimates the cost of serializing the result set into network format, giving direct evidence when "the result set is too large and that is why it is slow".

```sql
EXPLAIN (ANALYZE, BUFFERS, MEMORY, SERIALIZE)
SELECT * FROM orders WHERE status = 'pending';
```

For the basics of reading plans, see [Reading EXPLAIN](../performance/explain-basics) and [EXPLAIN (ANALYZE, BUFFERS)](../performance/explain-analyze-buffers).

## MERGE Enhancements

The `MERGE` statement introduced in PG 15 gets three key capabilities in 17:

- **`RETURNING` clause**: a merge statement can return the rows it inserted/updated, and the new `merge_action()` function marks which action produced each row.
- **`WHEN NOT MATCHED BY SOURCE`**: you can define an action for rows that exist in the target table but not in the source (the typical use being "sync stock: delete anything not present"). Previously this required a separate DELETE statement.
- **Updatable views**: the merge target can be an updatable view.

```sql
MERGE INTO stock s
USING incoming i ON s.sku = i.sku
WHEN MATCHED THEN
    UPDATE SET qty = s.qty + i.qty
WHEN NOT MATCHED BY SOURCE THEN
    DELETE
WHEN NOT MATCHED THEN
    INSERT (sku, qty) VALUES (i.sku, i.qty)
RETURNING merge_action(), s.sku;
```

For more bulk-write patterns, see [Batching and Writes](../advanced-sql/batch-and-write).

## Backup and Recovery: Native Incremental Backup

- **`pg_basebackup --incremental`**: using the previous full backup's `backup_label` as the baseline, only blocks that changed are backed up, cutting both the size and duration of routine backups for large databases.
- **`pg_combinebackup`**: at restore time, merges a full backup with one or more incrementals into one usable complete backup.
- **WAL summarization**: the server can optionally enable `summarize_wal`, which generates a background summary file of "which blocks changed in a given LSN range" for incremental backup to identify changed blocks. The accompanying tool is `pg_walsummary`, with functions such as `pg_available_wal_summaries()`.

```bash
# Incremental backup based on the full backup at /backup
pg_basebackup -D /backup/incr1 --incremental=/backup/backup_label -X stream

# Merge full + incremental to get a restorable copy
pg_combinebackup /backup /backup/incr1 -o /restore/full
```

Note: incremental backup is **new in PG 17**, not in PG 16 as many older articles claim. For the full backup picture, see [Backup Strategy](../operations/backup-strategy) and [Physical Backup and PITR](../operations/physical-backup-and-pitr).

## Replication

- **`pg_createsubscriber`**: converts a physical standby directly into a logical subscriber, so building a logical replication topology no longer requires creating an empty database and loading all the data. The migration window can shrink to minutes.
- **Logical slot failover**: `sync_replication_slots` lets a physical standby keep the primary's logical slots in sync, so a logical subscription keeps flowing after a primary failover; `synchronized_standby_slots` can require a specified physical standby to receive the WAL before confirming to subscribers.
- **pg_upgrade migrates logical slots**: after an upgrade, logical replication can resume quickly (the old cluster must already be PG 17+).
- Subscribers now support hash index replication. For the operational side, see [Logical Replication Operations](../operations/logical-replication-ops); for the principles and limits of bidirectional logical replication, see [Logical Replication Internals](../internals/logical-replication-internals).

## SQL: JSON_TABLE and Standard SQL/JSON

- **`JSON_TABLE()`**: unfolds a JSON document into a row set per the SQL standard, placed straight into the `FROM` clause. With clauses such as `NESTED PATH` and `ERROR ON ERROR`, it replaces most of the hand-written `jsonb_array_elements` plus cast boilerplate.
- **Standard constructor and query functions**: `JSON()` / `JSON_SCALAR()` / `JSON_SERIALIZE()` construct JSON; `JSON_EXISTS()` / `JSON_QUERY()` / `JSON_VALUE()` query with SQL/JSON path expressions.
- **jsonpath type-conversion methods**: `$.a.integer()`, `$.ts.timestamp_tz()`, and so on, converting directly while extracting the value.

```sql
SELECT jt.*
FROM json_table(
    '[{"id":1,"tags":["a","b"]},{"id":2,"tags":["c"]}]',
    '$[*]' COLUMNS (
        id int PATH '$.id',
        NESTED PATH '$.tags[*]' COLUMNS (tag text PATH '$')
    )
) AS jt;
```

For more JSONB usage, see [JSONB Operations](../advanced-sql/jsonb-operations).

## Constraints and Table Definitions

- **Exclusion constraints on partitioned tables**: the precondition is that the partition key column uses equality comparison and the remaining columns use an exclusion comparison. Constraints like "room booking time ranges must not overlap" can finally live on partitioned tables. See [Range Types and EXCLUDE](../advanced-sql/range-types-and-exclude).
- **Identity columns on partitioned tables**: a partitioned table's primary key can now uniformly use `GENERATED ALWAYS AS IDENTITY`.
- **btree multi-valued lookups**: btree index scans are more efficient for multi-valued conditions such as an `IN` constant list.

## Other Notable Entries

- **`COPY ... ON_ERROR ignore`**: skips malformed rows and keeps importing; pair it with `LOG_VERBOSITY` to print the skipped rows, so loading dirty data no longer means splitting files.
- **Streaming I/O**: `io_combine_limit` lets prefetching proceed in larger chunks, improving the I/O efficiency of full table scans and vacuum.
- **`transaction_timeout`**: aborts a transaction that runs too long in total, filling the gap left by `statement_timeout` / `idle_in_transaction_session_timeout` and stopping long transactions from dragging vacuum down.
- **New views**: `pg_stat_checkpointer` (checkpoint statistics), `pg_wait_events` (the wait event dictionary).
- **TLS**: `sslnegotiation=direct` supports a direct ALPN handshake, saving one round trip.
- **`random(min, max)`**: generate a random number within a range directly.

## Upgrade Guidance

Common reasons to upgrade from PG 16 to 17: the vacuum memory rebuild (high-write-load databases), native incremental backup (backups for large databases), `pg_createsubscriber` and logical slot failover (building logical replication topologies), `JSON_TABLE` (JSON-heavy applications). For the upgrade process, see [Version Upgrades](../operations/version-upgrade). For up-to-date version features, treat the official [release notes](https://www.postgresql.org/docs/release/) as the source of truth.

## References

- [PostgreSQL Official Docs · PostgreSQL: Release Notes](https://www.postgresql.org/docs/release/)
- [wiki.postgresql.org/wiki/Foreign_data_wrappers](https://wiki.postgresql.org/wiki/Foreign_data_wrappers)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [PostgreSQL 16 Highlights](./postgresql-16-features)
- [VACUUM and HOT](../internals/vacuum-and-hot)
- [Physical Backup and PITR](../operations/physical-backup-and-pitr)
- [Version Upgrades](../operations/version-upgrade)
- [index](index.md)
- [postgresql-16-features](postgresql-16-features.md)
- [knowledge](/knowledge.md)