# Hello PostgreSQL 知识点目录（OUTLINE）

> 本站点的知识地图与页面规划。写作会话按本表逐页产出，每完成一页把状态改为 `[x]`。
> 参考姊妹仓 `hello-mysql` 的结构与写作口径（中文正文、每页一到两个核心知识点、命令示例可复现）。

## 规模基准

hello-mysql 共 130 页（basics 13 / database-design 18 / advanced-sql 24 / internals 22 / architecture 11 / tuning 12 / tools 10 / future 8 / appendix 4）。本仓目标 120-140 页，同级深度。

---

## 第 1 部分：基础知识 basics（约 15 页）

- [x] 什么是 PostgreSQL（历史、许可、ACID、MVCC 取向、生态位）
- [x] 安装与快速上手（Linux apt/yum、macOS、Windows、初始化集群 initdb）
- [x] psql 入门（连接、元命令 `\dt \d \timing \x`、历史、psqlrc）
- [x] 数据库与 schema 对象（database/schema/table/owner 关系、search_path）
- [x] 数据类型总览（numeric/text/时间、serial 与 identity、UUID）
- [x] 特色类型入门（JSONB、数组、range、hstore、枚举、复合类型）
- [x] CRUD 与 ON CONFLICT（INSERT/UPDATE/DELETE、UPSERT、RETURNING）
- [x] WHERE 与表达式（比较、LIKE/ILIKE、BETWEEN、IN、NULL 语义）
- [x] 聚合与 GROUP BY（COUNT/SUM、HAVING、DISTINCT、分组空值）
- [x] JOIN 全家族（inner/left/right/full/cross、USING/NATURAL、自连接）
- [x] 函数与运算符（SQL 函数、PL/pgSQL 入门、`::` 强转、COALESCE）
- [x] 事务入门（BEGIN/COMMIT/ROLLBACK、SAVEPOINT、autocommit）
- [x] 常用系统表与元数据（pg_class/pg_tables/information_schema）
- [x] 命名与书写规范（标识符大小写、双引号陷阱、SQL 风格）
- [x] 常见新手错误（大小写折叠、NULL 比较、隐式类型转换、时区）

## 第 2 部分：数据库设计 database-design（约 14 页）

- [ ] 三范式与反范式（1NF/2NF/3NF、冗余与读性能权衡）
- [ ] 主键设计（BIGINT identity vs UUID vs 复合键、游标分页友好）
- [ ] 外键与引用动作（ON DELETE CASCADE/SET NULL、延迟约束）
- [ ] CHECK 与域类型（域复用、正则约束、约束命名）
- [ ] 表继承与分区表设计（声明式 PARTITION BY RANGE/LIST/HASH）
- [ ] 视图与可更新视图（WITH CHECK OPTION、简单视图可写性）
- [ ] 物化视图（REFRESH CONCURRENTLY、增量刷新、使用场景）
- [ ] 逻辑建模到物理落地（E-R 图、序列、默认值、时间戳惯例）
- [ ] 软删除与墓碑（deleted_at、唯一索引与 NULL、部分索引配合）
- [ ] 多租户建模（schema-per-tenant vs RLS vs 单表 tenant_id）
- [ ] 时间建模（timestamptz 惯例、时区、有效期 range 类型）
- [ ] 金额与数值（numeric 定点、货币、舍入规则）
- [ ] 约束与数据质量（NOT NULL 策略、EXCLUSION 约束、触发器兜底）
- [ ] 反模式清单（EAV 滥用、万能 JSONB 表、无界自关联）

## 第 3 部分：高级 SQL advanced-sql（约 18 页）

- [ ] CTE 与非递归 WITH（可读性、MATERIALIZED/NOT MATERIALIZED）
- [ ] 递归 CTE（层级遍历、树/图、循环终止、UNION ALL 语义）
- [ ] 窗口函数（OVER/PARTITION BY/ORDER BY、frame 行为）
- [ ] 窗口函数进阶（LAG/LEAD、NTILE、排名族、移动平均 frame）
- [ ] 集合运算（UNION/INTERSECT/EXCEPT、ALL 与去重、排序）
- [ ] LATERAL 与 FROM 子查询（相关子查询下推、top-N per group）
- [ ] 子查询家族（标量/IN/EXISTS/ANY、去相关化）
- [ ] JSONB 操作（->/->>/#>/@>、jsonb_path、containment 索引）
- [ ] JSONB 设计模式（文档列、生成列、部分索引、与列存取舍）
- [ ] 数组操作（`unnest`、数组包含、GIN 索引配合）
- [ ] 范围类型与 EXCLUDE（tsrange、期间重叠约束）
- [ ] 全文检索（tsvector/tsquery、权重建模、GIN、同义词与词典）
- [ ] 三模式匹配（LIKE/ILIKE、正则、pg_trgm 相似度与索引）
- [ ] 生成列与 CHECK 表达式（GENERATED ALWAYS AS、索引化）
- [ ] 条件表达式（CASE、FILTER、DISTINCT ON、NULLS FIRST/LAST）
- [ ] 分页与排序（OFFSET 陷阱、keyset/cursor 分页、不稳定排序）
- [ ] SQL 函数进阶（plpgsql 变量、异常块、STABLE/IMMUTABLE 标注）
- [ ] 批量与写入（COPY、INSERT 多值、ON CONFLICT 批量、EXCLUDE）

