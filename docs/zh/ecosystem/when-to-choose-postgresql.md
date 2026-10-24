# 选型问答

本页回答「这个业务该不该用 PostgreSQL」。数据库选型没有普适答案，但有一套可以复用的判断框架：先把业务特征（数据形态、读写比例、一致性要求、团队技能）列清楚，再对照每个候选的成本与收益。文中涉及的架构背景见 [PostgreSQL 是什么](/zh/basics/what-is-postgresql)，与 MySQL 的逐项对照见 [与 MySQL 对比](/zh/ecosystem/comparison-with-mysql)。

我做选型时会先对照下面两个清单，再带着具体业务问题看 Q&A，最后回到「小结」的三问复核判断。选型讨论中最常见的失误是拿着单一维度（比如「MySQL 简单」或「PG 功能多」）直接下结论，而跳过了团队与运维成本这两个长期权重最大的变量。

## 什么时候 PostgreSQL 是对的选择

- **查询复杂度高**：多维报表、窗口计算、递归层级、JSON/数组混查——PG 的 SQL 能力让大量加工留在数据库内完成，不用把数据拉回应用层。
- **数据完整性优先**：约束体系（外键、CHECK、排他约束、可延迟约束）加上可串行化隔离，适合账务、库存、订单这类「错一条都是事故」的场景。
- **关系与文档混合建模**：主体是关系数据但夹杂灵活字段，JSONB + GIN 索引覆盖大多数文档需求，还不用放弃事务和 JOIN。
- **依赖扩展生态**：向量（pgvector）、空间（PostGIS）、时序（TimescaleDB）、分布式（Citus）都在同一个引擎内，避免每个能力引入一套独立存储。
- **许可证自由**：PostgreSQL License 宽松且无单一厂商控制，自托管、云托管、商业发行版任选，不会被许可费绑定。

## 什么时候需要谨慎

- **写入规模确实需要水平分片**：业务天然无分片键、写吞吐远超单机上限，分布式改造的复杂度在哪个数据库上都存在，PG 不是例外。
- **团队 MySQL 经验深厚而负载简单**：以 CRUD 为主、查询不复杂、团队现有运维资产（监控、备份、演练流程）都在 MySQL 上，迁移的收益通常覆盖不了成本。
- **深度绑定某个托管产品**：部分「PG 兼容」服务在存储与内部机制上有自家实现，迁入容易迁出难，先想好退出路径。
- **极简的单表键值型负载**：只有几张表、纯粹按主键读写、峰值并发极高，这类负载 MySQL 与各种 KV 存储都有更省心的先例，PG 的能力空间用不上多少。
- **对冷门版本有硬性合规要求**：某些行业必须长期停留在特定认证版本，PG 的一年一大版节奏需要提前规划，而不是被动跟随。

## 选型问答

### PG 能扛多大数据量？

单实例 TB 级是常见水位，亿级行单表配合分区与正确索引完全可以工作。真正的上限通常不是数据量，而是：工作集能否被缓存命中、连接数与内存模型、vacuum 能否跟上写入。数据量增长时的常规路径是「先优化索引与参数 → 读流量走副本 → 按时间或键分区 → 确实需要时再上分布式」，容量测算方法见 [容量与扩展上限](/zh/performance/capacity-and-scaling-limits)。

反过来问更有用：什么信号说明「还在单机舒适区」？——缓存命中率稳定、vacuum 不堆积、慢查询集中在个别 SQL、备份窗口可接受。这些指标都健康时，数据量本身不构成迁移理由。

### 需要分库分表吗？

多数业务不需要。MySQL 生态流行的中间件分库分表解决的是「单机时代」的问题，PG 提供了中间形态：原生分区解决单表过大与生命周期管理，Citus 在确实需要横向扩展时提供分布式能力且保留单库 SQL 语义（见 [分布式 Citus](/zh/ecosystem/citus)）。判断顺序建议是：先用尽单机手段，再考虑分区，最后才考虑跨机分片——每往右一步，运维复杂度上一个量级。

### 托管服务怎么选？

RDS for PostgreSQL、Cloud SQL、阿里云 RDS PG 等主流托管都可用，比价之外重点核对四件事：扩展白名单是否包含你需要的（pgvector、PostGIS 等）、大版本跟进速度、是否支持逻辑复制（升级与迁移的退路）、存储架构与原生的差异（部分兼容实现有自家 I/O 模型）。自托管容器化方案见 [云原生与容器化部署](/zh/operations/cloud-native-and-containers)。

### 从 MySQL 迁移值不值？

