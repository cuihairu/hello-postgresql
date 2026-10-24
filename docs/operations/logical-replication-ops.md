# Logical Replication Operations

Logical replication synchronizes by "row-level changes per table" (INSERT/UPDATE/DELETE propagated as logical events) rather than copying physical data blocks. Typical uses: rolling major version upgrades, distributing a subset of tables to downstream data warehouses / caches / audit databases, and migrations between heterogeneous databases. The publish/subscribe model and decoding internals are in [Logical Replication Internals](../internals/logical-replication-internals); this page collects the day-to-day operations for establishing, initial synchronization, DDL, conflicts, and monitoring.

## Prerequisites and accounts

```plaintext
# publisher side
wal_level = logical                        # records more than replica does, for logical decoding
max_wal_senders >= number of subscriptions + headroom            # default 10
max_replication_slots >= number of subscriptions + headroom       # default 10

# subscriber side
max_replication_workers >= number of subscriptions + headroom for initial sync   # default 4
max_sync_workers_per_subscription = 2            # parallelism for initial table sync; default 2
```

The publisher-side account needs `SELECT` on the published tables (or just use a superuser); `CREATE PUBLICATION ... FOR ALL TABLES` requires a superuser, while a publication naming an explicit table list can be created by the table owner.

## Creating publications and subscriptions

Publisher side:

```sql
-- table list approach: only the listed tables are published; later new tables must be added manually
CREATE PUBLICATION pub_app FOR TABLE orders, order_items;

-- whole-database approach: automatically includes future new tables (excluding sequences; DDL still isn't synced)
CREATE PUBLICATION pub_all FOR ALL TABLES;

-- PG 15+ supports row filters and column lists
CREATE PUBLICATION pub_hot FOR TABLE orders WHERE (status = 'paid');

-- adding/removing tables later
ALTER PUBLICATION pub_app ADD TABLE customers;
ALTER PUBLICATION pub_app DROP TABLE order_items;
```

Subscriber side (build the table structure first — see the DDL section below):

```sql
CREATE SUBSCRIPTION sub_app
  CONNECTION 'host=10.0.0.11 port=5432 dbname=appdb user=replicator password=...'
  PUBLICATION pub_app
  WITH (copy_data = true, create_slot = true);
```

`copy_data = true` runs a full initial sync first; `create_slot = true` automatically creates a logical slot on the publisher. Each subscription corresponds to one logical replication slot on the publisher.

## Initial data sync and slot management

Initial sync proceeds table by table: each table is handled by a tablesync worker that creates a temporary slot, COPYs the full snapshot, then catches up on the delta, after which it merges into the regular apply stream. Parallelism is limited by `max_sync_workers_per_subscription`; during the first sync of a large database, the publisher needs attention to WAL retention caused by temporary slots, and the subscriber to disk and IO.

```sql
-- subscriber side: sync state per table (r=ready, s=syncing, i=initializing)
SELECT srrelid::regclass AS table_name, srsubstate
FROM pg_subscription_rel ORDER BY srsubstate, 1;

-- subscriber side: is the apply worker running, and when was the last message received
SELECT subname, pid, received_lsn, last_msg_send_time, last_msg_receipt_time
FROM pg_stat_subscription;
```

Tables without a primary key can only replicate INSERTs by default; UPDATE/DELETE will error out — unless the publisher sets `ALTER TABLE ... REPLICA IDENTITY FULL` (at the cost of writing the whole old row into WAL). Check every table's primary key before creating a subscription.

## DDL is not synchronized: the two-sided change flow

Logical replication only passes row changes; all DDL must be executed manually on both sides. A safe ordering for "add a column," for example:

```sql
-- step 1: add the column on the subscriber first (with a default; PG 11+ non-volatile defaults don't rewrite the table)
ALTER TABLE orders ADD COLUMN channel text NOT NULL DEFAULT 'web';

-- step 2: add the column on the publisher; row events from here on carry the new column value
ALTER TABLE orders ADD COLUMN channel text NOT NULL DEFAULT 'web';

-- step 3: check \d orders on both sides to confirm the structures match
```

When the subscriber adds the column first, row events in the publisher's old format don't contain the new column, and the subscriber supplies the default value at apply time — no error. The reverse order for dropping a column is to drop it on the publisher first, then the subscriber. Put changes with this kind of two-sided ordering dependency into your migration tool's release scripts (see [Schema Migration Tools](../tools/schema-migration-tools)) rather than relying on a DBA's memory.

## Conflict handling: skipping and redoing primary key conflicts

A typical conflict: a row with the same primary key already exists on the subscriber (duplicate initialization, bidirectional writes, manual data fixes). The apply step reports `duplicate key value violates unique constraint`, the apply worker stalls, the subscriber stops catching up, and the publisher's WAL then piles up. Handling flow:

