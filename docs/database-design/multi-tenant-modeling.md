# Multi-Tenant Modeling

A SaaS application must serve multiple tenants from a single database, and the core tension is **the tradeoff between isolation strength and operational cost**: the more thorough the isolation, the harder bulk changes, cross-tenant statistics, and connection management become. PostgreSQL offers three levels of solution — a single table with `tenant_id`, row-level security (RLS), and schema-per-tenant — and this page analyzes each one's failure modes, their respective impact on backup and restore, capacity planning, and cross-tenant statistics, closing with a recommended path.

## Comparing the Three Approaches

| Dimension | Single table with tenant_id | Single table + RLS | schema-per-tenant |
| --- | --- | --- | --- |
| Isolation strength | Relies on coding discipline | Enforced by database policy | Separate namespace |
| DDL/migration cost | Run once | Run once | Run once per each of the N schemas |
| Cross-tenant statistics | Straight `GROUP BY` | Straight `GROUP BY` | Needs UNION or per-schema aggregation |
| Single-tenant backup/restore | Export by row, tedious | Same as left | Supported directly via `pg_dump -n` |
| Object scale | Fixed table count | Fixed table count | Tables = tenants x tables |
| Typical incident | A missing WHERE leaks tenants | Policy misconfigured, table owner bypassed | Catalog bloat, a slow tenant drags down the whole |

## Approach 1: A Single Table with tenant_id

The simplest and most common: add `tenant_id bigint NOT NULL` to every business table and filter explicitly in all queries.

```sql
CREATE TABLE orders (
  id         bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  bigint        NOT NULL,
  amount     numeric(12,2) NOT NULL,
  created_at timestamptz   NOT NULL DEFAULT now()
);

-- Business indexes always lead with tenant_id
CREATE INDEX orders_tenant_id_created_at_idx
  ON orders (tenant_id, created_at DESC);

-- Every business query must carry:
SELECT * FROM orders
WHERE tenant_id = 42
  AND created_at >= now() - interval '7 days';
```

The advantages are simple modeling, migration, and statistics. The fatal weakness is that **filtering is entirely human**: a single query missing `WHERE tenant_id = ...` is a cross-tenant data leak, and this class of incident is nearly impossible to exhaustively hunt down in code review. Mitigations: force-inject the filter at the ORM layer, add it to the code-review checklist, and stack a layer of RLS as a backstop (see below).

## Approach 2: Row-Level Security RLS

Layer RLS on top of the single-table approach to sink tenant filtering down to database policy, so that even SQL missing the condition cannot see another tenant's data:

```sql
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;   -- the table owner is bound by the policy too

CREATE POLICY tenant_isolation ON orders
  USING (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- The application injects the tenant context inside the transaction
BEGIN;
SET LOCAL app.tenant_id = '42';
SELECT count(*) FROM orders;    -- sees only tenant 42's rows
COMMIT;
```

Two details: `current_setting(..., true)` returns NULL rather than erroring when the variable is unset, `tenant_id = NULL` is always false, which delivers a **fail-closed behavior of seeing no rows at all when nothing is injected**; and `SET LOCAL` automatically expires with the transaction, preventing crosstalk in a connection pool. How policies get bypassed (`BYPASSRLS`, `SECURITY DEFINER` functions, table ownership) and their performance cost are covered in [Row-Level Security](../security/row-level-security).

RLS's cost: an extra layer of filter evaluation per query, policy and index must go together (without an index on the tenant column you get a sequential scan), and one more plan node in EXPLAIN while debugging. For the official explanation of the mechanism, see [row security policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

## Approach 3: schema-per-tenant

One schema per tenant, with identical table structure and fully isolated data:

```sql
CREATE SCHEMA tenant_42;
CREATE TABLE tenant_42.orders (LIKE public.orders INCLUDING ALL);

-- The application names the schema when connecting; business SQL needs no changes
-- Add to the connection string: options=-c search_path=tenant_42
```

Advantages: isolation is intuitive, and a single-tenant backup and restore is just `pg_dump -n tenant_42`, with capacity obvious per schema. The downsides scale linearly with tenant count: adding one column requires looping over N schemas (migration duration and retry-on-failure both need design); total tables = tenants x tables, so as catalog objects bloat the maintenance surface for psql meta-commands, monitoring, and autovacuum all grow; a shared connection pool is hard to quota-isolate per tenant, so one large tenant's slow queries still drag down the whole.

## Impact on Backup/Restore, Capacity Planning, and Cross-Tenant Statistics

- **Backup and restore**: the single-table approach needs a per-`tenant_id` export and re-import to restore one tenant, being careful not to pollute other tenants' sequences and foreign keys; the schema approach splits naturally by namespace, so restore granularity is clean. Whole-database physical backup (PITR) is identical across all three — the difference lies only in restore at **single-tenant granularity**, see [Backup Strategy](../operations/backup-strategy).
- **Capacity planning**: the single-table approach uses `pg_total_relation_size` with per-`tenant_id` row/byte statistics to estimate each tenant's share; the schema approach just aggregates per schema. When a large tenant needs physical isolation, two routes: a separate instance, or HASH-partition the large table by `tenant_id` — see [Table Inheritance and Partitioning](./table-inheritance-and-partitioning-design) and [Partition Pruning](../performance/partition-pruning).
- **Cross-tenant statistics**: the single-table/RLS approaches handle it with one SQL `GROUP BY tenant_id`; the schema approach either concatenates with UNION ALL or queries per schema and aggregates in the application, so reporting requirements keep paying a complexity tax.

## Recommended Path and Checklist

Where most SaaS lands: **a single table with `tenant_id` as the foundation, plus RLS layered on critical tables for defense in depth**; only consider schema-per-tenant or separate databases when tenant count is low, single-tenant data volume is large, or there are strong compliance isolation requirements. Giving every tenant its own database is usually not worth it — connection pooling and operational cost grow linearly with tenant count.

Verify item by item before going live:

- Every business table has `tenant_id bigint NOT NULL`, with no exceptions.
- Every secondary index leads with `tenant_id` (or includes it in the index prefix).
- Critical business tables have RLS enabled and FORCED, as the last line of defense when a filter is omitted.
- Tenant context is injected inside the transaction with `SET LOCAL`, never interpolated into SQL strings.
- A dedicated role with access to the full dataset is created for operations/statistics, and included in auditing.
- Migration templates always include the `tenant_id` column and its supporting index, avoiding misconfiguration on new tables.

## References

- [PostgreSQL Documentation · 5.5. Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
- [PostgreSQL Documentation · 5.12. Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Row-Level Security](../security/row-level-security)
- [From Logical Model to Physical Table](./logical-to-physical-modeling)
- [Table Inheritance and Partitioning](./table-inheritance-and-partitioning-design)
- [Backup Strategy](../operations/backup-strategy)
- [database-and-schema-objects](/basics/database-and-schema-objects.md)
- [index](index.md)
- [table-inheritance-and-partitioning-design](table-inheritance-and-partitioning-design.md)
- [knowledge](/knowledge.md)
- [row-level-security](/security/row-level-security.md)
