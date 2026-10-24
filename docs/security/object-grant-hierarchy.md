# The Object Grant Hierarchy

After `GRANT SELECT` on a table, queries still fail with permission errors — most likely some upstream layer is not open: PostgreSQL object privileges take effect along three layers, **database → schema → object (table/sequence/function/column)**; if `CONNECT` or `USAGE` is missing at any layer, no amount of lower-layer privileges will help. When troubleshooting, confirm layer by layer from the top down — much faster than staring at the GRANT on the table. For how to create and organize roles themselves, see [Roles and the Permission Model](./roles-and-permissions).

## Database layer: CONNECT

A newly created database allows everyone to connect by default (`CONNECT` is granted to `PUBLIC`). When an instance runs multiple businesses, take this default grant away first:

```sql
REVOKE CONNECT ON DATABASE app FROM PUBLIC;
GRANT CONNECT ON DATABASE app TO app_rw, app_ro;
```

`CREATE` (creating schemas inside the database) and `TEMP` (creating temp tables) are also database-level privileges; business roles generally don't need them granted separately.

## Schema layer: USAGE

`USAGE` on a schema decides whether you can "see and use" the objects inside; without it, even with `SELECT` on the table, access fails with `permission denied for schema`. Note that `USAGE` is not `CREATE`: the latter decides whether you can **create new** objects in the schema. Since PG 15 the default has tightened one step — `CREATE` on the `public` schema is no longer granted to `PUBLIC` (historically anyone could create objects in public, a default exposure surface), but `USAGE` remains open to everyone; watch out for this behavior difference in cross-version upgrades.

```sql
GRANT USAGE ON SCHEMA app TO app_rw;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;   -- versions before PG 15 need to revoke it manually
```

## Tables and sequences

Table-level privileges come in seven kinds: `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER` — you can grant several at once:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA app TO app_ro;
```

Sequences are independent objects: to `INSERT` into a table with a `serial` / `IDENTITY` column you also need `USAGE` on that sequence (the right to call nextval); missing it raises `permission denied for sequence`. This is the most commonly forgotten layer of object grants:

```sql
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO app_rw;
```

## Column-level grants

When you only need to expose some columns, narrow the GRANT down to columns:

```sql
REVOKE SELECT ON users FROM app_ro;
GRANT SELECT (id, email, created_at) ON users TO app_ro;
-- app_ro querying password_hash will hit permission denied for column
```

The semantics of column-level privileges are "only these columns are granted": when table-level `SELECT` no longer exists, `SELECT *` fails because it includes columns you lack — in application code, writing explicit column names is safer than `SELECT *`. Column-level `INSERT` / `UPDATE` work the same way, allowing writes only to named columns.

## Function EXECUTE is granted to PUBLIC by default

Every function is automatically granted `EXECUTE` to `PUBLIC` when created, so anyone can call any function in the database. This matters a lot when you wrap privileged operations in a `SECURITY DEFINER` function, or you open the escalation path to everyone:

```sql
REVOKE EXECUTE ON FUNCTION purge_expired_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_expired_sessions() TO maintenance;
```

## DEFAULT PRIVILEGES: why a new table has no privileges

`GRANT ... ON ALL TABLES` only affects objects that **already exist**. Run the migration again, `app_owner` creates another new table, and the privileges are broken the moment they're missing — unless you declare default privileges up front, so that "tables this owner creates in the future" carry the grants automatically:

```sql
ALTER DEFAULT PRIVILEGES
  FOR ROLE app_owner            -- applies only to objects app_owner creates later
  IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;

ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA app
  GRANT SELECT ON TABLES TO app_ro;
```

Three easy mistakes: default privileges bind to the **owner role + schema**, so if someone else creates the table it won't apply — get the `FOR ROLE` right when you declare it; the template itself can be modified anytime with `ALTER DEFAULT PRIVILEGES ... REVOKE`; and it does nothing for existing tables, so patching privileges still needs an explicit `GRANT ... ON ALL TABLES`. This is also the answer to "why must a new table be granted privileges explicitly": PostgreSQL grants do not auto-spread when an object is created, and the default-privileges mechanism is the official channel that does.

## Hiding information is a schema job, not a table job

The system catalogs (`pg_catalog`, `information_schema`) are open to all users, so revoking table privileges cannot make table names "invisible" to others — a query without privilege will name the object it failed on. Real information isolation happens at the schema layer: move sensitive tables into a separate schema, revoke `USAGE`, and the object listing disappears along with the data:

```sql
CREATE SCHEMA hr;
REVOKE ALL ON SCHEMA hr FROM PUBLIC;
GRANT USAGE ON SCHEMA hr TO hr_rw;
```

## Troubleshooting: who actually holds what privilege

```sql
-- in psql, \dp (equivalent to \z) shows object ACLs directly; from SQL, confirm ownership first
SELECT schemaname, tablename, tableowner FROM pg_tables WHERE schemaname = 'app';

-- what tables the PUBLIC pseudo-role can still read (find unexpected exposure)
SELECT schemaname, tablename
FROM pg_tables
WHERE has_table_privilege('public', schemaname || '.' || tablename, 'SELECT');

-- check a specific role precisely
SELECT has_table_privilege('app_ro', 'app.orders', 'SELECT');   -- t / f

SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'app' AND table_name = 'orders';
```

Passing `'public'` to `has_table_privilege` means the PUBLIC pseudo-role, so you can scan every "readable by default" table directly. In the ACL column of `\dp` output, letter codes like `arwdDxt` stand for insert, delete, update, select and so on.

## Caveats and common pitfalls

- The error message tells you the layer: `permission denied for database`, `for schema`, `for table`, `for sequence` each point at one layer — don't reflexively edit the table GRANT.
- Sequence privileges are the most commonly forgotten layer; a `serial` primary key exposes it on the first insert.
- `SELECT *` failing after a column-level grant is often misread as "the grant didn't take"; first check whether the table-level privilege was fully revoked.
- The `information_schema` grant views list only explicit GRANTs and don't reflect the implicit privileges an owner carries — an owner always has full power over what it created.
- Hanging grants on group roles, together with `ALTER DEFAULT PRIVILEGES`, is far more maintainable than scattered per-person grants.

## References

- [PostgreSQL official docs · 5.9. Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [PostgreSQL official docs · 20.3. Authentication Methods](https://www.postgresql.org/docs/current/auth-methods.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Roles and the Permission Model](./roles-and-permissions)
- [Row-Level Security](./row-level-security)
- [Databases and schema objects](../basics/database-and-schema-objects)
- [Hardening Checklist](./hardening-checklist)
- [fdw-and-foreign-data](/ecosystem/fdw-and-foreign-data.md)
- [knowledge](/knowledge.md)
- [hardening-checklist](hardening-checklist.md)
- [index](index.md)
- [roles-and-permissions](roles-and-permissions.md)
- [row-level-security](row-level-security.md)
Official docs: [GRANT](https://www.postgresql.org/docs/current/sql-grant.html), [Privileges](https://www.postgresql.org/docs/current/ddl-priv.html), [ALTER DEFAULT PRIVILEGES](https://www.postgresql.org/docs/current/sql-alterdefaultprivileges.html).
