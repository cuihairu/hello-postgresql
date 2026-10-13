# FDW 与外部数据

FDW（Foreign Data Wrapper，外部数据封装器）让 PostgreSQL 把远端数据源「挂」成本地表：外表在 `\d` 里可见、可以用 SELECT/JOIN 查询，部分条件下还能 INSERT/UPDATE。它是跨库集成、异构数据联合查询的标准手段，常见用途是把另一个 PG 库、MySQL 库、CSV/Parquet 文件当作表来查。内置与第三方 wrapper 一览见 [PostgreSQL 官方 wiki](https://wiki.postgresql.org/wiki/Foreign_data_wrappers)。

## postgres_fdw 全流程

以连接另一台 PostgreSQL 为例，四步：装扩展 → 建 SERVER（远端地址）→ 建 USER MAPPING（本地角色到远端账号的映射）→ 建外表。

```sql
CREATE EXTENSION postgres_fdw;

CREATE SERVER erp_pg
    FOREIGN DATA WRAPPER postgres_fdw
    OPTIONS (host '10.0.0.5', port '5432', dbname 'erp');

-- 让当前用户以远端只读账号连接；PUBLIC 表示所有本地用户
CREATE USER MAPPING FOR CURRENT_USER
    SERVER erp_pg
    OPTIONS (user 'erp_reader', password '***');

-- 逐表建外表
CREATE FOREIGN TABLE erp_customers (
    id   bigint,
    name text,
    city text
)
SERVER erp_pg
OPTIONS (schema_name 'public', table_name 'customers');

-- 或按远端 schema 批量导入外表定义
IMPORT FOREIGN SCHEMA public
    LIMIT TO (orders, order_items)
    FROM SERVER erp_pg
    INTO public;
```

之后即可直接查询：

```sql
SELECT city, count(*) FROM erp_customers GROUP BY city ORDER BY 2 DESC LIMIT 10;
```

## 查询下推与性能参数

postgres_fdw 的核心价值在于「能下推就下推」：远端库有自己的索引和优化器，能整句发过去就不要把数据拉回来算。理解两件事就够日常调优：

**1. 下推规则。** `WHERE` 条件、`ORDER BY`/`LIMIT` 通常会下推；聚合函数在类型安全时也能下推（PG 10+）；同一远端上的两个外表做 JOIN 且账号映射一致时，JOIN 可整体下推。用 `EXPLAIN VERBOSE` 看计划：出现 `Foreign Scan` 且过滤条件不在本地节点上，就说明下推成功。

**2. 两个关键参数。**

```sql
-- 让本地规划器去远端跑 EXPLAIN 取真实代价（默认 false，按估算行数猜）
ALTER SERVER erp_pg OPTIONS (ADD use_remote_estimate 'true');

-- 每次 远端→本地 的批量行数，默认 100；大批量扫描调大
ALTER FOREIGN TABLE erp_customers OPTIONS (ADD fetch_size '5000');
```

`use_remote_estimate` 会让远端参与规划（代价是每次规划多几次往返），适合「本地 JOIN 远端大表」的复杂查询；`fetch_size` 对全量拉取的报表查询提升明显，一次取 5000 行和一次取 100 行可能是几十倍的差距。

外表也需要统计信息，本地 `ANALYZE erp_customers` 会通过远端采样，和本地表一样参与行数估算，方法见 [统计信息与 ANALYZE](../performance/statistics-and-analyze)。

```sql
ANALYZE erp_customers;
```

## 常见 wrapper 一览

| Wrapper | 数据源 | 说明 |
| --- | --- | --- |
| postgres_fdw | 其他 PG 库 | 内置 contrib，最成熟，功能最全 |
| file_fdw | 本地 CSV/文本文件 | 内置 contrib，适合临时导数与日志分析 |
| mysql_fdw | MySQL/MariaDB | EDB 维护，写操作支持有限 |
| parquet_s3_fdw | S3/本地 Parquet | 借列式存储做轻量分析，免入库 |
| duckdb_fdw | DuckDB/SQLite 等 | 复用 DuckDB 的分析算子 |
| mongo_fdw | MongoDB | 文档映射为行列，做跨库对账 |

安装方式见 [扩展管理](./extension-management)：`file_fdw`/`postgres_fdw` 随发行版包自带，其余按平台包或 PGXN 安装。

## 跨库集成的三种模式

- **临时/低频联合查询**：直接查外表。适合 BI 取数、对账、跨系统巡检，优点是零数据搬运，缺点是延迟取决于远端。
- **ETL 的轻量替代**：`INSERT INTO local_tbl SELECT ... FROM foreign_tbl` 批量拉数，比自写脚本少一套中间格式；配合 `fetch_size` 调大和窗口条件增量拉取，很多夜间任务不需要专门的 ETL 工具。
- **持续同步不用 FDW**：需要长期、低延迟地复制数据时，逻辑复制（订阅/发布）比 FDW 轮询可靠得多，对比见 [逻辑复制运维](../operations/logical-replication-ops)。FDW 的定位是「查询时取」，不是「变更时推」。

## 性能边界与安全

性能上要认清 FDW 不是透明加速器：

- 每次查询按需建立远端连接（同一会话内按账号映射复用），高并发短查询会放大连接开销；
- 结果集必须在本地物化，拉百万行级数据时网络与内存是硬瓶颈，这类需求优先考虑远端聚合或物化落盘；
- 远端库的负载会被本地查询直接放大，只读账号 + 远端资源隔离是基本要求。

安全上，凭证管理是重点：

- USER MAPPING 的密码存在系统目录里，超级用户可见；应使用**权限最小的专用远端账号**，避免映射到高权限用户；
- 不要为 PUBLIC 建带密码的映射——任何本地用户都能借用该凭证；
- 跨网络链路启用 SSL（`OPTIONS (sslmode 'require')`），防止凭证与数据明文传输；
- 外表上的权限控制遵循 [对象授权层级](../security/object-grant-hierarchy)，可对 GRANT/REVOKE 精确到表。

另一个容易忽略的点：外表上的写操作会加入本地事务，跨多个远端时 postgres_fdw 用远端预备事务协调提交；远端若禁用了 prepared transactions，跨库写的一致性会打折扣，生产上写远端前先确认 `max_prepared_transactions` 配置。

## 参考资料

- [wiki.postgresql.org/wiki/Foreign_data_wrappers](https://wiki.postgresql.org/wiki/Foreign_data_wrappers)
- [GitHub · pgvector/pgvector](https://github.com/pgvector/pgvector)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [扩展管理](./extension-management)
- [逻辑复制运维](../operations/logical-replication-ops)
- [角色与权限](../security/roles-and-permissions)
- [统计信息与 ANALYZE](../performance/statistics-and-analyze)
- [materialized-views](/database-design/materialized-views.md)
- [citus](citus.md)
- [comparison-with-mysql](comparison-with-mysql.md)
- [index](index.md)
- [knowledge](/knowledge.md)