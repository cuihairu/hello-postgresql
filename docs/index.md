---
layout: home

hero:
  name: Hello PostgreSQL
  text: PostgreSQL 开发记录
  tagline: 记录项目里用 PostgreSQL 的取舍、踩坑、排障和原理观察。内容来自实际开发经验，细节可能随版本和场景变化。
  image:
    src: /logo.svg
    alt: hello-postgresql logo
  actions:
    - theme: brand
      text: 浏览记录
      link: /basics/
    - theme: alt
      text: GitHub
      link: https://github.com/cuihairu/hello-postgresql

features:
  - title: 基础用法与设计
    details: PostgreSQL 概念与安装上手、psql 与数据类型、CRUD 与 JOIN、范式建模、主键与约束、分区与多租户设计。
  - title: SQL 与内核观察
    details: CTE 与窗口函数、JSONB 与数组、全文检索、MVCC 多版本、VACUUM 与 WAL、锁系统与查询执行管道。
  - title: 索引与性能实践
    details: B-tree/GIN/GiST/BRIN 选型、EXPLAIN 与 pg_stat_statements、慢查询治理、参数调优与基准测试。
  - title: 运维、安全与生态
    details: 流复制与高可用、备份恢复与 PITR、角色权限与 RLS、pgvector/TimescaleDB/PostGIS 扩展与工具实战。
---
