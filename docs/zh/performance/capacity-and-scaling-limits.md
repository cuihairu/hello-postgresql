# 容量与扩展边界

PostgreSQL 的理论上限很高（单表 32TB、几十亿行的索引树高也只有 4~5 层），真正先到顶的往往是 WAL 带宽、checkpoint 节奏和连接内存这三件事。这里记录单机边界的估算方法，以及「读副本、分区、分片」各自的适用时机——扩容手段的顺序选对了，多数场景不需要走到分片。

## 单机写边界：WAL 带宽与 checkpoint

每笔提交至少一次 WAL 刷盘，所以**持续写吞吐的上限 ≈ WAL 设备的 fsync 带宽 ÷ 每行数据的 WAL 字节数**。行 WAL 含索引维护和页开销，宽表多索引的行 WAL 放大明显。组提交（并发下自动发生，也可用 `commit_delay` 调）能摊薄 fsync 次数，但摊不掉 WAL 字节数本身。

第二条约束是 checkpoint：持续写入每产生 `max_wal_size` 量的 WAL 就触发一次 checkpoint，全量脏页集中刷盘，写高峰的 p95 抖动多来自这里。把两者放一起观测：

```sql
-- WAL 字节速率（PG 14+）：两次快照相除
SELECT wal_bytes FROM pg_stat_wal;

-- 主动触发的 checkpoint（req 多说明 max_wal_size 偏小）
SELECT checkpoints_timed, checkpoints_req FROM pg_stat_bgwriter;
-- PG 17 起：
SELECT num_timed, num_requested FROM pg_stat_checkpointer;
```

判定信号：`checkpoints_req` 占比高、WAL 速率贴近磁盘顺序写带宽、写高峰延迟与 checkpoint 时间点重合——这是在往单机写边界走。压测验证手法见[基准工具](/zh/performance/benchmark-tools)，WAL 机制见 [WAL 机制](/zh/internals/wal-mechanism)。

## 连接数与内存上限的算术

每个连接是一个独立进程：基础内存几 MB，加上执行中每个排序/哈希节点一份 `work_mem`，再加临时对象。最坏情况的算式：

```plaintext
内存上限 ≈ max_connections × (基础内存 + work_mem × 平均排序节点数)
```

例：500 连接 × (5MB + 64MB × 2) ≈ 67GB——一台 64GB 内存机器理论上限就击穿了，而业务高峰真的会把「最坏」变成「平均」。工程上的结论：

- **活动连接数控制在核数的 2~4 倍**，其余请求在应用侧或连接池里排队；
- 连接数是需求不是容量，用 pgbouncer 之类的事务级池化收敛，见[连接与 ORM 优化](/zh/performance/connection-and-orm-optimization)；
- max_connections 与 work_mem 必须一起评估，单独把任何一个给大都是 OOM 陷阱。

## 表大小的界限

官方给的理论上限（<https://www.postgresql.org/docs/current/limits.html>）：

- 单表最大 32TB（块号 32 位 × 8KB 页）；
- 单行最大约 1.6TB（大值走 TOAST），列数最多 1600；
- B-tree 索引每层扇出几百，几十亿行的索引树高也只有 4~5 层——点查不会因为表大而多跳几层，这不是瓶颈。

先到顶的是**运维时间**而非引擎能力：一次全表 VACUUM 要几小时、REINDEX 锁多久、备份恢复要多久、误删一列要改多久。实践结论：单表到几百 GB、行数到十亿级还能正常伺候；当维护窗口和膨胀治理开始吃掉工程时间，就该按时间或租户做分区，见[表的继承与分区设计](/zh/database-design/table-inheritance-and-partitioning-design)。

## 什么时候上读副本、分区、分片

按瓶颈类型对号入座，成本从低到高：

- **读吞吐不够** → 流复制读副本分摊读流量（注意复制延迟对「写后读」的影响），见[高可用架构](/zh/operations/high-availability-architecture)；
- **单表太大、维护痛苦、旧数据冷** → 声明式分区，查询带分区键就能裁剪，见[分区裁剪与裁剪失败](/zh/performance/partition-pruning)；
- **写吞吐真到单机 WAL 上限** → 写分片，按分片键把数据拆到多机。Citus 是这条路的标准答案：把 PG 表按分布列切成多节点并行处理的扩展，见 [Citus](/zh/ecosystem/citus)。

## 什么时候该换方案，而不是扩库

分片是重决策：跨分片事务、二次分片、跨片 join 的复杂度会长期跟着团队。动手前先排除「假写瓶颈」：

- pg_stat_statements 里的 top 写查询是不是该批量（见[写入吞吐优化](/zh/performance/write-throughput-optimization)）、该减索引？
- 高频小事务能不能用队列削峰、异步落库？
- 热点读能不能用缓存卸载？
- 瓶颈是锁排队（热点行）而不是 IO？那是应用设计问题，加机器无效。

判定顺序建议：pg_stat_statements 确认热点 → SQL 与索引优化 → 缓存与队列卸载 → 读写分离 → 分区 → 最后才是写分片。多数业务走到「读写分离 + 分区」就够了。

## 容量规划清单

定期（或在大促/新业务前）过一遍：

```plaintext
- 每小时 WAL 生成量（pg_stat_wal 差分）与 WAL 磁盘剩余空间；
- 复制槽滞留的磁盘兜底：max_slot_wal_keep_size 是否设置；
- 表与索引的年增长预估，对应一次 VACUUM / REINDEX 的时长；
- 内存上限算式重算：max_connections × (基础 + work_mem × 节点数)；
- 活动连接目标数与池化方案；
- 备份与恢复时长按目标容量实测演练，而不是估;
- p95 延迟余量：当前高峰延迟 ÷ 目标利用率，留出至少 2 倍余量。
```

## 参考资料

- [PostgreSQL 官方文档 · Appendix K. PostgreSQL Limits](https://www.postgresql.org/docs/current/limits.html)
- [PostgreSQL 官方文档 · 14.1. Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [pgvector](/zh/ecosystem/pgvector)
- [when-to-choose-postgresql](/zh/ecosystem/when-to-choose-postgresql)
- [checkpoint-and-buffer](/zh/internals/checkpoint-and-buffer)
- [connection-and-orm-optimization](/zh/performance/connection-and-orm-optimization)
- [index](/zh/performance/index)- [写入吞吐优化](/zh/performance/write-throughput-optimization)——到顶之前先榨单机写能力。
- [连接与 ORM 优化](/zh/performance/connection-and-orm-optimization)——连接数算术的工程落地。
- [表的继承与分区设计](/zh/database-design/table-inheritance-and-partitioning-design)——大表拆分的第一个台阶。
- [Citus](/zh/ecosystem/citus)——真到写分片时的方案参考。

官方文档：<https://www.postgresql.org/docs/current/limits.html>
