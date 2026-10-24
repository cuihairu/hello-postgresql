# Plan Cache and Generic Plans

Homologous SQL executed repeatedly in an application (only the parameters differ) has no need to be replanned every time. PostgreSQL caches the execution plan of a prepared statement **within the session**, and switches between "planning with the real parameters substituted" (custom plan) and "a parameter-free generic plan" (generic plan). This mechanism saves planning overhead, but brings parameter-sniffing-style plan drift problems — the same SQL suddenly getting slower often comes from here.

## The Two Entry Points for Prepared Statements

- SQL level: `PREPARE` / `EXECUTE` / `DEALLOCATE`, which you can experiment with directly in psql.
- Protocol level (extended query): implemented by drivers using Parse / Bind / Execute messages; JDBC's `PreparedStatement` and libpq's `PQexecParams` both belong to this class. After executing several times, the driver upgrades it to a **named statement**, entering the server-side plan cache flow.

Two things in common: the plan cache is **private to each session**, with no cross-session shared pool (this differs from databases like Oracle); when the session ends and the connection is returned to the pool, the cache is released. To see what the current session has cached:

```sql
SELECT name, statement, prepare_time,
       custom_plans, generic_plans
FROM pg_prepared_statements;
```

## Switching Between Custom and Generic Plans

For each named prepared statement:

1. **The first 5 executions** all use a custom plan — substituting the actual parameter values and planning with statistics (equal to replanning each time).
2. **From the 6th onward**, the planner generates a generic plan and estimates its cost; if its cost is **no higher than** the average cost of the first 5 custom plans, switch to generic and cache it for reuse; otherwise keep using the custom plan (replanning each time).

`plan_cache_mode` can change this behavior (PG 12+, settable at session level):

| Value | Behavior |
| --- | --- |
| `auto` (default) | the 5-execution heuristic above |
| `force_custom_plan` | always plan with real parameters, don't cache generic |
| `force_generic_plan` | skip the comparison, go straight to generic |

`EXPLAIN EXECUTE stmt(params)` shows the plan actually in use at the moment; the `custom_plans`/`generic_plans` counters in `pg_prepared_statements` tell you which step it has reached.

## Parameter Sniffing: Generic Gets Slower Under Skew

When planning a generic plan the parameter values are unknown, so equality conditions can only be guessed an "average selectivity" from statistics. When data is clearly skewed, this average plan hurts one side:

```sql
CREATE TABLE orders (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status text NOT NULL
);
INSERT INTO orders (status)
SELECT CASE WHEN g % 100 = 0 THEN 'pending' ELSE 'done' END
FROM generate_series(1, 1000000) g;
CREATE INDEX ON orders (status);
ANALYZE orders;

PREPARE q(text) AS SELECT count(*) FROM orders WHERE status = $1;
```

`done` makes up 99% and `pending` 1%:

```sql
-- First execution (custom plan, parameters substituted into statistics): uses the index, millisecond scale
EXPLAIN EXECUTE q('pending');

-- After EXECUTEing 5 times in a row:
EXPLAIN EXECUTE q('pending');
-- generic plan estimates rows at 50% for each status → switches to Seq Scan, low-frequency value queries get an order of magnitude slower
```

Order of countermeasures:

- Set `SET plan_cache_mode = force_custom_plan;` on that business's connections (a more common approach is to give such services their own role, `ALTER ROLE app_rw SET plan_cache_mode = ...`).
- Or on the application side, split the two semantics into two textually different SQL statements, each forming its own cache, so the high-frequency path caches generic while the low-frequency path isn't dragged along.
- Be aware of the reverse direction too: simple high-QPS queries that keep using custom plans will have their benefit noticeably eaten by the per-plan CPU overhead, in which case `force_generic_plan` is actually the optimization.

## Invalidation Boundaries of the Session Cache

A cached plan is invalidated and replanned in the following cases:

- **Definition changes** to related objects: DDL such as `ALTER TABLE`, `DROP INDEX`, `TRUNCATE` sends invalidation messages, and the next execution replans.
- Session end, `DEALLOCATE`.

One thing not in the invalidation scope, and easy to trip over:

- **`ANALYZE` updating statistics does not invalidate an already cached generic plan**. The row-count estimate in the old plan is already frozen, and even if the statistics change it won't automatically reselect. After statistics drift, if you want it to replan, you have to rebuild the statement (re-PREPARE) or rebuild the connection.

When investigating "statistics updated but the plan didn't change", first confirm whether the statement went through the cache, then decide whether to rebuild.

## Application-Side Prepared Pools and pgbouncer Transaction Mode

A named prepared statement is bound to **one specific physical connection**. When pgbouncer pools in transaction mode, two statements from the same client may land on different backend connections: the Parse message stays on connection A, but the Bind is sent to connection B, so it errors with `prepared statement "..." does not exist`. The driver's default prepared behavior must be handled under this architecture:

- pgbouncer 1.21+ supports tracking protocol-level prepared statements in transaction mode (`max_prepared_statements`), replaying Parse on demand across backend connections; older versions have no such path.
- JDBC's fallback is the connection string `preferQueryMode=simple`, which fully falls back to the simple query protocol (giving up server-side prepared).
- The trade-off between planning time and connection count: prepared saves planning CPU, a transaction pool saves connections; if connections blow up first, protect the pool first, then quantify the planning overhead with planning time in `pg_stat_statements`.

## Notes and Common Pitfalls

- "The same SQL was fast yesterday but slow today" and the SQL text contains `$1`: first check whether the 6th execution switched to a generic plan — two steps, `EXPLAIN EXECUTE` plus `pg_prepared_statements`, localize it.
- This page discusses **execution plan caching**; EXPLAIN's row-count estimates come from `pg_statistic`, and how the two cooperate is in [The Optimizer Cost Model](./optimizer-cost-model) and [Statistics and ANALYZE](../performance/statistics-and-analyze).
- Note when testing: psql's `PREPARE` and a driver's extended query are two different entry points, but the server-side switching rules are the same; when reproducing problems prefer the driver's own connection parameters.

## References

- [PostgreSQL Official Docs · PREPARE](https://www.postgresql.org/docs/current/sql-prepare.html)
- [PostgreSQL Official Docs · 19.7. Query Planning](https://www.postgresql.org/docs/current/runtime-config-query.html#GUC-PLAN-CACHE-MODE)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [postgresql-16-features](/ecosystem/postgresql-16-features.md)
- [index](index.md)
- [query-execution-pipeline](query-execution-pipeline.md)
- [common-bad-plans](/performance/common-bad-plans.md)
- [connection-and-orm-optimization](/performance/connection-and-orm-optimization.md)
- [partition-pruning](/performance/partition-pruning.md)- [The Optimizer Cost Model](./optimizer-cost-model) — custom/generic costs are both computed by it.
- [Statistics and ANALYZE](../performance/statistics-and-analyze) — the source of selectivity.
- [pg_stat_statements](../performance/pg-stat-statements) — quantify planning overhead and statement time.
- [psql Advanced](../tools/psql-advanced) — interactive techniques for PREPARE/EXPLAIN EXECUTE.

Official docs: <https://www.postgresql.org/docs/current/sql-prepare.html> and <https://www.postgresql.org/docs/current/runtime-config-query.html#GUC-PLAN-CACHE-MODE>
