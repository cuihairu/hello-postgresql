# PostgreSQL 17 新特性摘要

PostgreSQL 17 于 2024 年 9 月 26 日发布。这是一个围绕「大规模数据运维」打磨的版本：vacuum 内存模型重写、原生的增量备份、物理备库一键转逻辑订阅者，再加上 `JSON_TABLE` 和 `MERGE` 的标准 SQL 补全。本页按类别整理对日常开发和运维影响较大的条目，完整列表见 [官方 release notes](https://www.postgresql.org/docs/release/17.0/)。

## vacuum 与内存管理

- **dead tuple 存储重构（TidStore）**：vacuum 收集死元组地址的内部结构换成基于基数树（radix tree）的 TidStore，同样内存下能容纳的 dead tuple 数量大幅增加，整体 vacuum 性能提升。
- **解除 1GB 隐式上限**：旧版本即使把 `maintenance_work_mem` / `autovacuum_work_mem` 设得再大，dead tuple 存储实际也只用约 1GB；PG 17 取消了这个限制，大表 vacuum 不再过早外溢到磁盘。
- **移除与冻结元组更高效**：vacuum 写出的 WAL 也更紧凑，`pg_stat_progress_vacuum` 新增索引进度列（`indexes_total` / `indexes_processed`），长时间 vacuum 终于能看到「卡在第几个索引」。
- **观测口径改名**：`max_dead_tuples` 改为 `max_dead_tuple_bytes`，以字节而非条数为口径。

对运维的直接意义：高更新/删除负载的库，autovacuum 调参空间更大、单轮 vacuum 时间更短，相关背景见 [vacuum 与 HOT](../internals/vacuum-and-hot) 与 [autovacuum 调优](../internals/autovacuum-tuning)。

## EXPLAIN 增强

- **`BUFFERS` 输出本地 I/O 计时**：`EXPLAIN (ANALYZE, BUFFERS)` 现在能区分 shared 与 local/temp 块的读写耗时，临时表和`$$`匿名块内建的本地缓冲终于可观测。
- **`MEMORY` 选项**：报告规划器消耗的内存。
- **`SERIALIZE` 选项**：估算把结果集序列化成网络格式的开销，判断「结果集太大导致慢」时有了直接证据。

```sql
EXPLAIN (ANALYZE, BUFFERS, MEMORY, SERIALIZE)
SELECT * FROM orders WHERE status = 'pending';
```

读计划的基础方法见 [EXPLAIN 入门](../performance/explain-basics) 与 [EXPLAIN (ANALYZE, BUFFERS)](../performance/explain-analyze-buffers)。

## MERGE 增强

PG 15 引入的 `MERGE` 在 17 版补齐了三个关键能力：

- **`RETURNING` 子句**：merge 语句可以返回它写入/修改的行，新函数 `merge_action()` 标明每行是由哪种动作产生的。
- **`WHEN NOT MATCHED BY SOURCE`**：目标表里有、源表里没有的行也能定义动作（典型用法是「同步库存：没有的就删掉」），此前要靠单独的 DELETE 语句补齐。
- **可更新视图**：MERGE 的目标可以是可更新视图。

```sql
MERGE INTO stock s
USING incoming i ON s.sku = i.sku
WHEN MATCHED THEN
    UPDATE SET qty = s.qty + i.qty
WHEN NOT MATCHED BY SOURCE THEN
    DELETE
WHEN NOT MATCHED THEN
    INSERT (sku, qty) VALUES (i.sku, i.qty)
RETURNING merge_action(), s.sku;
```

批量写入的更多模式见 [批量写入](../advanced-sql/batch-and-write)。

## 备份与恢复：原生增量备份

- **`pg_basebackup --incremental`**：以上一次全量备份的 `backup_label` 为基准，只备份发生变化的块级数据，大库的例行备份体积与时间都明显下降。
- **`pg_combinebackup`**：恢复时把全量与若干增量合并成一份可用的完整备份。
- **WAL 摘要（WAL summarization）**：服务端可选开启 `summarize_wal`，后台生成「某 LSN 区间内哪些块被改过」的摘要文件，供增量备份判定变化块；配套工具有 `pg_walsummary`，相关函数有 `pg_available_wal_summaries()` 等。

```bash
# 基于全量 /backup 做增量
pg_basebackup -D /backup/incr1 --incremental=/backup/backup_label -X stream

# 合并全量 + 增量得到可恢复副本
pg_combinebackup /backup /backup/incr1 -o /restore/full
```

注意：增量备份是 **PG 17 新增**，不是很多旧文章所说的 PG 16。备份体系全貌见 [备份策略](../operations/backup-strategy) 与 [物理备份与 PITR](../operations/physical-backup-and-pitr)。

## 复制

- **`pg_createsubscriber`**：把一台物理备库直接转换成逻辑订阅者，构造逻辑复制拓扑不再需要先建空库再全量导数据，迁移窗口可以压到分钟级。
- **逻辑槽故障转移**：`sync_replication_slots` 让物理备库同步主库上的逻辑槽，主库切换后逻辑订阅不断流；`synchronized_standby_slots` 可要求指定物理备库先收到 WAL 再向订阅者确认。
- **pg_upgrade 迁移逻辑槽**：升级后逻辑复制可以快速续传（要求旧集群本就是 PG 17+）。
- 订阅端支持 hash index 复制。相关运维操作见 [逻辑复制运维](../operations/logical-replication-ops)，双向逻辑复制的原理与限制见 [逻辑复制原理](../internals/logical-replication-internals)。

## SQL：JSON_TABLE 与标准 SQL/JSON

- **`JSON_TABLE()`**：把 JSON 文档按 SQL 标准展开成行集，直接放进 `FROM` 子句，配合 `NESTED PATH`、`ERROR ON ERROR` 等子句，替代了大部分手写 `jsonb_array_elements` + 强转的样板代码。
- **标准构造与查询函数**：`JSON()` / `JSON_SCALAR()` / `JSON_SERIALIZE()` 构造 JSON；`JSON_EXISTS()` / `JSON_QUERY()` / `JSON_VALUE()` 用 SQL/JSON 路径表达式查询。
- **jsonpath 类型转换方法**：`$.a.integer()`、`$.ts.timestamp_tz()` 等，取值时直接转换类型。

```sql
SELECT jt.*
FROM json_table(
    '[{"id":1,"tags":["a","b"]},{"id":2,"tags":["c"]}]',
    '$[*]' COLUMNS (
        id int PATH '$.id',
        NESTED PATH '$.tags[*]' COLUMNS (tag text PATH '$')
    )
) AS jt;
```

更多 JSONB 用法见 [JSONB 操作](../advanced-sql/jsonb-operations)。

## 约束与表定义

- **分区表支持排他约束（exclusion constraint）**：前提是分区键列用等值比较、其余列用排他比较，「房间预订时间段不重叠」这类约束终于能在分区表上落地，原理见 [范围类型与排他约束](../advanced-sql/range-types-and-exclude)。
- **分区表支持 identity 列**：分区表的主键可以统一用 `GENERATED ALWAYS AS IDENTITY`。
- **btree 多值检索**：对 `IN` 常量列表这类多值条件，btree 索引检索更高效。

## 其他值得关注的条目

- **`COPY ... ON_ERROR ignore`**：跳过格式错误的行继续导入，配合 `LOG_VERBOSITY` 打印被跳过的行，脏数据导入不用再拆文件。
- **流式 I/O**：`io_combine_limit` 让预读按更大块进行，全表扫描和 vacuum 的 I/O 效率提升。
- **`transaction_timeout`**：事务总时长超时中断，补齐 `statement_timeout` / `idle_in_transaction_session_timeout` 之外的一环，防长事务拖累 vacuum。
- **新视图**：`pg_stat_checkpointer`（checkpoint 统计）、`pg_wait_events`（等待事件字典）。
- **TLS**：`sslnegotiation=direct` 支持直接 ALPN 握手，跳过一次往返。
- **`random(min, max)`**：直接生成范围内随机数。

## 升级建议

从 PG 16 升级到 17 的常见动机：vacuum 内存重构（高写入负载库）、原生增量备份（大库备份）、`pg_createsubscriber` 与逻辑槽 failover（构建逻辑复制拓扑）、`JSON_TABLE`（重度 JSON 应用）。升级流程见 [版本升级](../operations/version-upgrade)。更新的版本特性请以官方 [release notes](https://www.postgresql.org/docs/release/) 为准。

## 相关页面

- [PostgreSQL 16 新特性摘要](./postgresql-16-features)
- [vacuum 与 HOT](../internals/vacuum-and-hot)
- [物理备份与 PITR](../operations/physical-backup-and-pitr)
- [版本升级](../operations/version-upgrade)
