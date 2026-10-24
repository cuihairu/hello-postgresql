# Views and Updatable Views

A view is "a stored query": it saves no data, only a SELECT definition, and every view query executes the underlying SQL in real time. Here I organize why simple views can be INSERT/UPDATE/DELETEd directly, the checklist of auto-update rules, how WITH CHECK OPTION blocks out-of-range writes, and the tradeoffs between views, CTEs, and subqueries.

## A View Is a Stored Query

```sql
CREATE TABLE users (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username   text NOT NULL,
    level      int NOT NULL DEFAULT 0,
    deleted_at timestamptz
);

INSERT INTO users (username, level) VALUES ('alice', 5), ('bob', 2), ('carol', 7);

CREATE VIEW active_users AS
SELECT id, username, level
FROM users
WHERE deleted_at IS NULL;

-- Querying a view is just like querying a regular table — always the latest data
SELECT * FROM active_users ORDER BY level DESC;

-- The definition lives in the system catalog and can be inspected anytime
SELECT pg_get_viewdef('active_users', true);
```

Typical uses for views: give a complex query a stable name so the application does not reassemble JOINs over and over; expose a subset of a table for permission isolation (`GRANT SELECT ON view TO role`, without granting on the underlying table); shield against underlying table structure changes (the view definition is updated, the external interface stays the same). It caches no data at all — to keep a snapshot, use a [materialized view](./materialized-views).

## Simple Views Can Be Updated Automatically

A view can be written to directly, with PG rewriting the operation against the underlying table, when all of the following hold:

- The view has exactly one data source: exactly one table in the `FROM` (or another updatable view);
- The top level contains no `WITH`, `DISTINCT`, `GROUP BY`, `HAVING`, `LIMIT`, `OFFSET`, or `UNION/INTERSECT/EXCEPT`;
- The output columns contain no aggregate functions, window functions, or set-returning functions.

```sql
-- Updatable: single table, no aggregates, no DISTINCT/GROUP BY/LIMIT
CREATE VIEW vip_users AS
SELECT id, username, level
FROM users
WHERE level >= 5;

-- Write directly; this is equivalent to operating on the matching rows in users
UPDATE vip_users SET level = 6 WHERE id = 2;
INSERT INTO vip_users (username, level) VALUES ('dave', 5);
DELETE FROM vip_users WHERE id = 3;
```

Views with aggregates, JOINs, or DISTINCT are not updatable by default; when you genuinely need to write through such a view, take over the write logic with an `INSTEAD OF` trigger, or write to the underlying table directly. For the full checklist of auto-update rules, see the official documentation on [CREATE VIEW](https://www.postgresql.org/docs/current/sql-createview.html).

## WITH CHECK OPTION Blocks Out-of-Range Writes

For a view with a filter, a default write can land rows "where the view cannot see them" — the row exists in the underlying table but is unreachable through the view, which from the view's point of view means the data vanished:

```sql
CREATE VIEW vip_users AS
SELECT id, username, level
FROM users
WHERE level >= 5
WITH CHECK OPTION;

-- Lowering level below 5 moves the row outside the view's range and is rejected
UPDATE vip_users SET level = 3 WHERE id = 1;
-- ERROR: new row violates check option for view "vip_users"
```

`WITH CHECK OPTION` requires that every new row INSERTed through the view, and every row after an UPDATE, still satisfies the view's WHERE condition (`CASCADED`/`LOCAL` control whether the check propagates down the view chain). It solves a data-consistency problem, not a security one — restricting which rows a role can see should use RLS (see [Row-Level Security](../security/row-level-security)).

## security_barrier in One Line

A view created with `WITH (security_barrier)` prevents an outer query's predicates from being pushed inside the view and evaluated ahead of the view's own filter — protecting against user-defined functions being called on "rows they should not see" and leaking data. Add it when exposing restricted data through RLS; the cost is that such views lose auto-updatability and the planner has fewer pushdown optimizations to apply.

## Views vs CTE / Subquery

All three "wrap a piece of SQL"; they differ in lifetime and reuse boundary:

| Dimension | View | CTE (WITH) | Subquery |
|---|---|---|---|
| Definition location | In the database, persists across sessions | Within a single statement | Within a single statement |
| Reuse scope | Any query; can be granted separately | This statement only | This statement only |
| Materialization | Never materialized; executed in real time each time | Inlined by default on PG 12+, `MATERIALIZED` forces materialization | Up to the planner |
| Typical use | Stable interface, permission isolation | Recursive queries, decomposing a complex query into stages | One-off nesting |

Selection principle: if it is used only once in a single statement, a subquery or CTE is enough; only when it must be reused in many places, or permission isolation is needed, should you build a view. For CTE syntax and inlining behavior, see [CTEs and Non-Recursive WITH](../advanced-sql/cte-and-non-recursive-with).

## References

- [PostgreSQL Documentation · 5.5. Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
- [PostgreSQL Documentation · 5.12. Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Materialized Views](./materialized-views)
- [CTEs and Non-Recursive WITH](../advanced-sql/cte-and-non-recursive-with)
- [Row-Level Security](../security/row-level-security)
- [System Catalogs and Metadata](../basics/system-catalogs-and-metadata)
- [index](index.md)
- [materialized-views](materialized-views.md)
