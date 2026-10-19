# 开发者备忘

这页是我给自己整理的 PostgreSQL 备忘：概念、书目、官方文档、应用场景和常见坑放在一起。站内链接通向展开记录，这里保留常用结论与出处。

## 一、核心概念

1. **进程模型：一个连接一个后端进程**：postmaster 监听端口，为每个客户端连接 fork 一个 backend 进程，查询解析、规划、执行都在该进程内完成；共享内存与信号是进程间协作的纽带。这也是 PostgreSQL 连接开销大于 MySQL 线程模型、需要连接池的根本原因。[进程架构](./internals/process-architecture)、[连接管理](./operations/connection-management)
2. **MVCC：多版本元组 + 快照可见性**：每行带 xmin/xmax 事务号，事务按快照判断哪一版对自己可见，读写互不阻塞；UPDATE 是"插入新版本 + 旧版本标记过期"，DELETE 只打标记。[MVCC 与多版本](./internals/mvcc-and-multi-version)、[快照与可见性](./internals/snapshot-and-visibility)
3. **默认隔离级别是 READ COMMITTED**：每条语句取新快照，不可重复读与幻读在该级别下允许；REPEATABLE READ 用事务级快照提供快照隔离，SERIALIZABLE 走 SSI 谓词锁检测。与 MySQL 默认 REPEATABLE READ 是常见考点差异。[事务与隔离级别](./internals/transactions-and-isolation)
4. **WAL：先写日志，再写数据**：变更先顺序追加到 WAL 并在提交时按 `synchronous_commit` 策略刷盘，数据页可以延后写；崩溃恢复靠重放 WAL。流复制复制的正是这条 WAL 字节流。[WAL 机制](./internals/wal-mechanism)、[流复制搭建](./operations/streaming-replication-setup)
5. **VACUUM 是 MVCC 的账单**：死元组不会自己消失，vacuum 回收空间、冻结事务号、更新可见性映射；HOT 更新在同页内完成并免索引维护。autovacuum 调度跟不上写入就会膨胀。[VACUUM 与 HOT](./internals/vacuum-and-hot)、[autovacuum 调优](./internals/autovacuum-tuning)
6. **索引按数据形态选型**：B-tree 是默认与通解；GIN 服务 jsonb/数组/全文倒排，GiST 服务范围/空间/邻近，BRIN 服务时序追加表，SP-GiST 与 Hash 补齐长尾。[B-tree 结构](./indexing/btree-structure)、[索引选型决策树](./indexing/index-selection-decision-tree)
7. **EXPLAIN (ANALYZE, BUFFERS) 是调优第一入口**：估计行数与实际行数偏差大先查统计信息，再看访问方式、连接方法与排序是否落盘；优化器代价模型全部建立在 pg_statistic 统计之上。[EXPLAIN 基础](./performance/explain-basics)、[优化器代价模型](./internals/optimizer-cost-model)
8. **统计信息驱动计划，ANALYZE 保持新鲜**：默认 autovacuum 触发 analyze，大表批量导入后要手动 `ANALYZE`；扩展统计处理列间相关性。[统计信息与 ANALYZE](./performance/statistics-and-analyze)
9. **复制分物理与逻辑两条轨道**：流复制按字节传 WAL，备库是热备整体副本，支持同步提交；逻辑复制按 publication/subscription 传行变更，可跨版本、可只订部分表。[流复制与同步复制](./internals/streaming-replication-and-sync)、[逻辑复制原理](./internals/logical-replication-internals)
10. **备份与 PITR：逻辑 + 物理双保险**：pg_dump 出逻辑副本，跨版本可移植；pg_basebackup + WAL 归档支撑时间点恢复，恢复到指定时间戳或 LSN。[备份策略](./operations/backup-strategy)、[物理备份与 PITR](./operations/physical-backup-and-pitr)
11. **角色即用户即组**：角色带 LOGIN 属性就是登录用户，角色套角色就是组；权限按 库→schema→表→列 分层授予，默认权限决定新建对象的初始授权。[角色与权限模型](./security/roles-and-permissions)、[对象授权层级](./security/object-grant-hierarchy)
12. **RLS 把过滤条件下沉到内核**：策略定义 USING（读）与 WITH CHECK（写），按角色生效；属主默认绕过，`FORCE` 才约束属主。多租户隔离的内核级方案。[行级安全 RLS](./security/row-level-security)
13. **JSONB 是一等公民类型**：GIN 索引支撑包含查询，`@>`、`?` 操作符与 jsonpath 表达式覆盖结构化查询；但外键、统计、更新局部字段的能力不如关系列。[jsonb 操作](./advanced-sql/jsonb-operations)、[jsonb 设计模式](./advanced-sql/jsonb-design-patterns)
14. **扩展是生态的核心形态**：`CREATE EXTENSION` 即插即用，pgvector 做向量检索、TimescaleDB 做时序、PostGIS 做空间、Citus 做分布式、FDW 做跨库联邦。[扩展管理](./ecosystem/extension-management)、[FDW 与外部数据](./ecosystem/fdw-and-foreign-data)

## 二、权威书籍要点