## 第 4 部分：内核机制 internals（约 20 页）

- [ ] 进程架构（postmaster、backend、autovacuum、background worker）
- [ ] MVCC 与多版本（元组头、xmin/xmax、快照 Snapshot）
- [ ] 事务与隔离级别（READ COMMITTED 默认、RR/SSI、锁升级）
- [ ] VACUUM 与 HOT（死元组、可见性映射、HOT 更新、fillfactor）
- [ ] autovacuum 调优（阈值、比例、cost delay、卡住排查）
- [ ] WAL 机制（WAL 记录、LSN、预写日志与崩溃恢复）
- [ ] checkpoint 与 buffer（shared_buffers、bgwriter/checkpointer）
- [ ] 锁系统（表锁模式、行锁 FOR UPDATE、咨询锁 pg_advisory）
- [ ] 锁冲突排查（pg_locks、pg_blocking_pids、死锁与重试）
- [ ] TOAST（大字段外置、压缩、MOVABLE、触发 DML 的行为）
- [ ] 快照与可见性判定（命令 id、clog、事务状态）
- [ ] 查询执行管道（parse→rewrite→plan→execute、executor 节点）
- [ ] 优化器代价模型（cost、统计信息 pg_statistic、直方图）
- [ ] join 实现（nested loop/merge/hash、选择依据）
- [ ] 并行查询（parallel workers、代价阈值、不能并行的场景）
- [ ] 计划缓存与 generic plan（prepared statement 计划漂移）
- [ ] 逻辑复制底层（wal_level、decoding、publication/subscription）
- [ ] 流复制与同步（primary/standby、synchronous_commit、延迟）
- [ ] 体系结构与内存（work_mem、maintenance_work_mem、OOM 风险）
- [ ] pg_stat 观测（stat_activity、stat_statements、stat_io、计划统计）

## 第 5 部分：索引体系 indexing（约 12 页）

- [ ] B-tree 结构与原则（等值/范围/排序、最左前缀、选择性）
- [ ] 组合索引设计（列序、覆盖索引 INCLUDE、索引跳扫）
- [ ] GIN（倒排、jsonb/数组/全文、fastupdate 与 pending list）
- [ ] GiST（空间/范围/全文、弹性索引、KNN 查询）
- [ ] BRIN（列存式块摘要、时序/追加表、minmax-multi）
- [ ] SP-GiST 与 Hash（分区式结构、等值哈希、适用场景）
- [ ] 部分索引（WHERE 条件索引、热点行、软删配合）
- [ ] 表达式索引（函数索引、大小写/去空白、生成列取舍）
- [ ] 仅索引扫描（INDEX COVERING、visibility map 依赖）
- [ ] 索引膨胀与维护（REINDEX CONCURRENTLY、统计、监测）
- [ ] 索引失效与误用（隐式转换、函数包裹列、优化器放弃索引）
- [ ] 索引选型决策树（按查询形态选 B-tree/GIN/BRIN/GiST）

## 第 6 部分：查询调优与性能 performance（约 14 页）

- [ ] EXPLAIN 读法（cost/rows/actual、计划树从内到外）
- [ ] EXPLAIN (ANALYZE, BUFFERS, WAL)（真实执行、缓存命中、IO）
- [ ] 常见坏计划（seq scan 大表、错误 rows 估计、nested loop 爆炸）
- [ ] 统计信息与 ANALYZE（采样率、手动加大、过期统计）
- [ ] pg_stat_statements（top SQL、规划/执行时间、归一化、重置）
- [ ] 慢查询治理流程（采集→复现→改写→验证 A/B）
- [ ] 连接与 ORM 优化（N+1、批量、prepared、管道）
- [ ] 写入吞吐优化（批量插入、unlogged 表、提交频率、synchronous_commit）
- [ ] 参数调优（shared_buffers/work_mem/effective_cache_size 指导）
- [ ] 分区裁剪与裁剪失败（约束排除、运行时裁剪、分区键设计）
- [ ] 锁与并发瓶颈（长事务、热点行、UPDATE 自旋、advisory 锁队列）
- [ ] VACUUM 卡顿对性能的影响（IO 争用、age 阈值、监控）
- [ ] 基准工具（pgbench 自定义脚本、TPC-C 类近似、指标口径）
- [ ] 容量与扩展边界（单机上限、什么时候该分片/换方案）

