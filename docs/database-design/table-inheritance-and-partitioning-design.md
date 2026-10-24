# Table Inheritance and Partitioning

Splitting one logical big table into multiple physical storage units has two routes in PostgreSQL: table inheritance (INHERITS) and declarative partitioning (`PARTITION BY`). Since PG 10 the official recommendation is declarative partitioning — partitions are components of the parent table, and routing, constraints, and indexes are all managed by the system; table inheritance is the older mechanism, where child tables are fully independent tables that the application layer must assemble itself. This page focuses on declarative partitioning, recording the three partitioning methods, default partitions, the restrictions the partition key imposes on primary keys, count and size guidance, and closing with a comparison of the two.

## PARTITION BY RANGE / LIST / HASH

```sql
-- RANGE partitions by time: orders archived monthly, the most common form
-- (declarative partitioning since PG 10)
CREATE TABLE orders (
    order_id   bigint GENERATED ALWAYS AS IDENTITY,
    user_id    bigint NOT NULL,
    amount     numeric(12,2) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (order_id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE orders_2026_09 PARTITION OF orders
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE orders_2026_10 PARTITION OF orders
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE orders_2026_11 PARTITION OF orders
    FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');

INSERT INTO orders (user_id, amount, created_at)
VALUES (1, 99.00, '2026-10-12 10:00+08');   -- auto-routed into orders_2026_10

-- Querying the parent table automatically scans only the matching partitions;
-- you can also confirm which partition each row landed in
SELECT tableoid::regclass AS partition, count(*) FROM orders GROUP BY 1;
```

Choose among the three partitioning methods based on the shape of the partition key:

| Method | Partition key | Best for |
|---|---|---|
| `RANGE` | Comparable range values (time, numbers) | Time-based archiving, splitting by ID ranges |
| `LIST` | Discrete enumerated values (region, tenant) | Isolating by region/tenant |
| `HASH` | Any column (hashed internally) | Even data distribution with no obvious range semantics |

```sql
-- LIST: multi-tenancy isolated by tenant id
CREATE TABLE events (
    id        bigint GENERATED ALWAYS AS IDENTITY,
    tenant_id int NOT NULL,
    payload   jsonb,
    PRIMARY KEY (id, tenant_id)
) PARTITION BY LIST (tenant_id);

CREATE TABLE events_t1 PARTITION OF events FOR VALUES IN (1);
CREATE TABLE events_t2 PARTITION OF events FOR VALUES IN (2);

-- HASH: a log table spread across 4 partitions by id
CREATE TABLE logs (
    id  bigint GENERATED ALWAYS AS IDENTITY,
    msg text,
    PRIMARY KEY (id)
) PARTITION BY HASH (id);

CREATE TABLE logs_p0 PARTITION OF logs FOR VALUES WITH (MODULUS 4, REMAINDER 0);
CREATE TABLE logs_p1 PARTITION OF logs FOR VALUES WITH (MODULUS 4, REMAINDER 1);
```

## Default Partitions

A default partition (since PG 11) catches every write that matches no existing partition, avoiding "routing failure straight to an error":

```sql
CREATE TABLE orders_default PARTITION OF orders DEFAULT;

INSERT INTO orders (user_id, amount, created_at)
VALUES (1, 1.00, '2027-01-05 00:00+08');   -- no matching partition, lands in default

SELECT count(*) FROM orders_default;
--  count
-- -------
--      1
```

The default partition is a double-edged sword: it stops insert errors, but data accumulating in it long-term means partition maintenance has fallen behind — and note that while a default partition exists, attaching a new partition to the table forces PG to scan the default one to confirm no out-of-range rows, which locks the table. The safe workflow is to build future partitions ahead of time and keep the default purely as a safety net.

## Primary Keys and Unique Constraints Must Include the Partition Key

**Every** primary key and unique constraint (including unique indexes) on a partitioned table must contain all partition key columns, or it errors outright:

