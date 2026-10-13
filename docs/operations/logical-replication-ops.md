# 逻辑复制运维

逻辑复制按「表的行级变更」同步（INSERT/UPDATE/DELETE 作为逻辑事件传递），而不是照搬物理数据块。典型用途：滚动大版本升级、向下游数仓/缓存/审计库分发部分表、异构库迁移。发布/订阅模型与解码原理见 [逻辑复制内部原理](../internals/logical-replication-internals)，这一页讲建立、初始同步、DDL、冲突和监控的日常操作。

## 前置条件与账号

```plaintext
# 发布端（publisher）
wal_level = logical                        # 比 replica 多记录逻辑解码所需信息
max_wal_senders >= 订阅数 + 余量            # 默认 10
max_replication_slots >= 订阅数 + 余量       # 默认 10

# 订阅端（subscriber）
max_replication_workers >= 订阅数 + 初始同步余量   # 默认 4
max_sync_workers_per_subscription = 2            # 初始表同步的并行度，默认 2
```

发布端账号需要被发布表的 `SELECT` 权限（或直接用超级用户）；`CREATE PUBLICATION ... FOR ALL TABLES` 要求超级用户，指定表清单的 publication 由表 owner 创建即可。

## 建立 publication 与 subscription

发布端：

```sql
-- 表清单方式：只发布列出的表，后续新表要手动补
CREATE PUBLICATION pub_app FOR TABLE orders, order_items;

-- 全库方式：自动包含未来的新表（不含序列；DDL 依旧不同步）
CREATE PUBLICATION pub_all FOR ALL TABLES;

-- PG 15+ 支持行过滤与列清单
CREATE PUBLICATION pub_hot FOR TABLE orders WHERE (status = 'paid');

-- 后续增删表
ALTER PUBLICATION pub_app ADD TABLE customers;
ALTER PUBLICATION pub_app DROP TABLE order_items;
```

订阅端（先把表结构建好，见下文 DDL 一节）：

```sql
CREATE SUBSCRIPTION sub_app
  CONNECTION 'host=10.0.0.11 port=5432 dbname=appdb user=replicator password=...'
  PUBLICATION pub_app
  WITH (copy_data = true, create_slot = true);
```

`copy_data = true` 会先做全量初始同步；`create_slot = true` 在发布端自动建逻辑槽。每个订阅对应发布端一个逻辑复制槽。

## 初始数据同步与槽管理

初始同步按表进行：每个表由一个 tablesync worker 建临时槽、COPY 全量快照、再追上增量，之后并入常规 apply 流。并行度受 `max_sync_workers_per_subscription` 限制；大库首次同步期间，发布端要留意临时槽造成的 WAL 保留，订阅端留意磁盘与 IO。

```sql
-- 订阅端：各表同步状态（r=就绪, s=同步中, i=初始化中）
SELECT srrelid::regclass AS table_name, srsubstate
FROM pg_subscription_rel ORDER BY srsubstate, 1;

-- 订阅端：apply worker 是否在跑、最近收到的时间
SELECT subname, pid, received_lsn, last_msg_send_time, last_msg_receipt_time
FROM pg_stat_subscription;
```

无主键的表默认只能复制 INSERT，UPDATE/DELETE 会报错——除非发布端 `ALTER TABLE ... REPLICA IDENTITY FULL`（代价是把整行旧值写进 WAL）。建订阅前先检查每张表的主键。

## DDL 不同步：两端变更流程

逻辑复制只传行变更，所有 DDL 必须两端手工执行。以「加列」为例的安全顺序：

```sql
-- 第 1 步：订阅端先加列（带默认值；PG 11+ 非易变默认值不重写表）
ALTER TABLE orders ADD COLUMN channel text NOT NULL DEFAULT 'web';

-- 第 2 步：发布端再加列，此后的行事件开始携带新列值
ALTER TABLE orders ADD COLUMN channel text NOT NULL DEFAULT 'web';

-- 第 3 步：两端 \d orders 核对结构一致
```

订阅端先加列时，发布端旧格式的行事件不含新列，apply 时由订阅端补默认值，不会报错。反向的删列则先删发布端、再删订阅端。建议把这类两端有顺序依赖的变更写进迁移工具的发布脚本（见 [schema 迁移工具](../tools/schema-migration-tools)），而不是 DBA 手工记忆。

## 冲突处理：主键冲突的跳过与重做

典型冲突：订阅端已存在同主键行（重复初始化、双向写入、手工修数），apply 报 `duplicate key value violates unique constraint`，apply worker 停住，订阅端不再追新，发布端 WAL 随之堆积。处理流程：

