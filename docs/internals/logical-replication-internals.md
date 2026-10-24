# Logical Replication Internals

Logical replication sends the publisher's changes to the subscriber as **row-level events** (INSERT/UPDATE/DELETE/TRUNCATE), rather than transferring physical data blocks like streaming replication. The bridge in between is WAL logical decoding: reconstructing "which transaction changed which row" from the WAL. Understanding the three layers on this chain — wal_level, replication slots, publication/subscription — is what lets you predict its overhead and failure modes. For the division of labor compared with streaming replication, see [Streaming and Synchronous Replication](./streaming-replication-and-sync).

## The Overhead of wal_level=logical

Logical decoding needs the WAL to retain more information than crash recovery does (such as the before-image of the replica identity columns for UPDATE/DELETE), so the publisher must set `wal_level = logical` and be restarted:

- Even with no replication slots created at all, the WAL produced at the logical level is more than the default `replica` level; on write-heavy instances the WAL volume and archiving pressure are perceptible.
- Decoding itself happens in the walsender process on the primary; large transactions and high change rates eat the primary's CPU.

Confirm the current state:

```sql
SHOW wal_level;
```

## Logical Decoding and Replication Slots

The chain is: walsender reads WAL → rearranges into the reorder buffer by transaction → **only decodes and outputs at commit time** → output plugin encodes. The built-in plugin used by subscribers is `pgoutput`; for debugging you can create your own logical slot and look at the decoding output directly with `test_decoding`:

```sql
-- Publisher: create a logical slot and view the decoding output (test_decoding is part of contrib)
SELECT pg_create_logical_replication_slot('demo', 'test_decoding');

INSERT INTO orders (status) VALUES ('pending');
SELECT * FROM pg_logical_slot_get_changes('demo', NULL, NULL);
-- Output looks like table public.orders: INSERT: id[bigint]:1 status[text]:'pending'

SELECT pg_drop_replication_slot('demo');
```

The replication slot is the object that most deserves respect in this mechanism: the slot records consumption progress (`confirmed_flush_lsn`), and the primary **must retain all WAL after the slot**. If the subscriber goes down or consumption stalls, the primary's `pg_wal` keeps growing until the disk is full — this is the most typical logical replication incident. `max_slot_wal_keep_size` (PG 13+) can limit the retained amount; once exceeded the slot is marked `fail` and needs to be rebuilt and resynchronized. From PG 17 you can also sync logical slots to a physical standby (failover slot), so the subscription doesn't break when primary and standby switch.

```sql
-- How much the slot is lagging: the difference of two LSNs converted to bytes
SELECT slot_name, active, restart_lsn, confirmed_flush_lsn,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS retained_wal
FROM pg_replication_slots
WHERE slot_type = 'logical';
```

## The publication / subscription Model

- Publisher: `CREATE PUBLICATION`, specifying tables or `ALL TABLES`; from PG 15 row filtering (`WHERE`) and column lists are supported.
- Subscriber: `CREATE SUBSCRIPTION ... CONNECTION '...' PUBLICATION ...`, which actually starts a resident apply worker to receive and apply changes.
- **Initial table sync**: with `copy_data = true` (default), the subscription first does one full COPY copy of each published table (executed in parallel by `max_sync_workers_per_subscription`, default 2), then enters streaming incremental once it catches up. The first sync of large tables puts real pressure on the primary, so pick your window.

```sql
-- Publisher side
CREATE PUBLICATION orders_pub FOR TABLE orders;

-- Subscriber side
CREATE SUBSCRIPTION orders_sub
  CONNECTION 'host=primary dbname=app user=repl'
  PUBLICATION orders_pub;
```

## Replica Identity

The subscriber has to locate "the row that was changed" on its own table in order to perform UPDATE/DELETE, based on the publisher table's replica identity:

| Setting | Behavior |
| --- | --- |
| `DEFAULT` (default) | uses the primary key; no primary key is equivalent to NOTHING |
| `FULL` | all columns of the old row go into the WAL; WAL volume grows, and the subscriber matches rows by all columns, which is slow |
| `USING INDEX idx` | uses a specified unique non-partial index, cheaper on WAL than FULL and faster at locating |
| `NOTHING` | UPDATE/DELETE cannot be sent to the subscriber (errors out) |

