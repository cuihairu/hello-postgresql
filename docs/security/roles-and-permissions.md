# Roles and the Permission Model

PostgreSQL has no separate "user" system — every principal is a role: a role with the `LOGIN` attribute is what we usually call a user, while a role without `LOGIN` serves as a group role that carries privileges. The recommended pattern is not to grant privileges directly to individual login accounts, but to attach them to group roles with well-defined responsibilities; people and services gain their capabilities by joining those group roles. For which objects privileges ultimately land on and how to grant them, see [the object grant hierarchy](./object-grant-hierarchy); this page records roles themselves.

## CREATE ROLE and role attributes

`CREATE USER` is just an alias for `CREATE ROLE ... LOGIN`. What a role can do is determined by its attributes:

| Attribute | Meaning |
| --- | --- |
| `LOGIN` | Can log in; group roles usually don't set it |
| `SUPERUSER` | Bypasses every privilege check; reserve it for DBA operations accounts |
| `CREATEDB` | Can create databases |
| `CREATEROLE` | Can create, alter, and drop roles (other than superusers) |
| `REPLICATION` | Can be used for streaming replication connections |
| `BYPASSRLS` | Bypasses row-level security, see [Row-Level Security](./row-level-security) |
| `CONNECTION LIMIT n` | The role can hold at most n connections at the same time |

```sql
CREATE ROLE app_rw NOLOGIN;                                 -- group role: cannot log in
CREATE ROLE alice LOGIN PASSWORD 'S3cret!' IN ROLE app_rw;  -- create a user and join the group directly
CREATE ROLE repl_user LOGIN REPLICATION PASSWORD '...';     -- dedicated to streaming replication
ALTER ROLE alice NOLOGIN;                                   -- freeze on departure: disable login first, decide on dropping later
```

Attributes can be adjusted at any time with `ALTER ROLE`; the `pg_roles` view shows all role attributes directly, so you don't have to dig through `pg_authid`, which holds password hashes (readable only by superusers).

## Common forms of GRANT and REVOKE

The two most common forms: granting a group role to a person (membership), and granting object privileges to a role (the full rules of object grants are on the next page).

```sql
-- membership: alice gets everything app_rw has
GRANT app_rw TO alice;
GRANT app_rw TO alice WITH ADMIN OPTION;   -- alice can also grant this role to others
REVOKE app_rw FROM alice;

-- object privileges: grant to the group role, not to individuals
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_rw;
REVOKE DELETE ON orders FROM app_rw;       -- tighten on a per-table basis
```

`WITH ADMIN OPTION` only governs "can this role's membership be re-granted" and is a different thing from re-granting object privileges (`WITH GRANT OPTION`); don't mix them up. Since PG 16, `CREATEROLE` is tighter: a role holding it can only grant roles on which it itself holds ADMIN OPTION (roles it created have it by default) and can no longer add members to arbitrary other roles — before upgrading a shared instance or a multi-toolchain environment, confirm your existing scripts don't depend on the old behavior.

## Inheritance: IN ROLE, INHERIT, and SET ROLE

Role membership is **automatically inherited** by default: if `alice` is a member of `app_rw` and `app_rw` has `SELECT`, then `alice` can `SELECT` right away with no extra steps. This is controlled by the role's `INHERIT` attribute, which is on by default:

```sql
CREATE ROLE alice LOGIN NOINHERIT;   -- no automatic inheritance; switch identity manually
SET ROLE app_rw;                     -- alice executes as app_rw
RESET ROLE;                          -- switch back to alice herself
```

`IN ROLE` is just direction shorthand: `CREATE ROLE alice LOGIN IN ROLE app_rw` is equivalent to creating alice first and then running `GRANT app_rw TO alice`. `NOINHERIT` fits the "switchable identity" pattern: an admin is an ordinary role most of the time and does `SET ROLE app_owner` when the work needs it, avoiding permanently active high privileges; privilege checks apply to the current effective identity, so after `SET ROLE`, policies and auditing both see the new identity. Since PG 16 you can also control this per individual GRANT: `GRANT app_rw TO alice WITH INHERIT TRUE, SET FALSE;` — inherit the privileges but disallow switching into that role, at finer granularity.

## PUBLIC: the implicit role you cannot drop

`PUBLIC` is a pseudo-role that always exists and cannot be dropped; everyone (including roles created in the future) is a member of it. It holds several classes of privileges by default and is the root of many "accessible by default" problems:

```sql
-- by default: everyone can connect to any database, execute all functions, and use the public schema
REVOKE CONNECT ON DATABASE app FROM PUBLIC;              -- take back connect, grant to specific roles as needed
REVOKE EXECUTE ON FUNCTION gen_token(text) FROM PUBLIC;  -- sensitive functions no longer open to everyone
GRANT EXECUTE ON FUNCTION gen_token(text) TO app_rw;
```

For a full inventory of default privileges and tightening layer by layer, see [the object grant hierarchy](./object-grant-hierarchy).

## Password management