```sql
-- Wrong: the primary key omits the partition key
CREATE TABLE bad_orders (
    order_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at timestamptz NOT NULL
) PARTITION BY RANGE (created_at);
-- ERROR: unique constraint on partitioned table must include all partitioning columns

-- Right: the primary key includes the partition key and becomes composite
CREATE TABLE orders (
    order_id   bigint GENERATED ALWAYS AS IDENTITY,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (order_id, created_at)
) PARTITION BY RANGE (created_at);
```

The reason: each partition holds its own independent indexes, so PG cannot guarantee global uniqueness across partitions unless the uniqueness check itself falls inside a single partition. This is the most commonly "discovered after the fact" limit of partitioned design — when the business requires `order_id` to be globally unique, global uniqueness must be guaranteed by the application layer or a sequence, and the database constraint degrades to uniqueness within `(order_id, created_at)`.

## Guidance on Partition Count and Size

- **Partition count**: dozens to a few hundred is right. Every query must do partition pruning and open partition metadata; with thousands of partitions the planning overhead becomes visible, and lock management gets heavier.
- **Size per partition**: set the granularity by growth rate; the rule of thumb is to keep a single partition in the GB range. Too fine and partitions explode; too coarse and you lose the value of archiving and pruning.
- **Use DETACH/DROP, not DELETE, to drop old data**: `DETACH PARTITION` is a metadata operation that finishes instantly and produces no dead tuples (PG 14 also supports `DETACH PARTITION … CONCURRENTLY`, which does not block queries).
- **The partition key cannot be updated in place**: updating a partition key means the row must move between partitions, which PG does not support — you must DELETE + INSERT. When picking a partition key, choose a column that "never changes after write".

```sql
-- Build next month's partition ahead of time so new data routes into it naturally
CREATE TABLE orders_2026_12 PARTITION OF orders
    FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

-- Archive: once an old partition is detached it can be renamed, exported,
-- or moved to cold storage
ALTER TABLE orders DETACH PARTITION orders_2026_09;
```

## Differences from Table Inheritance

| Dimension | Declarative partitioning (PG 10+) | Table inheritance (INHERITS) |
|---|---|---|
| Child table role | A component of the parent table; routing is transparent to the app | Fully independent tables that merely "declare where the columns came from" |
| Constraints and indexes | Defined on the parent, applied automatically to every partition | Defined per child table; the parent does not automatically inherit child constraints |
| Primary key / unique | Unified across all partitions, must include the partition key | Independent per child table, no cross-table guarantee |
| Write routing | INSERT auto-routes | The application decides which child table to write to |
| Read path | Parent queries prune automatically | Relies on CHECK constraints for constraint exclusion |
| Data deletion | DETACH/DROP finishes instantly | DROP each child table one by one |

Table inheritance query optimization depends on CHECK constraints on the child tables and the `constraint_exclusion` setting; the learning curve is steep and easy to get wrong. Unless you are maintaining a legacy system with historical baggage, there is no reason for a new system to use it instead of declarative partitioning. For the syntax details of both, see the official documentation on [Declarative Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html) and [Table Inheritance](https://www.postgresql.org/docs/current/tutorial-inheritance.html).

## References

- [PostgreSQL Documentation · 5.12. Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)
- [PostgreSQL Documentation · 5.5. Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- Subtree overview: [Database Design](/database-design/)

- [Primary Key Design](./primary-key-design)
- [Multi-Tenant Modeling](./multi-tenant-modeling)
- [Partition Pruning](../performance/partition-pruning)
- [Modeling Time](./time-modeling)
- [batch-and-write](/advanced-sql/batch-and-write.md)
- [index](index.md)
- [multi-tenant-modeling](multi-tenant-modeling.md)
- [citus](/ecosystem/citus.md)
- [timescaledb](/ecosystem/timescaledb.md)
- [brin](/indexing/brin.md)
- [composite-index-design](/indexing/composite-index-design.md)
- [capacity-and-scaling-limits](/performance/capacity-and-scaling-limits.md)
- [partition-pruning](/performance/partition-pruning.md)
