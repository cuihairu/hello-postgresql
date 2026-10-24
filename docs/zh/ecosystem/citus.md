# 分布式 Citus

Citus 是把 PostgreSQL 变成分布式集群的扩展：数据按分片键哈希打散到多台 worker，coordinator 负责存元数据与规划，查询可以整体路由到单节点或在多节点并行执行。它是扩展而非 fork，SQL 兼容性、驱动、工具链都保持原生形态。项目开源（Citus 11 起全部功能开源，AGPL 许可），源码见 [github.com/citusdata/citus](https://github.com/citusdata/citus)。

## coordinator 与 worker 架构

一个 Citus 集群由两类节点组成：

- **coordinator**：普通 PostgreSQL + citus 扩展，保存元数据（分片分布、节点列表），接收所有客户端连接，负责把 SQL 改写成针对分片的子查询、下发执行、汇总结果。DDL（建表、分表）也在这里发起。
- **worker**：持有分片数据的 PostgreSQL 节点。每个分片就是一个普通的 PG 表（分区形式），高可用靠 worker 本身的流复制，原理见 [流复制与同步](/zh/internals/streaming-replication-and-sync)。

所有流量经过 coordinator，因此 coordinator 的连接数与汇聚吞吐是集群上限之一（Citus 11 起支持对 coordinator 做只读切换等形态缓解）。

## 三种表：分布式表、引用表、本地表

```sql
CREATE EXTENSION citus;

-- 把 worker 纳入集群
SELECT citus_add_node('10.0.0.11', 5432);
SELECT citus_add_node('10.0.0.12', 5432);

-- 分布式表：按 tenant_id 哈希分片
SELECT create_distributed_table('orders', 'tenant_id', shard_count => 32);

-- 引用表：小维度表，全量复制到每个 worker
SELECT create_reference_table('countries');

-- 本地表：不参与分布，只存在于 coordinator
CREATE TABLE ops_log (id bigint GENERATED ALWAYS AS IDENTITY, msg text);
```

- **分布式表**：默认切成 32 个分片（`shard_count` 可调，建议取 worker 数的数倍以便再平衡），每个分片落在某台 worker 上。
- **引用表**：国家、币种、配置这类小表复制到所有 worker，让分布在任何节点的事务都能本地 JOIN 它、对它建外键。
- **本地表**：普通表留在 coordinator，适合体量小或仅运维使用的表。

## 共置（colocation）：join 与外键的关键

哈希分片把键空间切成固定数量的「桶」，分片键哈希值落在同一桶范围的表，其对应分片会放在同一台 worker 上——这就是共置。让租户相关的所有表按同一个键共置，可以带来三个直接收益：

- 共置表之间的 JOIN 在单节点内完成，不跨网络搬数据；
- 共置表之间可以建外键，引用完整性由本地约束保证；
- 带分片键的查询整体路由到单节点（见下一节），延迟与单机无异。

```sql
SELECT create_distributed_table('tenants',  'id');
SELECT create_distributed_table('orders',   'tenant_id', colocate_with => 'tenants');
SELECT create_distributed_table('payments', 'tenant_id', colocate_with => 'tenants');
```

限制也要记住：唯一约束和主键必须包含分片列（否则无法全局保证唯一）；不共置的分布式表之间不能直接建外键；跨分片查询走两阶段提交（`citus.multi_shard_commit_protocol = '2pc'`）保证原子性，但隔离级别与延迟不能按单机预期。

## 查询路由与分布式执行

```sql
-- 带 shard key：整条 SQL 路由到该租户所在的 worker，单机速度
SELECT * FROM orders WHERE tenant_id = 42 AND status = 'pending';

-- 不带 shard key：拆成每个分片一个子查询，并行执行后 coordinator 汇总
SELECT count(*) FROM orders WHERE created_at > now() - interval '1 day';

-- 共置表 JOIN：每个 worker 本地完成 JOIN，coordinator 只做汇总
SELECT t.name, count(*) FROM orders o JOIN tenants t ON t.id = o.tenant_id GROUP BY t.name;
```

`EXPLAIN` 输出里能看到 `Custom Scan (Citus ...)`，注明是 router 还是 multi-shard 计划——排查慢查询先看这一行，判断 SQL 有没有带上分片键。共置 join 的计划形态与 [join 实现算法](/zh/internals/join-implementations) 中的单机算法是两套路径，不能混用调参经验。

## 适用与不适用

适合上 Citus 的形态：

- **多租户 SaaS**：天然带 tenant_id，共置后每个租户就是一台机器上的「小库」，单租户路由查询、跨租户聚合两通吃，这是 Citus 最成熟的用法；
- **实时分析 / 高吞吐写入 OLAP**：事件、日志、指标按时间 + 键分布，多节点并行聚合；
- 单表已到 TB 级、单机写入确实打满，且业务能接受以分片键组织数据。

不适合的信号：

- 核心交易流是大量**跨分片的强事务 OLTP**（如全局唯一用户相互转账且无自然的分片键），两阶段提交的延迟与故障恢复复杂度会反噬业务；
- 数据量单机完全放得下——先做索引、参数与硬件优化，见 [选型问答](/zh/ecosystem/when-to-choose-postgresql)；
- 需要大量无分片键的全局点查，这类查询每个都要扫全部分片。

## 与原生分区的关系

Citus 的分片本质上就是「分区 + 放到别的机器」：分布式表在逻辑上是一张分区表，每个分片是一个物理分区，只是分区可以落在远程节点。因此两者概念可以叠加——常见做法是先按分片键哈希分布，分片内部再按时间范围分区，让时序数据的清理与归档仍按 [分区表设计](/zh/database-design/table-inheritance-and-partitioning-design) 的方式进行。理解了这一点，Citus 的 `citus_tables`、再平衡器（rebalancer）等元数据操作都不难映射回分区表的心智模型。

## Azure 现状

Citus Data 于 2019 年被微软收购，其托管服务 Azure Cosmos DB for PostgreSQL（前身 Hyperscale/Citus）已由微软宣布进入退役流程（计划 2029 年 3 月退役，不再推荐新项目采用）；Citus 本体仍持续开源维护，自托管或第三方托管不受影响。

## 参考资料

- [wiki.postgresql.org/wiki/Foreign_data_wrappers](https://wiki.postgresql.org/wiki/Foreign_data_wrappers)
- [GitHub · pgvector/pgvector](https://github.com/pgvector/pgvector)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [分区表设计](/zh/database-design/table-inheritance-and-partitioning-design)
- [流复制与同步](/zh/internals/streaming-replication-and-sync)
- [FDW 与外部数据](/zh/ecosystem/fdw-and-foreign-data)
- [选型问答](/zh/ecosystem/when-to-choose-postgresql)
- [index](/zh/ecosystem/index)
- [when-to-choose-postgresql](/zh/ecosystem/when-to-choose-postgresql)
- [capacity-and-scaling-limits](/zh/performance/capacity-and-scaling-limits)