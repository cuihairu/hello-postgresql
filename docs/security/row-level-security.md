# Row-Level Security

Row Level Security (RLS) pushes the policy of "which rows are visible and which can be modified" down into the kernel: no matter how the SQL is written or whether the application forgot a WHERE clause, PostgreSQL appends the filter on every access to the table. It is the last line of defense for multi-tenant isolation, and it is also commonly used to constrain the data range of a read-only role. Be clear about the role it plays: RLS is suited to defense in depth, not to replacing application-level privilege logic.

## Turning RLS on: ENABLE and FORCE

RLS is enabled per table and takes effect together with a policy:

```sql
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
```

Once enabled, two kinds of role are **not bound by the policy**: superusers and roles with the `BYPASSRLS` attribute always bypass it, and the table owner bypasses it by default (so migration and backup tools keep working). To hold the owner to the same rules, add `FORCE`:

```sql
ALTER TABLE orders FORCE ROW LEVEL SECURITY;   -- the owner goes through the policy too
```

There is one rule easy to trip over: **a table with RLS enabled but no policy written returns no rows to a non-owner** (the default is deny all). You can use this directly as a "flip-the-switch ban", but it also means that in the window where you enable RLS and add the policy later, the application will suddenly see an empty table — in rollout order, creating the policy first and enabling after it is steadier.

## CREATE POLICY: USING and WITH CHECK

```sql
CREATE POLICY tenant_isolation ON orders
  FOR ALL                      -- applies to SELECT / INSERT / UPDATE / DELETE
  TO app_rw                    -- constrains only this role
  USING (tenant_id = current_setting('app.tenant_id')::int)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::int);
```

The split between the two clauses:

| Clause | When it is evaluated | Effect |
| --- | --- | --- |
| `USING` | Reading old rows: SELECT, and matching rows for UPDATE/DELETE | an invisible row is as good as nonexistent |
| `WITH CHECK` | Writing new rows: INSERT, and the new value for UPDATE | writing another tenant's data fails outright |

`FOR` can narrow to `SELECT` / `INSERT` / `UPDATE` / `DELETE` / `ALL`; omitting `TO` constrains all roles by default (including `PUBLIC`); when neither clause is written, the default is `true`. The merge rule for multiple policies: PERMISSIVE policies (the default) combine with **OR**, and a policy declared `AS RESTRICTIVE` combines with them by **AND** — commonly used to stack one "must always hold" hard constraint (such as "deleted rows are never visible").

## Context approach 1: one database role per tenant

The most direct way maps tenants (or user tiers) to roles, with the policy referencing `current_user`:

```sql
CREATE POLICY p ON orders FOR SELECT TO tenant_42
  USING (tenant_id = 42);
```

Usable while the role count stays controllable; one role per tenant across thousands of tenants bloats the role catalog and drives management cost up steeply, so most cases switch to the session-variable approach below.

## Context approach 2: the session variable current_setting

The application writes the tenant ID into a custom GUC at the start of the connection (or transaction), and the policy reads it:

```sql
-- application side: run at the head of every transaction
SELECT set_config('app.tenant_id', '42', true);   -- true = valid for the current transaction only

-- policy side
USING (tenant_id = current_setting('app.tenant_id')::int)
```

Two engineering details decide how reliable this scheme is:

- The second argument of `current_setting('app.tenant_id', true)`, `missing_ok`, means it returns NULL instead of erroring when the value is unset — a NULL comparison is always false, so a forgotten context injection makes the whole table come back empty, which is the safe failure direction; a sturdier form is `NULLIF(current_setting('app.tenant_id', true), '')::int`.
- Use `SET LOCAL` / `set_config(..., true)` (transaction-scoped) rather than `SET` (session-scoped): the context clears automatically when the connection returns to the pool. If you do use session scope, make sure to `RESET ALL` before returning the connection, otherwise the next tenant that borrows it sees the previous tenant's data.

## A complete multi-tenant example

