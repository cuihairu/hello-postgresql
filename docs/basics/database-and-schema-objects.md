# Databases and Schema Objects

PostgreSQL's objects are organized into four layers, from largest to smallest: **cluster → database → schema → relational objects such as tables, views, and indexes**. Each layer has its own owner, and privileges are granted layer by layer. Once these four layers are clear, problems like `search_path`, cross-schema references, and `\dt` not showing a table all have one unified explanation. Corresponding official docs: [Schemas](https://www.postgresql.org/docs/current/ddl-schemas.html) and [Database management](https://www.postgresql.org/docs/current/managing-databases.html).

## The four layers and their owners

```text
cluster (one PGDATA data directory + a set of processes)
└── database: appdb            ← owner: postgres
    └── schema: public         ← owner: pg_database_owner
        ├── table: users       ← owner: app
        ├── view: v_active
        └── index: users_pkey
```

- A **cluster** is created by `initdb` and is a physical concept: one data directory, a set of background processes, one `postgresql.conf` / `pg_hba.conf`. A cluster can hold multiple databases, and **the database in a connection string is a hard boundary** — cross-database queries require an FDW or `dblink`, you cannot JOIN directly.
- A **database** is the boundary of privileges and connections; `CREATE DATABASE appdb OWNER app;` specifies the owner.
- A **schema** is a namespace inside a database, grouping tables, views, functions, and types. Within the same database you can JOIN across schemas directly.
- **Tables, views, indexes, sequences, functions, types** and other objects belong to a schema, and each object also has an owner (a role).

An owner is "whoever creates it owns it": the person who creates a table automatically becomes the table owner, and the owner by default holds all privileges on that table and can `GRANT` further to others. DDL privileges such as dropping an object or changing its structure go only with the owner (or a superuser) and are a separate matter from query privileges.

## Common database and schema operations

```sql
-- database level (CREATE DATABASE must be run while connected to some database)
CREATE DATABASE shop OWNER app ENCODING 'UTF8';

-- schema level
CREATE SCHEMA sales;                      -- create a namespace
CREATE SCHEMA IF NOT EXISTS sales AUTHORIZATION app;  -- specify owner
CREATE TABLE sales.orders (               -- create a table under a given schema
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    region      text NOT NULL,
    amount      numeric(10,2) NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO sales.orders (region, amount) VALUES
    ('north', 120.50), ('south', 88.00);

-- drop a schema (CASCADE also drops the objects inside it — use with care)
-- DROP SCHEMA sales CASCADE;
```

## The public schema and the PG15+ privilege tightening

Every database comes with a default `public` schema. In PG 14 and earlier it was open to every user for `CREATE` and `USAGE` — anyone who could connect to the database could create tables in public, which easily scatters objects and causes naming collisions under multi-tenancy or multi-person collaboration.

**From PG 15 on**, a freshly initialized `public` schema only allows writes by the owner (the `pg_database_owner` pseudo-role, which points at the current database's owner); ordinary users get only `USAGE`. To create tables in public you need an explicit grant:

```sql
-- in PG15+ an ordinary user cannot create tables in public by default
GRANT USAGE  ON SCHEMA public TO app;
GRANT CREATE ON SCHEMA public TO app;   -- only when needed
```

Watch out when upgrading old databases to PG 15+: existing grants on public in an already-initialized database are not changed automatically; only newly initialized databases get the tightened default.

## search_path: where unprefixed names get looked up

When you write `SELECT * FROM users` without a schema, PG walks through the schemas listed in `search_path` one by one. To inspect and modify it (for the full rules see the official [schema search path in Statement Behavior](https://www.postgresql.org/docs/current/runtime-config-client.html#GUC-SEARCH-PATH)):

```sql
SHOW search_path;
--   search_path
-- ----------------
--  "$user", public

SET search_path TO sales, public;          -- current session only, resets on disconnect
SET LOCAL search_path TO sales;            -- current transaction only
ALTER ROLE app SET search_path TO sales;   -- persistent for a role
ALTER DATABASE shop SET search_path TO sales, public;  -- persistent for a database
```

The resolution rules have four key points:

1. **Ordered matching, first match wins**: the first schema in `search_path` that can hold the object is the "default schema", and `CREATE TABLE users` is created here; when looking up an object with the same name, the first hit in this order is taken.
2. **`"$user"` is a placeholder**: it expands to a schema with the same name as the current role (only effective if it exists), otherwise it is skipped.
3. **The system schema `pg_catalog` is always implicitly first**: even if you never write it, built-in functions, built-in types, and system tables are found first (which is also why you should not create your own objects inside `pg_catalog`).
4. **The temporary-table schema `pg_temp` is a special member**: when not listed explicitly in `search_path`, it is still searched first for table names and type names; but for function and operator names it is only searched when explicitly listed.

## Cross-schema references

Without a prefix, PG looks things up via `search_path`; with a prefix you specify exactly and are unaffected by `search_path`:

```sql
-- cross-schema JOIN, the prefixed form is safest
SELECT o.id, o.amount, r.name AS region_name
FROM sales.orders o
JOIN ref.regions r ON r.code = o.region;

-- same for views, functions, sequences
SELECT sales.next_order_id();
CREATE VIEW report.monthly AS
SELECT date_trunc('month', created_at) AS m, sum(amount) AS total
FROM sales.orders GROUP BY 1;
```

Production code (ORMs, stored procedures) should always write the full `schema.table` name rather than relying on `search_path`: first, to avoid "works locally, errors in production" caused by inconsistent `search_path` configuration across environments; second, to shut down low-level but real attack surfaces like `search_path` injection (see [Hardening checklist](../security/hardening-checklist)).

## Gotchas and common pitfalls

- **`\dt` not showing tables** is usually a `search_path` problem: try `\dt sales.*` or `SET search_path TO sales` first and then look.
- **Same-named objects in different schemas are two different objects**: `public.users` and `sales.users` can exist side by side, and editing the wrong one does not raise an error but the data does not line up.
- **`DROP SCHEMA` refuses to drop a non-empty schema by default**; add `CASCADE` to also drop the objects inside — in production, probing with `DROP SCHEMA ... RESTRICT` first is the safer habit.
- **Databases cannot be queried directly across each other**: when the wrong database reports `relation "xxx" does not exist`, run `\l` first to confirm you are connected to the database you expect.
- **A schema is not a "user"**: in PG, schema and role are two distinct concepts; it is only the default `"$user"` placeholder that makes the two names often match.

## References

- [PostgreSQL official documentation · 5.10. Schemas](https://www.postgresql.org/docs/current/ddl-schemas.html)
- [PostgreSQL official documentation · Part I. Tutorial](https://www.postgresql.org/docs/current/tutorial.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Common psql operations](./psql-getting-started)
- [Data types overview](./data-types-overview)
- [Multi-tenant modeling](../database-design/multi-tenant-modeling)
- [Roles and privileges](../security/roles-and-permissions)
- [data-types-overview](data-types-overview.md)
- [index](index.md)
- [naming-and-style-conventions](naming-and-style-conventions.md)
- [psql-getting-started](psql-getting-started.md)
- [system-catalogs-and-metadata](system-catalogs-and-metadata.md)
- [what-is-postgresql](what-is-postgresql.md)
- [object-grant-hierarchy](/security/object-grant-hierarchy.md)
