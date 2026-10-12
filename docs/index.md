---
layout: home

hero:
  name: Hello PostgreSQL
  text: PostgreSQL 知识手册
  tagline: 从 SQL 基础、数据库设计与高级查询，到 MVCC 与 WAL 内核机制、索引体系、查询调优、架构部署、安全与生态扩展，系统掌握 PostgreSQL。
  image:
    src: /logo.svg
    alt: hello-postgresql logo
  actions:
    - theme: brand
      text: 开始阅读
      link: /basics/README
    - theme: alt
      text: GitHub
      link: https://github.com/cuihairu/hello-postgresql

features:
  - title: 基础与设计
    details: PostgreSQL 概念与安装上手、psql 与数据类型、CRUD 与 JOIN、范式建模、主键与约束、分区与多租户设计。
  - title: 高级 SQL 与内核机制
    details: CTE 与窗口函数、JSONB 与数组、全文检索、MVCC 多版本、VACUUM 与 WAL、锁系统与查询执行管道。
  - title: 索引与性能调优
    details: B-tree/GIN/GiST/BRIN 选型、EXPLAIN 与 pg_stat_statements、慢查询治理、参数调优与基准测试。
  - title: 架构·安全·生态
    details: 流复制与高可用、备份恢复与 PITR、角色权限与 RLS、pgvector/TimescaleDB/PostGIS 扩展与工具实战。
---