```sql
-- 1. 订阅端暂停订阅
ALTER SUBSCRIPTION sub_app DISABLE;

-- 2. 处理冲突行：删掉多余行，或改成与上游一致的值
DELETE FROM orders WHERE id = 42;

-- 3. 跳过出错的 LSN（错误信息与日志里会给出 origin 名与具体 LSN；
--    origin 名形如 pg_<订阅OID>，也可查 pg_replication_origin 视图）
SELECT * FROM pg_replication_origin;
SELECT pg_replication_origin_advance('pg_16391', '0/2A1B3C8');

-- 4. 恢复订阅
ALTER SUBSCRIPTION sub_app ENABLE;
```

`pg_replication_origin_advance` 会跳过从该 LSN 起的一段变更，确认这段里没有其他需要的数据再执行。更稳妥的路线是先在测试环境重放该段数据核对影响面。区分场景：数据应以发布端为准就跳过本地行；本地数据不能被覆盖就先把上游行改掉再继续。

## 槽滞后监控与 max_slot_wal_keep_size

订阅停机、apply 报错卡住，都会让发布端的逻辑槽停住不动，`pg_wal` 无限增长——和物理槽一样是磁盘满的高发原因。

```sql
-- 发布端：逻辑槽滞后字节
SELECT slot_name, active, confirmed_flush_lsn,
       pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes
FROM pg_replication_slots WHERE slot_type = 'logical';

-- 订阅端：apply/sync 错误计数（PG 14+），非零即有冲突在堵
SELECT subname, apply_error_count, sync_error_count
FROM pg_stat_subscription_stats;
```

发布端设置 `max_slot_wal_keep_size`（PG 13+）给保留的 WAL 封顶：超限的槽会被标记失效，订阅需要重建（丢一段数据）。它是磁盘的保险丝，不是解决冲突的手段——告警要建在 `lag_bytes` 与 `apply_error_count` 上，让保险丝永远用不到。

## 大表加入 publication 的实践

- 直接对现有订阅扩表：`ALTER PUBLICATION ... ADD TABLE big_table` 后，在订阅端执行 `ALTER SUBSCRIPTION sub_app REFRESH PUBLICATION WITH (copy_data = true)`，新增表会被全量同步。同步期间 tablesync worker 占用资源，选低峰执行。
- **逐表控制**：对 TB 级大表，单独建一个 publication + subscription 专门同步它，初始同步完成、追平后再决定是否并入主订阅——避免一张大表阻塞其他表的初始同步排队。
- **分区表**：PG 13+ 可以把分区父表挂进 publication，各分区的变更随之发布；订阅端表结构按需决定是保留分区（默认）还是用 `publish_via_partition_root = true` 写入非分区表。老版本必须逐个分区列出，新建分区后记得补挂。
- 同步完成后做数据校验：行数 + 关键列抽样校验和，`lag = 0` 不代表数据一致。

## 注意事项与常见坑

- **表结构先行**：订阅端没建表就 `ADD TABLE`，apply 直接报 relation 不存在并卡住。
- **序列不同步**：`SEQUENCE` 不在逻辑复制范围内，迁移切换前手动 `setval` 对齐各序列。
- **大事务延迟尖峰**：发布端一个千万行的批量 `UPDATE`，要等整个事务提交后才会传出，apply 端表现为一次性大延迟；批量写改小批次，见 [批量写入优化](../advanced-sql/batch-and-write)。
- **`TRUNCATE` 会被复制**（PG 11+，publication 默认 `publish = 'insert, update, delete, truncate'`），下游为缓存/汇聚表时注意误清空。
- **双向写就是冲突制造机**：同一主键两端都能写，冲突会不断发生，PG 16 的 origin 支持只解决回环，不解决业务冲突。

## 参考资料

- [PostgreSQL 官方文档 · Chapter 25. Backup and Restore](https://www.postgresql.org/docs/current/backup.html)
- [PostgreSQL 官方文档 · Chapter 19. Server Configuration](https://www.postgresql.org/docs/current/runtime-config.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [逻辑复制内部原理](../internals/logical-replication-internals)
- [版本升级](./version-upgrade)
- [备份策略](./backup-strategy)
- [运维 SOP](./ops-sop)
- [fdw-and-foreign-data](/ecosystem/fdw-and-foreign-data.md)
- [postgresql-17-features](/ecosystem/postgresql-17-features.md)
- [logical-replication-internals](/internals/logical-replication-internals.md)
- [index](index.md)
- [version-upgrade](version-upgrade.md)