## 第 7 部分：架构与部署 operations（约 12 页）

- [ ] 集群初始化与目录布局（initdb、data 目录、版本共存）
- [ ] 连接管理（连接池 pgbouncer/pgbouncer 语义、事务池限制）
- [ ] 高可用架构（patroni/etcd、自动故障切换、仲裁与脑裂）
- [ ] 流复制搭建（primary/standby、复制槽、wal sender 监控）
- [ ] 逻辑复制运维（publication/subscription、DDL 同步边界、冲突）
- [ ] 备份策略（pg_dump/pg_dumpall、并行、逻辑备份边界）
- [ ] 物理备份与 PITR（WAL 归档、pg_basebackup、时间点恢复演练）
- [ ] 版本升级（pg_upgrade --link、扩展兼容、滚动升级路径）
- [ ] 云原生与容器（Docker 镜像、statefulset 要点、持久卷）
- [ ] 监控告警（关键指标、exporter、磁盘/复制延迟/事务年龄）
- [ ] 故障演练清单（主库宕机、磁盘满、表膨胀、复制中断）
- [ ] 运维 SOP（日常巡检、索引维护、vacuum 监控、保留策略）

## 第 8 部分：安全 security（约 8 页）

- [ ] 角色与权限模型（ROLE/GRANT/REVOKE、属性 NOLOGIN/SUPERUSER）
- [ ] 对象授权层级（库/schema/表/列/行级、默认权限 ALTER DEFAULT）
- [ ] 行级安全 RLS（policy、USING/FOR CHECK、角色与策略组合）
- [ ] pg_hba 与认证（method 顺序、hostssl、md5/scram、拒绝排查）
- [ ] SSL 与传输加密（配置、证书、强制加密）
- [ ] 数据静态加密（pgcrypto、密钥管理、备份加密）
- [ ] 审计（pgaudit、日志开关、statement 归档）
- [ ] 加固清单（最小权限、禁超级用户登录应用、扩展白名单）

## 第 9 部分：生态与新特性 ecosystem（约 10 页）

- [ ] PostgreSQL 16 新特性摘要
- [ ] PostgreSQL 17 新特性摘要
- [ ] 向量检索 pgvector（embedding、HNSW/IVFFlat、召回与过滤）
- [ ] 时序扩展 TimescaleDB（hypertable、压缩、连续聚合）
- [ ] 空间扩展 PostGIS（geometry/geography、索引、常用函数）
- [ ] 分布式 Citus（分片、共置、适用与不适用）
- [ ] FDW 与外部数据（postgres_fdw、mysql_fdw、跨库查询）
- [ ] 扩展管理（CREATE EXTENSION、版本、pgxn）
- [ ] 与 MySQL 对比（复制/锁/类型/生态、迁移注意、双栈共存）
- [ ] 选型问答（什么时候 PG 是对的）

## 第 10 部分：工具与实战 tools（约 8 页）

- [ ] psql 高阶（变量、\gexec、模板、锚定查询）
- [ ] pgAdmin 4（部署、查询工具、监控面板）
- [ ] DBeaver / VS Code 插件（连接管理、ER 图、数据编辑）
- [ ] schema 迁移工具（migrate、golang-migrate、Flyway、prisma migrate）
- [ ] 客户端驱动（psycopg、node-postgres、连接字符串与池）
- [ ] 排障工具箱（pg_stat_activity 抓现场、auto_explain、log_min_duration）
- [ ] 本地开发环境（docker compose 起库、seed 数据、测试库隔离）
- [ ] 实战案例（订单库分页、库存扣减幂等、活动计数器）

## 附录 appendix（约 5 页）

- [ ] 术语表（中英对照）
- [ ] SQL 命令速查
- [ ] psql 元命令速查
- [ ] 常见错误与排查对照表
- [ ] 参考书与官方文档索引

---

## 写作规范（每页必守）

1. 标题层级：单 H1，知识点用 H2；命令示例 fenced code block 标注 `sql` / `plaintext`。
2. 结构：概述 → 原理/要点 → 示例（可复制执行）→ 注意事项/坑 → 相关页面链接。
3. 示例优先 PostgreSQL 16/17 通用语法；版本差异要标注。
4. 不写「最先进/第一」类夸大词；引用官方文档给出链接。
5. 每页 80-200 行；深度对齐 hello-mysql 同类页面。
