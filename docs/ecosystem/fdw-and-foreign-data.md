# FDW and Foreign Data

An FDW (Foreign Data Wrapper) lets PostgreSQL "mount" a remote data source as a local table: the foreign table shows up in `\d`, can be queried with SELECT/JOIN, and under some conditions supports INSERT/UPDATE. It is the standard way to do cross-database integration and heterogeneous joins — typical uses are treating another PG database, a MySQL database, or CSV/Parquet files as tables. For a rundown of built-in and third-party wrappers, see the [PostgreSQL official wiki](https://wiki.postgresql.org/wiki/Foreign_data_wrappers).

## postgres_fdw End to End

Taking a connection to another PostgreSQL server as the example, it is four steps: install the extension → create a SERVER (remote address) → create a USER MAPPING (mapping a local role to a remote account) → create the foreign table.

```sql
CREATE EXTENSION postgres_fdw;

CREATE SERVER erp_pg
    FOREIGN DATA WRAPPER postgres_fdw
    OPTIONS (host '10.0.0.5', port '5432', dbname 'erp');

-- Let the current user connect with a remote read-only account; PUBLIC means every local user
CREATE USER MAPPING FOR CURRENT_USER
    SERVER erp_pg
    OPTIONS (user 'erp_reader', password '***');

-- Create a foreign table per table
CREATE FOREIGN TABLE erp_customers (
    id   bigint,
    name text,
    city text
)
SERVER erp_pg
OPTIONS (schema_name 'public', table_name 'customers');

-- Or import foreign table definitions in bulk for a remote schema
IMPORT FOREIGN SCHEMA public
    LIMIT TO (orders, order_items)
    FROM SERVER erp_pg
    INTO public;
```

After that you can query it directly:

```sql
SELECT city, count(*) FROM erp_customers GROUP BY city ORDER BY 2 DESC LIMIT 10;
```

## Pushdown and Performance Parameters

The core value of postgres_fdw is "push down whenever you can": the remote database has its own indexes and optimizer, so send the whole statement over rather than pulling the data back and computing locally. Two things to understand is enough for everyday tuning:

**1. Pushdown rules.** `WHERE` conditions and `ORDER BY`/`LIMIT` are usually pushed down; aggregate functions can also be pushed down when the types are safe (PG 10+); a JOIN between two foreign tables on the same remote server can be pushed down as a whole when the account mappings match. Look at the plan with `EXPLAIN VERBOSE`: if you see `Foreign Scan` and the filter is not on a local node, the pushdown succeeded.

**2. Two key parameters.**

```sql
-- Let the local planner run EXPLAIN on the remote to get real costs (default false, guesses from estimated rows)
ALTER SERVER erp_pg OPTIONS (ADD use_remote_estimate 'true');

-- Batch row count per remote -> local fetch; default 100, raise it for large full scans
ALTER FOREIGN TABLE erp_customers OPTIONS (ADD fetch_size '5000');
```

`use_remote_estimate` lets the remote take part in planning (at the cost of a few extra round trips per plan), which suits complex queries that "join a local table against a large remote table"; `fetch_size` gives a clear boost for report queries that pull everything, and the gap between fetching 5000 rows at a time and 100 rows at a time can be tens of times.

Foreign tables also need statistics: a local `ANALYZE erp_customers` samples through the remote and feeds into row count estimation just like a local table. See [Statistics and ANALYZE](../performance/statistics-and-analyze) for the method.

```sql
ANALYZE erp_customers;
```

## A Rundown of Common Wrappers

| Wrapper | Data source | Notes |
| --- | --- | --- |
| postgres_fdw | other PG databases | built-in contrib, the most mature, the fullest feature set |
| file_fdw | local CSV/text files | built-in contrib, good for ad-hoc data loads and log analysis |
| mysql_fdw | MySQL/MariaDB | maintained by EDB, write support is limited |
| parquet_s3_fdw | S3/local Parquet | light analytics via columnar storage, no loading required |
| duckdb_fdw | DuckDB/SQLite, etc. | reuses DuckDB's analytical operators |
| mongo_fdw | MongoDB | maps documents to rows and columns, good for cross-database reconciliation |

For installation methods, see [Extension Management](./extension-management): `file_fdw`/`postgres_fdw` ship with the distribution package, the rest are installed via platform packages or PGXN.

## Three Patterns for Cross-Database Integration

- **Ad-hoc / low-frequency joined queries**: query the foreign table directly. Good for BI pulls, reconciliation, and cross-system checks — the upside is zero data movement, the downside is that latency depends on the remote.
- **A light ETL alternative**: `INSERT INTO local_tbl SELECT ... FROM foreign_tbl` for batch pulls, which is one fewer intermediate format than writing scripts. Combined with a larger `fetch_size` and windowed incremental pulls, many nightly jobs do not need a dedicated ETL tool.
- **Do not use FDW for continuous sync**: when you need to replicate data long-term with low latency, logical replication (publish/subscribe) is far more reliable than FDW polling. Compare with [Logical Replication Operations](../operations/logical-replication-ops). FDW is positioned as "fetch at query time", not "push on change".

## Performance Limits and Security

On performance, recognize that FDW is not a transparent accelerator:

- each query opens a remote connection as needed (reused within a session per account mapping), so high-concurrency short queries amplify the connection overhead;
- the result set must be materialized locally, so pulling million-row data makes network and memory hard bottlenecks — for those needs, prefer remote aggregation or materializing to disk;
- load on the remote database is directly amplified by local queries, so a read-only account plus resource isolation on the remote is a baseline requirement.

On security, credential handling is the focus:

- USER MAPPING passwords live in the system catalogs and are visible to superusers; use a **least-privilege dedicated remote account** and avoid mapping to a high-privilege user;
- never create a mapping with a password for PUBLIC — any local user can borrow those credentials;
- enable SSL across network links (`OPTIONS (sslmode 'require')`) so credentials and data are not sent in clear text;
- permission control on foreign tables follows the [Object Grant Hierarchy](../security/object-grant-hierarchy), so GRANT/REVOKE can be precise to the table.

One easy-to-miss point: writes on a foreign table join the local transaction, and across multiple remotes postgres_fdw coordinates commits with remote prepared transactions. If the remote has prepared transactions disabled, cross-database write consistency suffers, so confirm the `max_prepared_transactions` setting before writing to a remote in production.

## References

- [wiki.postgresql.org/wiki/Foreign_data_wrappers](https://wiki.postgresql.org/wiki/Foreign_data_wrappers)
- [GitHub · pgvector/pgvector](https://github.com/pgvector/pgvector)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Extension Management](./extension-management)
- [Logical Replication Operations](../operations/logical-replication-ops)
- [Roles and the Permission Model](../security/roles-and-permissions)
- [Statistics and ANALYZE](../performance/statistics-and-analyze)
- [materialized-views](/database-design/materialized-views.md)
- [citus](citus.md)
- [comparison-with-mysql](comparison-with-mysql.md)
- [index](index.md)
- [knowledge](/knowledge.md)