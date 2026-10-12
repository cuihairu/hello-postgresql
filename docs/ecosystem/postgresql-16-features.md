# PostgreSQL 16 新特性摘要

PostgreSQL 16 于 2023 年 9 月 14 日发布。这是一个偏「夯实基础」的版本：新增语法不多，重点放在逻辑复制的可用性、I/O 观测能力（pg_stat_io）以及执行器和 vacuum 的细节优化上。本页按类别整理对日常开发和运维影响较大的条目，完整列表见 [官方 release notes](https://www.postgresql.org/docs/release/16.0/)。

## SQL 与查询

- **预排序聚合**：带 `ORDER BY` 或 `DISTINCT` 的聚合（如 `string_agg(x ORDER BY y)`、`count(DISTINCT id)`）现在可以直接利用输入已有的排序，省掉一次内部排序。优化器开关是 `enable_presorted_aggregate`，怀疑计划变差时可关掉对比。
- **`string_agg()` / `array_agg()` 支持并行**：此前这两个常用聚合无法进并行计划，大表聚合现在能吃满多个 worker。
- **SQL/JSON 构造函数**：标准 SQL 的 `JSON_ARRAY()`、`JSON_OBJECT()`、`JSON_ARRAYAGG()`、`JSON_OBJECTAGG()` 以及 `IS JSON` 校验语法落地，构造 JSON 不再需要手拼字符串。
- **`ANY_VALUE()` 聚合**：在 GROUP BY 后取「组内任意一行的值」，不再需要 `array_agg(...)[1]` 或 `max()` 这类绕法。要求 SQL 层面保证「任意值语义」确实可接受。
- **`EXPLAIN (GENERIC_PLAN)`**：不执行语句就能看通用参数化计划的形态，排查应用端绑定变量慢查询时很实用，详见 [计划缓存与通用计划](../internals/plan-cache-and-generic-plan)。
- **其他**：`COPY FROM` 支持 `DEFAULT` 列；`FROM` 子查询可以不写别名；`0x`/`0o`/`0b` 进制字面量与数字下划线分隔（`1_000_000`）；带时区的 `date_add()` / `date_subtract()`。

```sql
-- ANY_VALUE：组内取任意一个订单状态
SELECT user_id, count(*) AS cnt, any_value(status) AS one_status
FROM orders
GROUP BY user_id;

-- 预排序聚合：如果 (user_id, created_at) 上有索引，排序可被利用
SELECT user_id, string_agg(order_no, ',' ORDER BY created_at) AS timeline
FROM orders
GROUP BY user_id;
```

## 执行器与性能

- **`FULL` 和右外连接的并行 hash join**：之前这两类 join 无法并行，宽表分析查询的并行覆盖面更完整。
- **更多场景使用增量排序**：包括 `DISTINCT` 在内的多种计划形态可以借助增量排序（incremental sort）避免整体排序。
- **HOT 更新条件放宽**：只更新了 BRIN 索引列的行现在也能走 HOT 更新，时序类大表（常用 BRIN）更新成本下降。
- **Memoize 用于 `UNION ALL`**：重复的参数化子计划结果可被缓存。
- **vacuum 冻结提速**：普通 vacuum 过程中会顺手冻结合适的页面，减少专门做全表 freeze 的必要性，反压 `xid` 水位更从容。
- **`VACUUM (BUFFER_USAGE_LIMIT ...)`**：给 manual vacuum / autovacuum 单独设缓冲环大小（默认 256kB），避免手工 vacuum 冲掉共享缓冲池。
- **SIMD 向量化**：ASCII 与 JSON 字符串搜索、`COPY FROM` 解析等路径使用向量化指令。

```sql
-- 事后看 vacuum 对共享缓冲的影响，可控制占用
VACUUM (VERBOSE, BUFFER_USAGE_LIMIT '8MB') big_table;
```

## 复制

- **备库上可做逻辑解码**：逻辑槽可以建在物理备库上（配合 `pg_log_standby_snapshot()`），主库压力高时可以在备库抽取变更。
- **大事务并行 apply**：`CREATE SUBSCRIPTION ... WITH (streaming = parallel)` 让订阅端用并行 worker 回放进行中的大事务，减少订阅端延迟尖峰。
- **`ORIGIN` 选项防复制环**：订阅端可声明只回放无 origin 的变更，这是构建双向/多主拓扑的关键前提；完整的双向逻辑复制在 [PostgreSQL 17](./postgresql-17-features) 落地。
- **`REPLICA IDENTITY FULL` 走索引**：逻辑复制定位旧行时可用 btree 索引而非全表扫描，宽表逻辑复制成本明显下降。

```sql
-- 在备库创建逻辑槽（需 wal_level = logical，且在备库执行）
SELECT pg_create_logical_replication_slot('app_slot', 'pgoutput');
SELECT pg_log_standby_snapshot();
```

## 监控与观测

- **`pg_stat_io` 视图**：按后端类型（normal / vacuum / autovacuum 等）、I/O 对象和上下文统计读写命中、逐出、重用与 fsync 次数，缓存命中率首次可以细分到「是谁在读」。这是 PG 16 最值得升级的观测能力，用法见 [pg_stat 观测体系](../internals/pg-stat-observation)。
- **最后访问时间**：`pg_stat_all_tables` 等视图新增 `last_seq_scan`、`last_idx_scan` 等列，判断「哪些表/索引真的没人用」终于有直接依据。
- **其他**：UPDATE 迁移到新页面的计数 `n_tup_newpage_upd`；`pg_locks` 暴露投机锁信息；`SYSTEM_USER()` 返回认证方式与认证身份，方便审计区分来源。

```sql
SELECT * FROM pg_stat_io WHERE backend_type = 'autovacuum worker';

SELECT relname, last_seq_scan, last_idx_scan
FROM pg_stat_user_tables
ORDER BY last_idx_scan NULLS FIRST
LIMIT 10;
```

## 安全与权限

- **`pg_hba.conf` 支持正则**：以 `/` 开头的用户名和数据库名条目按正则匹配，规则数量可以收敛。
- **CREATEROLE 收紧**：CREATEROLE 角色不再天然能改「别人创建的角色」，管理成员需要 `ADMIN OPTION`，角色自治边界的坑变小了。
- **角色继承显式化**：`GRANT ... WITH INHERIT TRUE/FALSE`、`GRANT ... SET` 按角色粒度控制继承与切换，配合 [角色与权限](../security/roles-and-permissions) 做最小授权更细。
- **预定义角色 `pg_create_subscription`**：非超级用户创建订阅有了专用角色，不必再给 `CREATEDB`/超级权限。
- **客户端 `require_auth`**：libpq 可要求连接必须通过指定认证方式，防止静默降级为 `trust`。
- **`scram_iterations`**：可调整 SCRAM-SHA-256 迭代次数，在登录开销与离线破解难度间取舍。

## 备份与维护

- **pg_dump 支持 LZ4 / Zstandard 压缩**，备份耗时与恢复解压速度都有可选项可调。
- **pg_basebackup 压缩选项细化**：支持 `--compress=server-5` 这类「在哪端压缩 + 级别」的写法，网络带宽紧张时可让服务端承担压缩。
- **pg_upgrade 要求放宽**：新集群的 locale / encoding 不必与旧集群完全一致（但数据库层面仍需匹配）。
- **vacuumdb 按 schema 操作**（`--schema` / `--exclude-schema`）；`VACUUM` 新增 `PROCESS_MAIN`、`SKIP_DATABASE_STATS` 等选项，脚本化维护更可控。

```bash
# 服务端 zstd 压缩的物理备份
pg_basebackup -D /backup/base -X stream --compress=server-zstd
```

注意：块级**增量备份不是 PG 16 的特性**，`pg_basebackup --incremental` 与 `pg_combinebackup` 在 [PostgreSQL 17](./postgresql-17-features) 才引入，网上不少文章把这归到了 16。

## 升级建议

从 PG 13/14/15 升级到 16 的常见动机：pg_stat_io 与索引使用时间戳（观测）、备库逻辑解码与并行 apply（复制架构）、预排序聚合（报表类查询）。升级路径与注意事项见 [版本升级](../operations/version-upgrade)；2023 年之后的新项目可以直接以 PG 16 为起点。更完整的版本差异对照见 [PostgreSQL 17 新特性摘要](./postgresql-17-features)。

## 相关页面

- [PostgreSQL 17 新特性摘要](./postgresql-17-features)
- [pg_stat 观测体系](../internals/pg-stat-observation)
- [逻辑复制原理](../internals/logical-replication-internals)
- [版本升级](../operations/version-upgrade)
