// Single source of truth for the bilingual site (English at root, Chinese under
// /zh/). Both sidebars and both locale navigations are derived from this file;
// nothing else may hand-write section names or page titles.

// Page entries: [slug, English title, Chinese title].
export const pages = {
  'basics': [
    ['what-is-postgresql', 'What Is PostgreSQL', '什么是 PostgreSQL'],
    ['install-and-quickstart', 'Installation and First Connection', '安装与首次连接'],
    ['psql-getting-started', 'Everyday psql', 'psql 常用操作'],
    ['database-and-schema-objects', 'Databases and Schema Objects', '数据库与 schema 对象'],
    ['data-types-overview', 'Data Types Overview', '数据类型总览'],
    ['special-types-intro', 'A Tour of Special Types', '特色类型概览'],
    ['crud-and-on-conflict', 'CRUD and ON CONFLICT', 'CRUD 与 ON CONFLICT'],
    ['where-and-expressions', 'WHERE and Expressions', 'WHERE 与表达式'],
    ['aggregate-and-group-by', 'Aggregation and GROUP BY', '聚合与 GROUP BY'],
    ['join-family', 'The JOIN Family', 'JOIN 全家族'],
    ['functions-and-operators', 'Functions and Operators', '函数与运算符'],
    ['transaction-basics', 'Transaction Basics', '事务基础'],
    ['system-catalogs-and-metadata', 'System Catalogs and Metadata', '常用系统表与元数据'],
    ['naming-and-style-conventions', 'Naming and Style Conventions', '命名与书写规范'],
    ['common-beginner-mistakes', 'Common Beginner Mistakes', '常见踩坑'],
  ],
  'database-design': [
    ['normalization-and-denormalization', 'Normalization and Denormalization', '三范式与反范式'],
    ['primary-key-design', 'Primary Key Design', '主键设计'],
    ['foreign-keys-and-referential-actions', 'Foreign Keys and Referential Actions', '外键与引用动作'],
    ['check-and-domains', 'CHECK Constraints and Domains', 'CHECK 与域类型'],
    ['table-inheritance-and-partitioning-design', 'Table Inheritance and Partitioning', '表继承与分区表设计'],
    ['views-and-updatable-views', 'Views and Updatable Views', '视图与可更新视图'],
    ['materialized-views', 'Materialized Views', '物化视图'],
    ['logical-to-physical-modeling', 'From Logical Model to Physical Table', '逻辑建模到物理落地'],
    ['soft-delete-and-tombstone', 'Soft Delete and Tombstones', '软删除与墓碑'],
    ['multi-tenant-modeling', 'Multi-Tenant Modeling', '多租户建模'],
    ['time-modeling', 'Modeling Time', '时间建模'],
    ['money-and-numeric', 'Money and Numeric', '金额与数值'],
    ['constraints-and-data-quality', 'Constraints and Data Quality', '约束与数据质量'],
    ['anti-patterns', 'Design Anti-Patterns', '反模式清单'],
  ],
  'advanced-sql': [
    ['cte-and-non-recursive-with', 'CTEs and Non-Recursive WITH', 'CTE 与非递归 WITH'],
    ['recursive-cte', 'Recursive CTEs', '递归 CTE'],
    ['window-functions', 'Window Functions', '窗口函数'],
    ['window-functions-advanced', 'Window Functions in Depth', '窗口函数进阶'],
    ['set-operations', 'Set Operations', '集合运算'],
    ['lateral-and-from-subquery', 'LATERAL and FROM Subqueries', 'LATERAL 与 FROM 子查询'],
    ['subquery-family', 'The Subquery Family', '子查询家族'],
    ['jsonb-operations', 'JSONB Operations', 'JSONB 操作'],
    ['jsonb-design-patterns', 'JSONB Design Patterns', 'JSONB 设计模式'],
    ['array-operations', 'Array Operations', '数组操作'],
    ['range-types-and-exclude', 'Range Types and EXCLUDE', '范围类型与 EXCLUDE'],
    ['full-text-search', 'Full-Text Search', '全文检索'],
    ['pattern-matching', 'Three Patterns of Pattern Matching', '三种模式匹配'],
    ['generated-columns-and-check', 'Generated Columns and CHECK Expressions', '生成列与 CHECK 表达式'],
    ['conditional-expressions', 'Conditional Expressions', '条件表达式'],
    ['pagination-and-sorting', 'Pagination and Sorting', '分页与排序'],
    ['sql-functions-advanced', 'SQL Functions in Depth', 'SQL 函数进阶'],
    ['batch-and-write', 'Batching and Writes', '批量与写入'],
  ],
  'internals': [
    ['process-architecture', 'Process Architecture', '进程架构'],
    ['mvcc-and-multi-version', 'MVCC and Multi-Versioning', 'MVCC 与多版本'],
    ['transactions-and-isolation', 'Transactions and Isolation Levels', '事务与隔离级别'],
    ['vacuum-and-hot', 'VACUUM and HOT', 'VACUUM 与 HOT'],
    ['autovacuum-tuning', 'Autovacuum Tuning', 'autovacuum 调优'],
    ['wal-mechanism', 'The WAL Mechanism', 'WAL 机制'],
    ['checkpoint-and-buffer', 'Checkpoints and Buffers', 'checkpoint 与 buffer'],
    ['lock-system', 'The Lock System', '锁系统'],
    ['lock-conflict-troubleshooting', 'Troubleshooting Lock Conflicts', '锁冲突排查'],
    ['toast', 'TOAST', 'TOAST'],
    ['snapshot-and-visibility', 'Snapshots and Visibility', '快照与可见性判定'],
    ['query-execution-pipeline', 'The Query Execution Pipeline', '查询执行管道'],
    ['optimizer-cost-model', 'The Optimizer Cost Model', '优化器代价模型'],
    ['join-implementations', 'Join Implementations', 'join 实现'],
    ['parallel-query', 'Parallel Query', '并行查询'],
    ['plan-cache-and-generic-plan', 'Plan Cache and Generic Plans', '计划缓存与 generic plan'],
    ['logical-replication-internals', 'Logical Replication Internals', '逻辑复制底层'],
    ['streaming-replication-and-sync', 'Streaming and Synchronous Replication', '流复制与同步'],
    ['architecture-and-memory', 'Architecture and Memory', '体系结构与内存'],
    ['pg-stat-observation', 'Observing With pg_stat', 'pg_stat 观测'],
  ],
  'indexing': [
    ['btree-structure', 'B-tree Structure and Principles', 'B-tree 结构与原则'],
    ['composite-index-design', 'Composite Index Design', '组合索引设计'],
    ['gin', 'GIN Indexes', 'GIN 索引'],
    ['gist', 'GiST Indexes', 'GiST 索引'],
    ['brin', 'BRIN Indexes', 'BRIN 索引'],
    ['spgist-and-hash', 'SP-GiST and Hash', 'SP-GiST 与 Hash'],
    ['partial-indexes', 'Partial Indexes', '部分索引'],
    ['expression-indexes', 'Expression Indexes', '表达式索引'],
    ['index-only-scans', 'Index-Only Scans', '仅索引扫描'],
    ['index-bloat-and-maintenance', 'Index Bloat and Maintenance', '索引膨胀与维护'],
    ['index-failure-and-misuse', 'Index Failures and Misuse', '索引失效与误用'],
    ['index-selection-decision-tree', 'The Index Selection Decision Tree', '索引选型决策树'],
  ],
  'performance': [
    ['explain-basics', 'Reading EXPLAIN', 'EXPLAIN 读法'],
    ['explain-analyze-buffers', 'EXPLAIN (ANALYZE, BUFFERS, WAL)', 'EXPLAIN (ANALYZE, BUFFERS, WAL)'],
    ['common-bad-plans', 'Common Bad Plans', '常见坏计划'],
    ['statistics-and-analyze', 'Statistics and ANALYZE', '统计信息与 ANALYZE'],
    ['pg-stat-statements', 'pg_stat_statements', 'pg_stat_statements'],
    ['slow-query-governance', 'A Slow Query Governance Workflow', '慢查询治理流程'],
    ['connection-and-orm-optimization', 'Connection and ORM Optimization', '连接与 ORM 优化'],
    ['write-throughput-optimization', 'Write Throughput Optimization', '写入吞吐优化'],
    ['parameter-tuning', 'Parameter Tuning', '参数调优'],
    ['partition-pruning', 'Partition Pruning', '分区裁剪与裁剪失败'],
    ['lock-and-concurrency-bottlenecks', 'Lock and Concurrency Bottlenecks', '锁与并发瓶颈'],
    ['vacuum-stall-and-performance', 'VACUUM Stalls and Performance', 'VACUUM 卡顿对性能的影响'],
    ['benchmark-tools', 'Benchmark Tools', '基准工具'],
    ['capacity-and-scaling-limits', 'Capacity and Scaling Limits', '容量与扩展边界'],
  ],
  'operations': [
    ['cluster-init-and-layout', 'Cluster Init and Directory Layout', '集群初始化与目录布局'],
    ['connection-management', 'Connection Management', '连接管理'],
    ['high-availability-architecture', 'High Availability Architectures', '高可用架构'],
    ['streaming-replication-setup', 'Setting Up Streaming Replication', '流复制搭建'],
    ['logical-replication-ops', 'Logical Replication Operations', '逻辑复制运维'],
    ['backup-strategy', 'Backup Strategy', '备份策略'],
    ['physical-backup-and-pitr', 'Physical Backup and PITR', '物理备份与 PITR'],
    ['version-upgrade', 'Version Upgrades', '版本升级'],
    ['cloud-native-and-containers', 'Cloud-Native and Containers', '云原生与容器'],
    ['monitoring-and-alerting', 'Monitoring and Alerting', '监控告警'],
    ['disaster-recovery-drills', 'Disaster Recovery Drills', '故障演练清单'],
    ['ops-sop', 'Ops SOPs', '运维 SOP'],
  ],
  'security': [
    ['roles-and-permissions', 'Roles and the Permission Model', '角色与权限模型'],
    ['object-grant-hierarchy', 'The Object Grant Hierarchy', '对象授权层级'],
    ['row-level-security', 'Row-Level Security', '行级安全 RLS'],
    ['pg-hba-and-authentication', 'pg_hba and Authentication', 'pg_hba 与认证'],
    ['ssl-and-transport-encryption', 'SSL and Transport Encryption', 'SSL 与传输加密'],
    ['data-encryption-at-rest', 'Encryption at Rest', '数据静态加密'],
    ['audit', 'Auditing', '审计'],
    ['hardening-checklist', 'Hardening Checklist', '加固清单'],
  ],
  'ecosystem': [
    ['postgresql-16-features', 'PostgreSQL 16 Highlights', 'PostgreSQL 16 新特性摘要'],
    ['postgresql-17-features', 'PostgreSQL 17 Highlights', 'PostgreSQL 17 新特性摘要'],
    ['pgvector', 'pgvector: Vector Search', '向量检索 pgvector'],
    ['timescaledb', 'TimescaleDB: Time Series', '时序扩展 TimescaleDB'],
    ['postgis', 'PostGIS: Geospatial', '空间扩展 PostGIS'],
    ['citus', 'Citus: Distributed PostgreSQL', '分布式 Citus'],
    ['fdw-and-foreign-data', 'FDW and Foreign Data', 'FDW 与外部数据'],
    ['extension-management', 'Extension Management', '扩展管理'],
    ['comparison-with-mysql', 'PostgreSQL vs MySQL', '与 MySQL 对比'],
    ['when-to-choose-postgresql', 'Choosing PostgreSQL', '选型问答'],
  ],
  'tools': [
    ['psql-advanced', 'psql Advanced', 'psql 高阶'],
    ['pgadmin-4', 'pgAdmin 4', 'pgAdmin 4'],
    ['dbeaver-and-vscode', 'DBeaver and VS Code Extensions', 'DBeaver 与 VS Code 插件'],
    ['schema-migration-tools', 'Schema Migration Tools', 'schema 迁移工具'],
    ['client-drivers', 'Client Drivers', '客户端驱动'],
    ['troubleshooting-toolbox', 'Troubleshooting Toolbox', '排障工具箱'],
    ['local-dev-environment', 'Local Development Environments', '本地开发环境'],
    ['real-world-cases', 'Real-World Cases', '实战案例'],
  ],
  'appendix': [
    ['glossary', 'Glossary', '术语表'],
    ['sql-command-reference', 'SQL Command Reference', 'SQL 命令速查'],
    ['psql-meta-command-reference', 'psql Meta-Command Reference', 'psql 元命令速查'],
    ['common-errors-and-troubleshooting', 'Common Errors and Fixes', '常见错误与排查对照表'],
    ['references-and-docs', 'Books and Official Docs', '参考书与官方文档索引'],
  ],
}