取决于痛点是否存在：被 JSON 处理、复杂报表、类型漏洞反复消耗，迁移有明确收益；一切正常就别动。迁移的真实成本在 SQL 改写（语法差异清单见 [与 MySQL 对比](/zh/ecosystem/comparison-with-mysql)）、连接池引入和团队重学，不在安装本身。稳妥路径是双轨过渡：新服务直接用 PG，旧系统继续跑 MySQL，用 FDW 做只读联合查询兜底，按服务逐步切换而不是一次性搬家。

### 高并发写入会不会吃亏？

简单高并发点写（自增主键、短事务）是 MySQL/InnoDB 的传统强项，PG 在同类负载下也够用（单机数千 TPS 常见），但需要理解它的 MVCC 代价：更新产生新版本、依赖 vacuum 回收。把写入路径做对——批量写入、HOT 更新、控制长事务、合理 fillfactor——PG 的写吞吐满足绝大多数 OLTP 业务；极限写吞吐场景两种数据库都需要架构级拆分，见 [写吞吐优化](/zh/performance/write-throughput-optimization)。

补充一个常被引用的失效模式：高频更新同一行（秒杀式热点计数）在 PG 下会形成行锁排队加版本堆积，这类热点要么换数据结构（队列、Redis 计数后回填），要么用分区摊平，继续在行级硬扛是两边都不推荐的。

### JSON 文档场景要不要直接用文档数据库？

如果文档需要与关系数据一起事务、JOIN、约束校验，PG 的 JSONB 是更省事的方案：一套存储、一套备份、一套权限。文档数量到亿级、访问模式完全键值化、团队已经运维 MongoDB 且有对应运维能力时，专用文档库才是合理选择。判断标准是数据之间的关系强度，而不是「有没有 JSON」。

### 大版本升级风险大吗？

PG 每年一个大版本，minor 版本只修 bug 不改行为。大版本升级有两条成熟路径：`pg_upgrade`（停机窗口分钟级）与逻辑复制切换（近零停机），见 [版本升级](/zh/operations/version-upgrade)。托管服务通常一键 minor 升级。相比某些数据库的大版本断裂，PG 的升级成本可控，不必因「怕升级」留在旧版本——旧版本失去安全修复才是真风险。

### 团队没有 PG 经验怎么办？

从 MySQL 转 PG 的学习曲线平缓：SQL 主干一致，需要重点补的是四件事——连接池与进程模型、vacuum 与膨胀、EXPLAIN 读法、MVCC 隔离行为，本站的 [内部原理](/zh/internals/process-architecture) 与 [性能诊断](/zh/performance/explain-basics) 部分覆盖这些主题。ORM 会掩盖大部分方言差异，真正的坑集中在运维侧，我会确保团队有人负责运维主线。

### 起步之后第一个月要盯什么？

选型落地后，前几周值得建立的习惯（比事后救火便宜得多）：

- **连接池先行**：应用侧直接接 PgBouncer 或托管连接代理，别等连接数报警再补；
- **观察 autovacuum**：确认高更新表的单轮 vacuum 时长与死元组水位，基线数据见 [autovacuum 调优](/zh/internals/autovacuum-tuning)；
- **装上 pg_stat_statements**：从第一天积累 SQL 耗时数据，后续治理才有依据，见 [pg_stat_statements](/zh/performance/pg-stat-statements)；
- **备份必须演练恢复**：定期把备份恢复到临时实例并抽查数据，没验证过恢复的备份不算备份，流程见 [备份策略](/zh/operations/backup-strategy)；
- **长事务告警**：对超过 minutes 级的事务设告警，这是 PG 世界里少数「一开始就该当成红线」的项。

## 小结

把判断压缩成三问：业务是否需要 PG 的 SQL 深度与扩展生态？团队能否承担运维模型的切换？现有 MySQL 方案是否有真实痛点？三问里有两个「是」，迁移和选 PG 就值得做；反之，MySQL 继续服务好这类负载也完全成立。两个都是经过大规模生产验证的系统，选型分歧的代价通常小于选型后不用心运维的代价。

## 参考资料

- [wiki.postgresql.org/wiki/Foreign_data_wrappers](https://wiki.postgresql.org/wiki/Foreign_data_wrappers)
- [GitHub · pgvector/pgvector](https://github.com/pgvector/pgvector)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [与 MySQL 对比](/zh/ecosystem/comparison-with-mysql)
- [PostgreSQL 是什么](/zh/basics/what-is-postgresql)
- [分布式 Citus](/zh/ecosystem/citus)
- [容量与扩展上限](/zh/performance/capacity-and-scaling-limits)
- [citus](/zh/ecosystem/citus)
- [comparison-with-mysql](/zh/ecosystem/comparison-with-mysql)
- [index](/zh/ecosystem/index)
- [pgvector](/zh/ecosystem/pgvector)
- [timescaledb](/zh/ecosystem/timescaledb)