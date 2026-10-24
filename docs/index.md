---
layout: home

hero:
  name: Hello PostgreSQL
  text: PostgreSQL Field Notes
  tagline: The tradeoffs, pitfalls, troubleshooting sessions and internals observations from real PostgreSQL projects. Everything here comes from hands-on work; details may shift with version and setup.
  image:
    src: /logo.svg
    alt: hello-postgresql logo
  actions:
    - theme: brand
      text: Browse the Notes
      link: /basics/
    - theme: alt
      text: GitHub
      link: https://github.com/cuihairu/hello-postgresql

features:
  - title: Basics and Design
    details: Concepts and installation, psql and data types, CRUD and JOIN, normalization, primary keys and constraints, partitioning and multi-tenant design.
  - title: SQL and Internals
    details: CTEs and window functions, JSONB and arrays, full-text search, MVCC, VACUUM and WAL, the lock system and the query execution pipeline.
  - title: Indexing and Performance
    details: Choosing between B-tree, GIN, GiST and BRIN, EXPLAIN and pg_stat_statements, slow-query governance, parameter tuning and benchmarking.
  - title: Operations, Security, Ecosystem
    details: Streaming replication and high availability, backups and PITR, roles and RLS, plus pgvector, TimescaleDB and PostGIS in practice.
---