// Section entries: [English title, Chinese title, collapsed].
// Section titles double as the H1 of each section index page.
export const sections = {
  'basics': ['Basics & Core SQL', '基础与常用 SQL', true],
  'database-design': ['Database Design', '数据库设计', true],
  'advanced-sql': ['Advanced SQL', '高级 SQL', true],
  'internals': ['Internals', '内核观察', true],
  'indexing': ['Indexing', '索引与使用', true],
  'performance': ['Query Performance', '查询性能', true],
  'operations': ['Architecture & Operations', '架构与运维', true],
  'security': ['Security', '安全', true],
  'ecosystem': ['Ecosystem & New Features', '生态与新特性', true],
  'tools': ['Tools & Cases', '开发工具与案例', true],
  'appendix': ['Appendix', '附录', true],
}

/** All titles keyed by slug, i.e. titles.en['basics'] -> "Basics & Core SQL". */
export const titles = (() => {
  const en = {}
  const zh = {}
  for (const [key, entry] of Object.entries(sections)) {
    en[key] = entry[0]
    zh[key] = entry[1]
  }
  for (const [dir, list] of Object.entries(pages)) {
    for (const [slug, enTitle, zhTitle] of list) {
      en[`${dir}/${slug}`] = enTitle
      zh[`${dir}/${slug}`] = zhTitle
    }
  }
  en.knowledge = 'Dev Notes'
  zh.knowledge = '开发者备忘'
  return { en, zh }
})()
