# What Is PostgreSQL

PostgreSQL (often abbreviated PG or pg, said aloud as "post-gres-Q-L") is an open-source object-relational database management system. It descends from the POSTGRES project at the University of California, Berkeley, was released under the name PostgreSQL starting in July 1996, and has been maintained for three decades by a community of developers worldwide, with main release lines numbered like PostgreSQL 16 and 17. It is not any company's product, and no single vendor steers its direction.

## History

- **1986–1994: Berkeley POSTGRES**. After the Ingres project, Michael Stonebraker led POSTGRES research, aiming to support complex data types, user-defined types, a rule system, and inheritance for relations. The system at that stage used a query language called QUEL.
- **1995: Postgres95**. Berkeley students Andrew Yu and Jolly Chen replaced QUEL with an SQL interface; the project was renamed Postgres95 and released under a BSD-style license. Around the same time Stonebraker founded the commercial company Illustra on the POSTGRES code base (later acquired by Informix).
- **1996 to the present: PostgreSQL**. An open-source team led by Marc G. Fournier, Thomas Lockhart and Vadim Mikheev took over the code, the project was formally named PostgreSQL, and it adopted the PostgreSQL License. Since then the community has moved on a rhythm of one major version per year plus irregular minor releases.

The official account of this history is [A Brief History of PostgreSQL](https://www.postgresql.org/docs/current/history.html).

## The License: PostgreSQL License

PostgreSQL uses the PostgreSQL License, a permissive BSD-style license:

- it may be used for free in commercial closed-source products, and modified builds may be redistributed as closed source;
- it may be redistributed under a different name, with no obligation to retain the trademark (though the project officially discourages misusing the PostgreSQL brand);
- the only obligation is to preserve the original copyright notice.

The full text is at the official page [The PostgreSQL License](https://www.postgresql.org/about/licence/). This means that embedding PostgreSQL in commercial software — including a cloud provider's managed service — is essentially unconstrained by the license. GPL-style databases (such as MySQL's enterprise dual license) add extra constraints on commercial distribution.

## Standards Compliance, ACID, and MVCC

**High standards SQL conformance.** PostgreSQL has treated "stay close to the SQL standard" as a design goal for a long time: window functions, CTEs, recursive queries, outer joins, the `FILTER` clause, `NULLS FIRST`/`LAST` ordering and other standard features are all implemented with standard syntax (a few standard functions carry PostgreSQL's own names, for example `string_agg` where the standard says `LISTAGG`). SQL learned in PostgreSQL transfers to other databases at relatively low cost.

**Full ACID support.** A transaction either happens entirely or not at all (atomicity), committed results survive a crash (durability), and constraints hold inside the transaction (consistency). Isolation levels are selectable from `READ UNCOMMITTED` through `SERIALIZABLE` (see the next point).

**MVCC: readers and writers do not block each other.** PostgreSQL uses multi-version concurrency control: each row can have several historical versions, reads consult a snapshot and writes create a new version, so reads never block writes and writes never block reads. The default isolation level is `READ COMMITTED`; REPEATABLE READ and SERIALIZABLE are implemented with real snapshots and SSI, rather than MySQL InnoDB's repeatable-read gap-lock semantics. See the official [Concurrency Control](https://www.postgresql.org/docs/current/mvcc.html) chapter and [MVCC and Multi-Versioning](../internals/mvcc-and-multi-version) on this site.

## Object-Relational Features

PostgreSQL allows "object" extensions on top of the relational model:

- **custom types and functions**: define new types, new operators and new index access methods in SQL, C or PL/pgSQL;
- **table inheritance**: child tables inherit their parent's columns, and queries on the parent cover children by default (in modern practice this is mostly superseded by declarative partitioning);
- **functions as first-class citizens**: higher-order functions, window functions, aggregates (including custom aggregates), and `LATERAL`;
- **rich built-in types**: JSONB, arrays, ranges, hstore, network addresses (`inet`/`cidr`), full-text search vectors, geospatial geometries (with PostGIS), and more.

These features let PostgreSQL serve traditional OLTP work as well as geospatial (PostGIS), time series (TimescaleDB), vector (pgvector) and document (JSONB) workloads.

## Feel the Features With a Query

After installing it (next page), run this self-contained script in psql to see several PostgreSQL features at a glance: array subscripts, JSONB access, the range type and `RETURNING`:

```sql
CREATE TABLE products (
    id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name     text        NOT NULL,
    tags     text[]      NOT NULL DEFAULT '{}',      -- array type
    attrs    jsonb       NOT NULL DEFAULT '{}',      -- document storage
    price    numeric(10,2) NOT NULL,
    valid_during tstzrange NOT NULL                   -- time range
);

INSERT INTO products (name, tags, attrs, price, valid_during) VALUES
    ('Mechanical Keyboard', ARRAY['peripherals','office'], '{"switch":"red","backlit":true}', 399.00,
     tstzrange('2026-01-01', '2026-12-31'))
RETURNING id, name, tags[1], attrs->>'switch', valid_during;

-- range containment: is this product on sale right now?
SELECT name FROM products
WHERE valid_during @> now();

DROP TABLE products;
```

This script runs on PostgreSQL 13 and later with no extensions (`tstzrange` is a built-in type). For complete coverage of arrays, JSONB and ranges see [A Tour of Special Types](./special-types-intro).

## Niche and Selection

- **OLTP business database**: e-commerce, payments and account systems — strongly transactional, strongly consistent work is its home turf;
- **analytics / OLAP**: parallel queries, columnar extensions (such as `cstore_fdw`), `dw`-style extensions and foreign data wrappers can carry analytical loads, but dedicated OLAP engines (ClickHouse and the like) still have the edge on very large scans;
- **geospatial**: PostGIS is the de facto standard for spatial databases;
- **time series**: TimescaleDB adds time-series compression and continuous aggregates on PostgreSQL;
- **vector search**: pgvector gives embedding similarity search, a common choice for AI applications;
- **general-purpose backend**: many applications treat PostgreSQL as "one database to solve everything" and avoid pulling in several heterogeneous stores.

## Rough Differences from MySQL

| Dimension | PostgreSQL | MySQL (InnoDB) |
| --- | --- | --- |
| SQL standards conformance | Closer to the standard; strong on complex queries | Features catching up; more dialect-specific behaviour |
| Complex queries / analytics | A strength (CTEs, window functions, parallelism, many index types) | Weaker; complex computation is usually pushed to the application layer |
| Data integrity | Full: constraints, foreign keys, deferrable constraints, domain types | Foreign keys are supported in InnoDB but the constraint story is thinner |
| Extensibility | Mature extension mechanism; deeply customisable | Plugin mechanism is comparatively closed |
| Deployment and operations | Single-database centric, large ecosystem of tools | Master/replica setups; common in smaller projects, especially in China |
| Concurrency model | MVCC; readers and writers do not block each other | MVCC, with gap locks playing a larger role |

In one sentence: when business logic is complex, you need strong consistency and complex queries, and you want one database to cover several shapes of data, PostgreSQL is usually the more comfortable starting point; for structurally simple web applications, or teams already deeply invested in the MySQL toolchain, MySQL is still common. There is no absolute answer to a selection question — see [PostgreSQL vs MySQL](../ecosystem/comparison-with-mysql).

## Summary

- Academic roots (Berkeley POSTGRES); named PostgreSQL from 1996; community-driven.
- PostgreSQL License is BSD-like; commercial distribution is permissive.
- Standards SQL conformance plus full ACID and MVCC; readers and writers do not block each other.
- Object-relational features extend it from OLTP into geospatial, time series, vector and other ecosystems.

## References

- [PostgreSQL Documentation · Chapter 13. Concurrency Control](https://www.postgresql.org/docs/current/mvcc.html)
- [PostgreSQL Documentation · Part I. Tutorial](https://www.postgresql.org/docs/current/tutorial.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Installation and First Connection](/basics/install-and-quickstart)
- [Everyday psql](/basics/psql-getting-started)
- [Databases and Schema Objects](./database-and-schema-objects)
- [MVCC and Multi-Versioning](../internals/mvcc-and-multi-version)
- [Glossary](/appendix/glossary.md)
- [Basics & Core SQL](/basics/index)
- [Installation and First Connection](/basics/install-and-quickstart)
- [Choosing PostgreSQL](/ecosystem/when-to-choose-postgresql.md)
