# 术语表

中英对照术语速查，按主题分组。每个术语给一句话定位；个别核心概念在其后附展开说明。遇到陌生词先查这里，需要原理细节再进对应章节。附录导航见[附录总览](/appendix/)。（2026-10-14 批：四组术语表各补一行可点出处，均为 PostgreSQL 官方文档实测页面，链接全部经实测可达后再写入。）

## MVCC、WAL、VACUUM、事务与锁

> 出处：PostgreSQL 官方文档：[并发控制（MVCC）](https://www.postgresql.org/docs/current/mvcc.html) · [事务隔离级别](https://www.postgresql.org/docs/current/transaction-iso.html) · [例行清理（VACUUM）](https://www.postgresql.org/docs/current/routine-vacuuming.html) · [预写日志（WAL）](https://www.postgresql.org/docs/current/wal.html) · [显式锁](https://www.postgresql.org/docs/current/explicit-locking.html)


| 术语 | 英文 | 一句话解释 |
| --- | --- | --- |
| 多版本并发控制 | MVCC (Multi-Version Concurrency Control) | 保留行的多个历史版本实现读写互不阻塞的并发机制。 |
| 快照 | Snapshot | 事务判断"哪些行版本对我可见"的依据，在语句或事务开始时确定。 |
| 事务 ID | XID (Transaction ID) | 写事务拿到的编号，存进行头，用于多版本可见性比较。 |
| xmin / xmax | xmin / xmax | 行版本头部两个字段：创建该版本的事务 ID、删除或更新它的事务 ID。 |
| 死元组 | Dead Tuple | 被更新或删除后对所有事务都不可见的行版本，等待 VACUUM 回收。 |
| 预写日志 | WAL (Write-Ahead Log) | 先把变更顺序写入日志再写数据页，支撑崩溃恢复与复制。 |
| 日志序列号 | LSN (Log Sequence Number) | WAL 流中的字节位置，恢复、复制进度都以它为坐标。 |
| 检查点 | Checkpoint | 周期性把脏页刷回数据文件并记下恢复起点，缩短崩溃后重放时间。 |
| 全页写 | Full Page Write | checkpoint 后首次修改某页时把整页写进 WAL，防部分写损坏。 |
| 清理 | VACUUM | 回收死元组空间、维护可见性映射的维护操作。 |
| 自动清理 | Autovacuum | 按表的死元组阈值自动触发 VACUUM 和 ANALYZE 的后台进程组。 |
| 表膨胀 | Table Bloat | 死元组与历史版本堆积，表和索引远大于实际数据量的现象。 |
| 冻结 | Freeze | 把行的 XID 替换为特殊值，使其不再参与新旧比较。 |
| 事务 ID 回卷 | XID Wraparound | XID 用尽导致新旧判断失序的风险，靠及时冻结避免数据丢失。 |
| HOT 更新 | HOT (Heap-Only Tuple) Update | 更新列不涉及索引且新旧版本同页时，索引无需更新的优化路径。 |
| 隔离级别 | Isolation Level | 并发事务相互可见程度：读已提交、可重复读、可串行化。 |
| 死锁 | Deadlock | 多个事务互相等待对方持锁，被检测到后强制回滚其中一个。 |

### MVCC

写操作不原地覆盖旧行，而是写入新版本、把旧行标记为过期。读按快照选取对自己可见的版本，于是读不上写阻塞、写也不上读阻塞。代价是死元组会持续产生，必须靠 VACUUM 回收。这也是 PostgreSQL 与 MySQL InnoDB（undo log 方案）实现思路的主要差异点。

### WAL

事务提交前，变更必须先落到 WAL 并按设置刷盘，数据页可以晚一点写。崩溃恢复时从上次 checkpoint 起重放 WAL 即可还原一致状态。备库复制本质上是把同一份 WAL 流发给另一台机器重放。

### VACUUM 与表膨胀

UPDATE 和 DELETE 不会立即释放空间，而是留下死元组。VACUUM 把这些空间标记为可复用（一般不还给操作系统），ANALYZE 顺带更新统计信息。autovacuum 长期落后时会看到表膨胀和查询变慢，详见站内清理章节。

## 索引与查询执行

> 出处：PostgreSQL 官方文档：[索引概览](https://www.postgresql.org/docs/current/indexes.html) · [索引类型](https://www.postgresql.org/docs/current/indexes-types.html) · [操作符类与操作符族](https://www.postgresql.org/docs/current/indexes-opclass.html) · [阅读执行计划（EXPLAIN）](https://www.postgresql.org/docs/current/using-explain.html)


| 术语 | 英文 | 一句话解释 |
| --- | --- | --- |
| B 树索引 | B-tree | 默认索引类型，支持等值与范围条件，多路平衡树结构。 |
| GIN 索引 | GIN (Generalized Inverted Index) | 倒排索引，适合数组、jsonb、全文检索这类"包含"查询。 |
| GiST 索引 | GiST (Generalized Search Tree) | 通用搜索树框架，常用于地理、范围类型与近邻排序。 |
| BRIN 索引 | BRIN (Block Range Index) | 按块区间记录极值，体积极小，适合物理顺序与业务顺序一致的大表。 |
| 覆盖索引 | Covering Index | 索引包含查询全部所需列，无需回表取数据。 |
| 部分索引 | Partial Index | 只对满足 WHERE 条件的行建索引，减小体积与维护成本。 |
| 表达式索引 | Expression Index | 对函数或表达式结果建索引，如 `lower(email)`。 |
| 执行计划 | Query Plan | 优化器为一条 SQL 选定的算子组合与访问路径，用 EXPLAIN 查看。 |
| 顺序扫描 | Sequential Scan (Seq Scan) | 从头到尾读整表；大表频繁出现通常意味着缺索引或统计失真。 |
| 索引扫描 | Index Scan | 索引定位行后回表取其余列。 |
| 仅索引扫描 | Index Only Scan | 所需列全部在索引中且页面可见性确认后，完全不回表。 |
| 位图扫描 | Bitmap Scan | 先由索引生成位图，再按物理顺序回表，介于顺序与索引扫描之间。 |
| 选择性 | Selectivity | 条件过滤后剩余行占比，决定优化器是否走索引。 |
| 统计信息 | Statistics | ANALYZE 采样的数据分布概况，是代价估算的输入。 |
| 连接算法 | Join Method | Nested Loop、Hash Join、Merge Join 三种物理实现。 |

### 仅索引扫描

PostgreSQL 的索引不存行版本信息，所以仅索引扫描还要确认行对当前快照可见。这个确认依赖可见性映射：页面被标记为"全部可见"时才可跳过回表。因此仅索引扫描的收益高度依赖 VACUUM 是否及时。

## 复制与高可用

> 出处：PostgreSQL 官方文档：[流复制与同步复制（warm-standby）](https://www.postgresql.org/docs/current/warm-standby.html) · [WAL 归档与持续归档](https://www.postgresql.org/docs/current/continuous-archiving.html) · [逻辑解码与逻辑复制](https://www.postgresql.org/docs/current/logicaldecoding.html) · [监控统计](https://www.postgresql.org/docs/current/monitoring-stats.html)


| 术语 | 英文 | 一句话解释 |
| --- | --- | --- |
| 流复制 | Streaming Replication | 主库把 WAL 实时发送给备库重放的物理复制方式。 |
| 主库 / 备库 | Primary / Standby | 承担写入的实例，与持续重放 WAL 保持同步的副本。 |
| 热备 | Hot Standby | 备库在重放 WAL 的同时接受只读查询。 |
| 同步复制 | Synchronous Replication | 等待备库确认收到 WAL 后才向客户端返回提交成功。 |
| 异步复制 | Asynchronous Replication | 主库提交不等待备库，故障切换时可能丢最近少量事务。 |
| 复制槽 | Replication Slot | 在备库落后期间阻止主库丢弃其仍需要的 WAL 的锚点。 |
| WAL 归档 | WAL Archiving | 把写满的 WAL 段保存到归档存储，用于时点恢复。 |
| 备库延迟 | Replication Lag | 备库落后主库的 WAL 字节量或重放时间差。 |
| 故障切换 | Failover | 主库故障后把备库提升为新主库的过程。 |
| 提升 | Promote | 备库结束重放、转为可写主库的动作。 |
| RPO / RTO | Recovery Point / Time Objective | 最多能容忍丢失的数据量，与最长能容忍的服务中断时间。 |

## 对象与权限

> 出处：PostgreSQL 官方文档：[实例、数据库与 schema](https://www.postgresql.org/docs/current/ddl-schemas.html) · [角色](https://www.postgresql.org/docs/current/database-roles.html) · [权限管理（GRANT/REVOKE）](https://www.postgresql.org/docs/current/ddl-priv.html) · [行级安全 RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)


| 术语 | 英文 | 一句话解释 |
| --- | --- | --- |
| 实例 | Instance / Cluster | 一个 PostgreSQL 服务进程与共享内存的整体，管理多个数据库；注意不是分布式集群。 |
| 数据库 | Database | 实例内的独立命名空间，连接以库为单位，库之间不能直接跨库查询。 |
| 模式 | Schema | 库内的命名空间，容纳表、视图、函数等对象，默认查找路径为 `"$user", public`。 |
| 表空间 | Tablespace | 指定数据库对象数据文件在文件系统上的存放目录。 |
| 序列 | Sequence | 生成单调递增数值的对象，serial 与 identity 列底层都靠它。 |
| 扩展 | Extension | 打包安装的附加功能模块，如 pg_stat_statements、PostGIS。 |
| 角色 | Role | PostgreSQL 统一的权限载体，带 LOGIN 属性的角色即通常所说的用户。 |
| 权限 | Privilege | 对象上的操作许可（SELECT、INSERT 等），由 GRANT/REVOKE 管理。 |
| 所有权 | Ownership | 创建对象的角色即 owner，天然拥有该对象全部权限并可转授。 |
| 接入控制 | pg_hba.conf | 按"来源主机 + 用户 + 数据库 + 认证方式"决定能否建立连接的配置文件。 |

### 实例、数据库与 schema 的层级

一台机器上的一个 PostgreSQL 服务是一个实例（官方文档也称 cluster）。实例里建多个数据库，库与库之间隔离。每个库里再分多个 schema，schema 下才是表、视图、函数等对象。日常说的"连库、找表"，完整路径是：实例 → 数据库 → schema → 对象。

<!-- BACKLINKS-AUTO -->
## 相关页面

- [MVCC 与多版本实现](../internals/mvcc-and-multi-version)
- [WAL 机制](../internals/wal-mechanism)
- [VACUUM 与 HOT 更新](../internals/vacuum-and-hot)
- [锁系统](../internals/lock-system)
- [PostgreSQL 是什么](../basics/what-is-postgresql)
- [index](index.md)
- [references-and-docs](references-and-docs.md)
- [sql-command-reference](sql-command-reference.md)