The password hashing algorithm is decided by `password_encryption`, and it takes effect **at the moment you set the password**: PG 10 introduced `scram-sha-256`, and from PG 14 on it is the default (previously the default was `md5`).

```sql
SHOW password_encryption;                    -- confirm the current algorithm
SET password_encryption = 'scram-sha-256';
ALTER ROLE app_svc PASSWORD 'new-password';  -- re-hash with the current algorithm
ALTER ROLE alice VALID UNTIL '2027-01-01';   -- login validity period

SELECT rolname, left(rolpassword, 12) AS hash_head
FROM pg_authid
WHERE rolcanlogin;                           -- starts with SCRAM-SHA-256$ = scram; starts with md5 = legacy hash
```

Two caveats: after upgrading to PG 14+, **existing passwords are not re-hashed automatically** — accounts still on md5 need a per-account `ALTER ROLE ... PASSWORD` reset; `VALID UNTIL` is only checked during login authentication and does not kick already-established connections. md5 still works in pg_hba but is no longer recommended; for choosing an authentication method see [pg_hba and authentication](./pg-hba-and-authentication).

## A minimal-privilege role design example

A common application role split: the owner never logs in, read-write and read-only are separate, and DDL changes go through their own path.

```sql
-- 1. group roles: all NOLOGIN, purely carry privileges
CREATE ROLE app_owner  NOLOGIN;   -- owner of tables, sequences, and other objects
CREATE ROLE app_rw     NOLOGIN;   -- application read-write
CREATE ROLE app_ro     NOLOGIN;   -- reporting / read-only

-- 2. object grants (tables are created by app_owner)
GRANT USAGE ON SCHEMA public TO app_rw, app_ro;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_ro;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;

-- 3. objects the owner creates in the future get the grants automatically, no manual patching per migration
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO app_ro;

-- 4. login accounts: one per person and service, joined into the group roles
CREATE ROLE app_svc LOGIN PASSWORD '...' IN ROLE app_rw;
CREATE ROLE alice  LOGIN PASSWORD '...' IN ROLE app_ro;

-- 5. DDL changes: the migration login account joins the owner group and gains schema-changing power through inheritance
CREATE ROLE app_owner_login LOGIN PASSWORD '...' IN ROLE app_owner;
```

Key points: application connection strings always use `app_svc`, never the owner directly; migration tools log in as `app_owner_login` to run DDL; reporting and BI always go through `app_ro`. When you need row-level visibility limits, layer [Row-Level Security](./row-level-security) on the tables.

## Caveats and common pitfalls

- Running the business over a superuser or owner connection is the largest single source of privilege problems: accidental deletes and updates cannot be constrained; the [hardening checklist](./hardening-checklist) lists it as item one.
- `SUPERUSER` bypasses RLS, privilege checks, and even `FORCE ROW LEVEL SECURITY`; do not grant it to any role beyond operations accounts.
- Forgetting `ALTER DEFAULT PRIVILEGES` is the most common cause of "can't query the new table": GRANT only affects objects that already exist.
- Handle dependencies before dropping a role: `DROP ROLE` fails with "still depended upon"; run `REASSIGN OWNED BY alice TO app_owner;` and `DROP OWNED BY alice;` first, then drop.
- Roles are **instance-level**: all databases on one instance share the same set of roles. When multiple businesses share an instance, separate them with naming prefixes so privileges don't bleed across databases.

## References

- [PostgreSQL official docs · 5.9. Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [PostgreSQL official docs · 20.3. Authentication Methods](https://www.postgresql.org/docs/current/auth-methods.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- Subtree overview: [Security](/security/)

- [The Object Grant Hierarchy](./object-grant-hierarchy)
- [Row-Level Security](./row-level-security)
- [pg_hba and Authentication](./pg-hba-and-authentication)
- [Hardening Checklist](./hardening-checklist)
- [sql-functions-advanced](/advanced-sql/sql-functions-advanced.md)
- [sql-command-reference](/appendix/sql-command-reference.md)
- [database-and-schema-objects](/basics/database-and-schema-objects.md)
- [functions-and-operators](/basics/functions-and-operators.md)
- [extension-management](/ecosystem/extension-management.md)
- [fdw-and-foreign-data](/ecosystem/fdw-and-foreign-data.md)
- [postgresql-16-features](/ecosystem/postgresql-16-features.md)
- [knowledge](/knowledge.md)
- [disaster-recovery-drills](/operations/disaster-recovery-drills.md)
- [hardening-checklist](hardening-checklist.md)
- [index](index.md)
- [object-grant-hierarchy](object-grant-hierarchy.md)
- [pg-hba-and-authentication](pg-hba-and-authentication.md)
- [row-level-security](row-level-security.md)
- [dbeaver-and-vscode](/tools/dbeaver-and-vscode.md)
- [pgadmin-4](/tools/pgadmin-4.md)
Official docs: [CREATE ROLE](https://www.postgresql.org/docs/current/sql-createrole.html), [Role membership](https://www.postgresql.org/docs/current/role-membership.html), [Database roles](https://www.postgresql.org/docs/current/database-roles.html).