A table without a primary key that needs to publish UPDATE/DELETE must have its replica identity changed explicitly, otherwise the first delete errors out:

```sql
ALTER TABLE orders REPLICA IDENTITY USING INDEX orders_status_idx;
```

## Things Explicitly Not Replicated

- **DDL is not replicated**: adding a column or changing a type on the primary does not propagate to the subscriber, so schema drift is the most common failure source for logical replication; in the workflow, complete the subscriber's DDL first, then make the publisher change.
- **Sequences are not replicated**: at cutover you have to manually `setval` the subscriber's `id` sequence to align, otherwise the first insert after the switch is a primary key conflict.
- Large objects, views, and materialized views are not in the scope of a publication. `TRUNCATE` is replicated (PG 11+).

## The Impact of Large and Long Transactions

Decoding outputs in commit order and only committed transactions are visible, so:

- One **long transaction running for hours**: all transactions after it have to wait for it in the reorder buffer, and the slot's `restart_lsn` doesn't advance → WAL keeps piling up, equivalent to a stalled consumption.
- Changes from a very large transaction accumulate in the buffer; exceeding `logical_decoding_work_mem` (PG 13+, default 64MB) spills to disk, increasing the primary's temp space and decoding time.
- Application-side countermeasures: break full-table UPDATEs and batch migrations into small transactions; avoid running hour-long large transactions on a database with live subscriptions.

Slot-level sending and spill statistics are visible directly in `pg_stat_replication_slots` (PG 14+) via (`spill_txns`/`spill_bytes`).

## Observation and Application Scenarios

```sql
-- Publisher side: subscription consumption progress and lag
SELECT application_name, state, sent_lsn, write_lsn, flush_lsn, replay_lsn
FROM pg_stat_replication;

-- Subscriber side: is the apply worker alive, error count (PG 15+)
SELECT subid, subname, received_lsn, latest_end_time FROM pg_stat_subscription;
SELECT subname, apply_error_count FROM pg_stat_subscription_stats;
```

Typical applications: **cross-version upgrade** — streaming replication requires the same version on both sides, whereas logical replication can go from 16 to 17, making it an online upgrade path alongside `pg_upgrade` (see [Version Upgrade](../operations/version-upgrade)); there's also CDC feeding downstream, dual-write cutover, and so on. For the operations surface (monitoring and alerts, rebuilding slots, resyncing), see [Logical Replication Operations](../operations/logical-replication-ops).

## Notes and Common Pitfalls

- Creating a slot without consuming = a ticking time bomb; monitoring must cover the retained WAL of `pg_replication_slots` (scripts in [Monitoring and Alerting](../operations/monitoring-and-alerting)).
- Changing replica identity to FULL amplifies the primary's WAL; measure the increment in a test environment first before going to production.
- Subscriber apply is single-worker sequential replay; the subscriber's throughput ceiling depends on the heaviest table, so write-hot tables are not a good fit for expecting linear write scaling via logical replication.

## References

- [PostgreSQL Official Docs · Chapter 29. Logical Replication](https://www.postgresql.org/docs/current/logical-replication.html)
- [PostgreSQL Official Docs · Chapter 47. Logical Decoding](https://www.postgresql.org/docs/current/logicaldecoding.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [postgresql-16-features](/ecosystem/postgresql-16-features.md)
- [postgresql-17-features](/ecosystem/postgresql-17-features.md)
- [index](index.md)
- [knowledge](/knowledge.md)
- [logical-replication-ops](/operations/logical-replication-ops.md)- [WAL Mechanism](./wal-mechanism) — the raw log being decoded.
- [Streaming and Synchronous Replication](./streaming-replication-and-sync) — how physical replication divides the labor.
- [Logical Replication Operations](../operations/logical-replication-ops) — the operations manual for building and troubleshooting.
- [Version Upgrade](../operations/version-upgrade) — the full cross-version upgrade flow via logical replication.

Official docs: <https://www.postgresql.org/docs/current/logical-replication.html> and <https://www.postgresql.org/docs/current/logicaldecoding.html>