```sql
CREATE TABLE orders (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  int NOT NULL,
  amount     numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON orders (tenant_id, created_at);   -- the policy filter rides on this index

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_rw ON orders
  FOR ALL TO app_rw
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int);
```

## Performance and plan impact

- The policy condition is appended to every scan of this table; on large tables, focus on confirming the `tenant_id` filter can use an index (the composite index above was built for it).
- One known planner limit: a policy condition based on `current_setting()` is "opaque" to the planner and **cannot match a partial index whose predicate hard-codes a constant** (such as `CREATE INDEX ... WHERE tenant_id = 42`); the planner cannot prove the policy condition implies that index predicate. When you need that index benefit, fall back to a plain composite index, or write the tenant predicate explicitly into the business query alongside the index.
- Policy conditions are treated as `security_barrier`, which blocks the planner from pushing and merging query conditions; plans over complex views can degrade once RLS is layered on, so compare plans with and without it via EXPLAIN before release.
- A `SECURITY DEFINER` function runs as its owner, and a table without `FORCE` bypasses RLS inside the function — that is both a way to do "full-table background processing" and a potential accidental escalation surface; think it through before using it.

## How application middleware injects the context

The crux of integration is "inject in every transaction, and inject before the business SQL", which you get by hooking into the framework's single entry point:

```plaintext
request arrives → open a transaction
  → set_config('app.tenant_id', <current tenant>, true)
  → run the business SQL (no hand-written tenant filter needed; RLS is the backstop)
  → commit/rollback (the transaction-scoped GUC dies with the transaction, so the connection returns to the pool clean)
```

Every framework has a hook point: Django runs `cursor.execute("SELECT set_config('app.tenant_id', %s, true)", ...)` per connection in middleware; Go's `database/sql` runs it before the first statement of each transaction; Node's pg pairs a connect hook with transaction wrapping. Transaction-mode pooling (such as PgBouncer) is naturally compatible with `SET LOCAL`; in session mode you have to guarantee the RESET yourself. Entry points that skip the middleware and hit the database directly (psql, BI tools, cron scripts) never pass through the injection channel — contain their origin via [pg_hba and authentication](./pg-hba-and-authentication) and grant them separately.

## Caveats and common pitfalls

- `ENABLE` alone with no policy makes a non-owner immediately see an empty table — add the policy before sending traffic.
- Unique constraints and primary keys are not bound by RLS: a conflict error can probe "does this ID exist in another tenant", so keep this side channel in mind in ultra-sensitive scenarios.
- `TRUNCATE` has no row-level notion and no policy can stop it; do not grant `TRUNCATE` to business roles.
- `COPY FROM` is bound by `WITH CHECK`, `COPY TO` by `USING` (superusers and owners excepted).
- `UPDATE ... WHERE`, `ON CONFLICT`, and `RETURNING` may all implicitly require a `SELECT` policy on the affected rows; when the configuration is missing, the resulting error does not point at RLS directly.
- SQL injection can forge the tenant context with `set_config` — RLS is one layer of defense in depth, not a substitute for fixing an injection flaw.

## References

- [PostgreSQL official docs · 5.9. Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [PostgreSQL official docs · 20.3. Authentication Methods](https://www.postgresql.org/docs/current/auth-methods.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Roles and the Permission Model](./roles-and-permissions)
- [The Object Grant Hierarchy](./object-grant-hierarchy)
- [Multi-tenant modeling](../database-design/multi-tenant-modeling)
- [Hardening Checklist](./hardening-checklist)
- [multi-tenant-modeling](/database-design/multi-tenant-modeling.md)
- [views-and-updatable-views](/database-design/views-and-updatable-views.md)
- [pgvector](/ecosystem/pgvector.md)
- [knowledge](/knowledge.md)
- [index](index.md)
- [object-grant-hierarchy](object-grant-hierarchy.md)
- [roles-and-permissions](roles-and-permissions.md)
Official docs: [Row-level security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html), [CREATE POLICY](https://www.postgresql.org/docs/current/sql-createpolicy.html).
