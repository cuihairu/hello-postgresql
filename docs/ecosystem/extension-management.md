# Extension Management

An extension is PostgreSQL's loading mechanism for its ecosystem: a packaged set of SQL objects (types, functions, operators, index methods) plus C code, installed as a whole with one `CREATE EXTENSION`. pgvector, PostGIS, TimescaleDB, and pg_stat_statements are all delivered as extensions, and when operating a PG environment, extension installation, upgrades, and version management are basic items I keep re-checking.

## Basic Operations

```sql
-- Install (prerequisite: the extension binary is already on the server, see below)
CREATE EXTENSION pg_trgm;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Install into a specific schema (requires the extension to be relocatable), easier to manage centrally
CREATE SCHEMA IF NOT EXISTS ext;
CREATE EXTENSION pg_trgm WITH SCHEMA ext;

-- View installed and available versions
SELECT extname, extversion FROM pg_extension;

-- Upgrade to the latest available version / a specific version
ALTER EXTENSION pg_trgm UPDATE;
ALTER EXTENSION pg_trgm UPDATE TO '1.6';

-- Uninstall; CASCADE also drops the objects the extension provided, use with care
DROP EXTENSION pg_trgm;
```

Note that `CREATE EXTENSION` is a database-level operation: an extension installed in `template1` automatically appears in every database created afterward; for databases that already exist, run it per database. If installation reports `could not open extension control file`, the server binary package is not installed — `CREATE EXTENSION` only registers metadata, it does not download code.

## Viewing Available Extensions

```sql
SELECT name, default_version, installed_version, trusted
FROM pg_available_extensions
WHERE name IN ('pg_trgm', 'vector', 'postgis', 'pg_stat_statements');

SELECT version FROM pg_available_extension_versions WHERE name = 'postgis';
```

Both views come from the system catalogs (see [System Catalogs and Metadata](../basics/system-catalogs-and-metadata)); "binary installed but not enabled" and "absent from the server entirely" are distinguishable at a glance.

## Control Files and Trusted Extensions

Each extension has a control file on the server, such as `/usr/share/postgresql/16/extension/pg_trgm.control`:

```plaintext
comment = 'text similarity measurement and index searching based on trigrams'
default_version = '1.6'
relocatable = true
trusted = true
```

- `default_version`: the version installed when `CREATE EXTENSION` omits `VERSION`.
- `relocatable`: when true, `WITH SCHEMA` can place it in any schema.
- `trusted`: **introduced in PG 13**. Extensions marked trusted (pg_trgm, citext, btree_gin, pgcrypto, and others) may be installed by the database owner or an ordinary user with CREATE privileges, with no superuser required. This is especially useful in managed environments where you only get database-level privileges; untrusted extensions (PostGIS, TimescaleDB, the kind that ship a C library) still need a superuser to install. See [Roles and the Permission Model](../security/roles-and-permissions) for the permission model.

## Where to Install From: Distribution Packages, PGXN, Source

```bash
# 1) Distribution / PGDG packages: most recommended, names track the PG version
sudo apt install postgresql-16-postgis-3     # PostGIS
sudo apt install postgresql-16-pgvector      # pgvector

# 2) PGXN: the community extension repository, needs the pgxn client
pip install pgxnclient
pgxn install pgvector

# 3) Build from source: needs the PG development headers
sudo apt install postgresql-server-dev-16
git clone https://github.com/pgvector/pgvector && cd pgvector
make && sudo make install    # installs into pg_config --pkglibdir and --sharedir
```

Once the binary is in place, go back to psql and run `CREATE EXTENSION`. The principle: in production, prefer distribution packages (they upgrade in lockstep with PG itself and have clear dependencies); use PGXN or source builds when no ready-made package exists or you need a newer version.

## Extensions and Version Upgrades

Extensions are the main friction point during a major PG version upgrade, and the order of steps matters:

1. **Before the upgrade**: install the binary packages for **every** extension into the new version's install tree (`pg_upgrade` and logical export both only move metadata, and will not compile C libraries for you);
2. **Upgrade**: `pg_upgrade` moves the `pg_extension` catalog along, and objects such as foreign tables and indexes migrate with the database;
3. **After the upgrade**: check and update each extension's own SQL definitions one by one (PostGIS, pgvector, and similar usually ship a matching minor version for each new PG):

```sql
SELECT extname, extversion FROM pg_extension;

ALTER EXTENSION postgis UPDATE;
ALTER EXTENSION pg_trgm  UPDATE;
```

Extensions like PostGIS also run their bundled `postgis_upgrade` script, and it is worth verifying the upgrade path in a rehearsal environment first. For the full upgrade flow, see [Version Upgrades](../operations/version-upgrade).

## Common Extensions Checklist

| Extension | Use | Notes |
| --- | --- | --- |
| pg_stat_statements | SQL time-to-execute statistics, the starting point for slow query governance | needs `shared_preload_libraries` |
| pg_trgm | Trigram fuzzy matching, LIKE acceleration and similarity search | trusted, commonly used with GIN indexes |
| pgvector | Vector types and ANN search | see [pgvector: Vector Search](./pgvector) |
| PostGIS | Spatial types and spatial functions | needs a superuser, many companion packages |
| pgcrypto | Encryption / hashing functions (AES, pgp) | trusted |
| pgaudit | Session / object-level audit logs | needs `shared_preload_libraries` |
| pg_partman | Automated management of declarative partitioning | often paired with native partitioned tables |
| pg_repack | Online compaction of table / index bloat | used with the companion client command |
| postgres_fdw / file_fdw | Access remote PG / local files | built-in contrib |
| unaccent | Text normalization that strips diacritics | commonly used with full-text search |
| btree_gin | Lets GIN indexes support combinations of ordinary scalar columns | mixed multi-column filtering indexes |

For practice notes on the extensions in this checklist, there is more elsewhere: monitoring in [pg_stat_statements](../performance/pg-stat-statements) and [Auditing](../security/audit), text matching in [Full-Text Search](../advanced-sql/full-text-search).

## References

- [GitHub · pgvector/pgvector](https://github.com/pgvector/pgvector)
- [wiki.postgresql.org/wiki/Foreign_data_wrappers](https://wiki.postgresql.org/wiki/Foreign_data_wrappers)

<!-- BACKLINKS-AUTO -->
## Related Pages

- Subtree overview: [Ecosystem and New Features](/ecosystem/)

- [System Catalogs and Metadata](../basics/system-catalogs-and-metadata)
- [Version Upgrades](../operations/version-upgrade)
- [pgvector: Vector Search](./pgvector)
- [Roles and the Permission Model](../security/roles-and-permissions)
- [fdw-and-foreign-data](fdw-and-foreign-data.md)
- [index](index.md)
- [pgvector](pgvector.md)
- [postgis](postgis.md)
- [timescaledb](timescaledb.md)
- [knowledge](/knowledge.md)