```sql
-- 1. pause the subscription on the subscriber side
ALTER SUBSCRIPTION sub_app DISABLE;

-- 2. handle the conflicting row: delete the extra row, or change it to match the upstream value
DELETE FROM orders WHERE id = 42;

-- 3. skip the failing LSN (the error message and logs give the origin name and specific LSN;
--    the origin name looks like pg_<subscription OID>, or query the pg_replication_origin view)
SELECT * FROM pg_replication_origin;
SELECT pg_replication_origin_advance('pg_16391', '0/2A1B3C8');

-- 4. resume the subscription
ALTER SUBSCRIPTION sub_app ENABLE;
```

`pg_replication_origin_advance` skips a run of changes from that LSN onward — make sure nothing else you need is in that run before you run it. A safer route is to replay that run in a test environment first and check the impact. Distinguish the scenarios: if data should be authoritative from the publisher, skip the local row; if local data must not be overwritten, change the upstream row first and then continue.

## Slot lag monitoring and max_slot_wal_keep_size

A stopped subscription or an apply error that stalls will freeze the publisher's logical slot, and `pg_wal` grows without bound — just like physical slots, a frequent cause of full disks.

```sql
-- publisher side: logical slot lag in bytes
SELECT slot_name, active, confirmed_flush_lsn,
       pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes
FROM pg_replication_slots WHERE slot_type = 'logical';

-- subscriber side: apply/sync error counts (PG 14+); non-zero means a conflict is blocking
SELECT subname, apply_error_count, sync_error_count
FROM pg_stat_subscription_stats;
```

Setting `max_slot_wal_keep_size` on the publisher (PG 13+) caps the retained WAL: slots over the limit are marked invalid and the subscription must be recreated (losing a run of data). It's a fuse for the disk, not a means of resolving conflicts — build alerts on `lag_bytes` and `apply_error_count` so the fuse never has to blow.

## Practice for adding large tables to a publication

- Extending an existing subscription directly: after `ALTER PUBLICATION ... ADD TABLE big_table`, run `ALTER SUBSCRIPTION sub_app REFRESH PUBLICATION WITH (copy_data = true)` on the subscriber, and the new table gets a full sync. Tablesync workers consume resources during the sync, so run it in the low-traffic window.
- **Per-table control**: for TB-scale tables, create a dedicated publication + subscription just for it, and decide after the initial sync completes and catches up whether to fold it into the main subscription — this avoids one large table blocking other tables' initial-sync queue.
- **Partitioned tables**: PG 13+ lets you hang a partitioned parent table into a publication, and each partition's changes are published with it; on the subscriber, decide per the structure whether to keep partitioning (the default) or write into a non-partitioned table with `publish_via_partition_root = true`. Older versions require listing each partition individually, and remember to add new partitions after creating them.
- After syncing, verify the data: row counts plus checksums over a sample of key columns — `lag = 0` does not mean the data is consistent.

## Caveats and common pitfalls

- **Table structure first**: running `ADD TABLE` when the subscriber hasn't created the table makes apply fail with "relation does not exist" and stall.
- **Sequences aren't synchronized**: `SEQUENCE` is outside the scope of logical replication; manually `setval` the sequences before a migration cutover.
- **Latency spikes from large transactions**: a batch `UPDATE` of tens of millions of rows on the publisher isn't propagated until the whole transaction commits, so the apply side shows a single large latency spike. Break batch writes into smaller batches — see [Batch and Write Optimization](../advanced-sql/batch-and-write).
- **`TRUNCATE` is replicated** (PG 11+, publications default to `publish = 'insert, update, delete, truncate'`); watch out for accidental wipes when the downstream is a cache or aggregation table.
- **Bidirectional writes are a conflict generator**: if both sides can write the same primary key, conflicts happen continuously. PG 16's origin support solves loops, not business conflicts.

## Further reading

- [PostgreSQL official docs · Chapter 25. Backup and Restore](https://www.postgresql.org/docs/current/backup.html)
- [PostgreSQL official docs · Chapter 19. Server Configuration](https://www.postgresql.org/docs/current/runtime-config.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Logical Replication Internals](../internals/logical-replication-internals)
- [Version Upgrades](./version-upgrade)
- [Backup Strategy](./backup-strategy)
- [Ops SOPs](./ops-sop)
- [fdw-and-foreign-data](/ecosystem/fdw-and-foreign-data.md)
- [postgresql-17-features](/ecosystem/postgresql-17-features.md)
- [logical-replication-internals](/internals/logical-replication-internals.md)
- [index](index.md)
- [version-upgrade](version-upgrade.md)