1. **《PostgreSQL 14 Internals》（Egor Rogov，Postgres Professional）**：官方免费 PDF，MVCC、快照、WAL、锁、vacuum 的实现级讲解；本站底层原理部分与它对齐。
2. **《The Art of PostgreSQL》（Dimitri Fontaine）**：面向应用开发者的 SQL 能力书，窗口函数、CTE、jsonb 的实战用法对应本站高级 SQL 部分。
3. **《PostgreSQL: Up and Running》（Regina Obe & Leo Hsu）**：安装配置与运维概览，对应本站基础知识与架构部署部分。
4. **《数据密集型应用系统设计》（DDIA）**：存储、复制、一致性的系统视角，给复制、备份、高可用章节提供背景框架。

书目均收录在本站[参考书与官方文档索引](./appendix/references-and-docs)。

## 三、官方文档要点

1. **PostgreSQL 官方文档（current）**：全站引用的权威出处，语法、参数、内部机制以它为准：<https://www.postgresql.org/docs/current/>。
2. **Release Notes**：版本变更唯一权威来源；[PG 16 新特性](./ecosystem/postgresql-16-features)与 [PG 17 新特性](./ecosystem/postgresql-17-features)的归属以此核对。
3. **PostgreSQL Wiki**：参数调优、vacuum、性能诊断的社区经验沉淀。
4. **pg_stat 系列视图文档**：[pg_stat 观测](./internals/pg-stat-observation)与排障工具箱的查询模板出处。
5. **EXPLAIN 文档与 explain.depesz.com**：计划解读工具，对应 [EXPLAIN ANALYZE 与 BUFFERS](./performance/explain-analyze-buffers)。

## 四、应用场景

1. **多租户 SaaS**：共享表 + 租户列 + RLS，或 schema-per-tenant；建模权衡见 [多租户建模](./database-design/multi-tenant-modeling)。
2. **向量检索 / AI 应用**：pgvector 存 embedding，HNSW/IVFFlat 近似检索与过滤组合。[向量检索 pgvector](./ecosystem/pgvector)
3. **时序与监控数据**：原生分区起步，量级上来后 TimescaleDB 压缩与连续聚合。[时序扩展 TimescaleDB](./ecosystem/timescaledb)、[分区裁剪](./performance/partition-pruning)
4. **地理位置服务**：PostGIS 的 geometry/geography 与 GiST 空间索引。[空间扩展 PostGIS](./ecosystem/postgis)
5. **异构联邦查询**：postgres_fdw 把 MySQL/另一 PG 库当外表查，持续同步则走逻辑复制。[FDW 与外部数据](./ecosystem/fdw-and-foreign-data)
6. **高可用与容灾**：Patroni + etcd 自动故障切换，流复制 + 同步提交兜底数据安全。[高可用架构](./operations/high-availability-architecture)、[故障演练清单](./operations/disaster-recovery-drills)

## 五、常见坑误区

1. **长事务是万恶之源**：拖住 vacuum 清理、抬高快照 xmin horizon、堆积 WAL；闲置的复制槽同样挡住回收。[VACUUM 停滞与性能](./performance/vacuum-stall-and-performance)
2. **"加了索引还慢"先查失效形态**：列上套函数、隐式类型转换、前导通配 LIKE、OR 混合条件都会让 B-tree 失效。[索引失效与误用](./indexing/index-failure-and-misuse)
3. **max_connections 拉高不是解法**：每连接一个进程，内存与调度成本线性涨；先上 pgbouncer 事务池。[连接管理](./operations/connection-management)
4. **深分页 OFFSET 是伪分页**：偏移越大扫描越多，keyset（WHERE id > $1）才是正解。[分页与排序](./advanced-sql/pagination-and-sorting)
5. **pg_hba 是首条匹配**：顺序写错导致"怎么改都不生效"或"怎么连都被拒"；改完 `pg_reload_conf()` 并用 pg_hba_file_rules 校验。[pg_hba 与认证](./security/pg-hba-and-authentication)
6. **RLS 对属主默认不生效**：测了半天"策略没起作用"，其实是用 owner 连的；`FORCE ROW LEVEL SECURITY` 才约束属主。[行级安全 RLS](./security/row-level-security)
7. **从 MySQL 迁移不是语法直译**：GROUP BY 宽松模式、引号语义、大小写折叠、隐式类型转换、日期格式化函数都有差异。[与 MySQL 对比](./ecosystem/comparison-with-mysql)
8. **大批量导入后不 ANALYZE，计划必歪**：统计信息还是空的或旧值，优化器在盲猜；导完顺手 `ANALYZE`。[统计信息与 ANALYZE](./performance/statistics-and-analyze)

## 来源

- [S1] PostgreSQL Documentation — <https://www.postgresql.org/docs/current/>
- [S2] PostgreSQL Release Notes — <https://www.postgresql.org/docs/release/>
- [S3] PostgreSQL Wiki — <https://wiki.postgresql.org/>
- [S4] 《PostgreSQL 14 Internals》官方免费 PDF — <https://postgrespro.com/community/books/internals>
- [S5] use-the-index-luke.com — <https://use-the-index-luke.com/>
- [S6] explain.depesz.com — <https://explain.depesz.com/>

<!-- BACKLINKS-AUTO -->
## 相关页面

- [index](/appendix/index.md)
- [index](/basics/index.md)
