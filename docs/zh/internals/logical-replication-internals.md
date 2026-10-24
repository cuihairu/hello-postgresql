# 逻辑复制底层

逻辑复制把主库的变更以**行级事件**（INSERT/UPDATE/DELETE/TRUNCATE）的形式发给订阅端，而不是像流复制那样传输物理数据块。中间的桥梁是 WAL 逻辑解码：从 WAL 里还原出"哪个事务改了哪一行"。理解这条链路上的 wal_level、复制槽、publication/subscription 三层，才能预判它的开销与故障模式。与流复制的分工对比见[流复制与同步](/zh/internals/streaming-replication-and-sync)。

## wal_level=logical 的开销

逻辑解码需要 WAL 里保留比崩溃恢复更多的信息（比如 UPDATE/DELETE 的复制身份列前像），所以发布库必须设 `wal_level = logical` 并重启：

- 即使一个复制槽都没建，logical 档产生的 WAL 也比默认的 `replica` 档多，写密集实例的 WAL 体积与归档压力可感知。
- 解码本身发生在主库的 walsender 进程里，大事务、高变更速率会吃主库 CPU。

确认当前状态：

```sql
SHOW wal_level;
```

## 逻辑解码与复制槽

链路是：walsender 读 WAL → 按事务重排进 reorder buffer → **commit 时才解码输出** → output plugin 编码。订阅端使用的内置插件是 `pgoutput`；调试时可以自己建一个逻辑槽用 `test_decoding` 直接看解码结果：

```sql
-- 主库：建一个逻辑槽并查看解码输出（test_decoding 属于 contrib）
SELECT pg_create_logical_replication_slot('demo', 'test_decoding');

INSERT INTO orders (status) VALUES ('pending');
SELECT * FROM pg_logical_slot_get_changes('demo', NULL, NULL);
-- 输出形如 table public.orders: INSERT: id[bigint]:1 status[text]:'pending'

SELECT pg_drop_replication_slot('demo');
```

复制槽是这套机制里最需要敬畏的对象：槽记录消费进度（`confirmed_flush_lsn`），主库**必须保留槽之后的所有 WAL**。订阅端停机或消费卡住，主库 `pg_wal` 就一直涨，直到磁盘写满——这是逻辑复制最典型的事故。`max_slot_wal_keep_size`（PG 13+）可以限制保留量，超限后槽被标记为 `fail`，需要重建槽并重新同步。PG 17 起还支持把逻辑槽同步到物理备库（failover slot），主备切换后订阅不断流。

```sql
-- 槽滞后多少：两个 LSN 的差值换算成字节
SELECT slot_name, active, restart_lsn, confirmed_flush_lsn,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS retained_wal
FROM pg_replication_slots
WHERE slot_type = 'logical';
```

## publication / subscription 模型

- 发布端：`CREATE PUBLICATION`，指定表或 `ALL TABLES`；PG 15 起支持行过滤（`WHERE`）与列清单。
- 订阅端：`CREATE SUBSCRIPTION ... CONNECTION '...' PUBLICATION ...`，实际起一个 apply worker 常驻接收并应用变更。
- **初始表同步**：`copy_data = true`（默认）时，订阅先对每张发布表做一次 COPY 全量拷贝（由 `max_sync_workers_per_subscription`，默认 2，并行执行），追平后进入流式增量。大表首次同步对主库压力可观，要挑窗口。

```sql
-- 发布端
CREATE PUBLICATION orders_pub FOR TABLE orders;

-- 订阅端
CREATE SUBSCRIPTION orders_sub
  CONNECTION 'host=primary dbname=app user=repl'
  PUBLICATION orders_pub;
```

## 复制身份 REPLICA IDENTITY

订阅端要在自己的表上定位"被改的那一行"来执行 UPDATE/DELETE，依据是发布表的复制身份：

| 设置 | 行为 |
| --- | --- |
| `DEFAULT`（默认） | 用主键；无主键等于 NOTHING |
| `FULL` | 旧行全列进 WAL；WAL 体积涨，且订阅端靠全列匹配找行，慢 |
| `USING INDEX idx` | 用指定的唯一非部分索引，比 FULL 省 WAL，定位快 |
| `NOTHING` | UPDATE/DELETE 无法发到订阅端（报错） |

无主键表要发布 UPDATE/DELETE，必须显式改复制身份，否则第一次删除就报错：

```sql
ALTER TABLE orders REPLICA IDENTITY USING INDEX orders_status_idx;
```

## 明确不复制的东西

- **DDL 不复制**：主库加列、改类型，订阅端不会跟着变，结构漂移是逻辑复制最常见的故障源；流程上要先把订阅端 DDL 补齐再上发布端变更。
- **序列不复制**：切换时订阅端的 `id` 序列值要手动 `setval` 对齐，否则切换后第一个插入就主键冲突。
- 大对象、视图、物化视图不在 publication 范围内。`TRUNCATE` 会复制（PG 11+）。

## 大事务与长事务的影响

解码按 commit 顺序输出、只有提交了的事务才可见，于是：

- 一个**开几个小时的长事务**，其后的所有事务都要在 reorder buffer 里等它，槽的 `restart_lsn` 不前进 → WAL 持续堆积，等价于消费停滞。
- 超大事务的变更在 buffer 里攒着，超过 `logical_decoding_work_mem`（PG 13+，默认 64MB）就 spill 到磁盘，主库临时空间与解码时间都涨。
- 应用侧对策：全表 UPDATE/批量迁移拆小事务，避免在挂着订阅的库上跑小时级大事务。

槽级发送与溢出统计在 PG 14+ 的 `pg_stat_replication_slots`（`spill_txns`/`spill_bytes`）里能直接看到。

## 观测与应用场景

```sql
-- 发布端：订阅消费进度与滞后
SELECT application_name, state, sent_lsn, write_lsn, flush_lsn, replay_lsn
FROM pg_stat_replication;

-- 订阅端：apply worker 是否活着、错误计数（PG 15+）
SELECT subid, subname, received_lsn, latest_end_time FROM pg_stat_subscription;
SELECT subname, apply_error_count FROM pg_stat_subscription_stats;
```

典型应用：**跨版本升级**——流复制要求主版本一致，而逻辑复制可以从 16 复制到 17，是 `pg_upgrade` 之外的在线升级路径（见[版本升级](/zh/operations/version-upgrade)）；此外还有 CDC 供下游、双写切流等。运维操作面（监控告警、重建槽、重同步）见[逻辑复制运维](/zh/operations/logical-replication-ops)。

## 注意事项与常见坑

- 建槽不消费 = 定时炸弹，监控必须覆盖 `pg_replication_slots` 的 retained WAL（脚本见[监控与告警](/zh/operations/monitoring-and-alerting)）。
- 复制身份改 FULL 会放大主库 WAL，先在测试环境量一下增量再上生产。
- 订阅端 apply 是单 worker 顺序回放，订阅端吞吐上限取决于最重的那张表，写入热点表不适合指望逻辑复制线性扩写。

## 参考资料

- [PostgreSQL 官方文档 · Chapter 29. Logical Replication](https://www.postgresql.org/docs/current/logical-replication.html)
- [PostgreSQL 官方文档 · Chapter 47. Logical Decoding](https://www.postgresql.org/docs/current/logicaldecoding.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [postgresql-16-features](/zh/ecosystem/postgresql-16-features)
- [postgresql-17-features](/zh/ecosystem/postgresql-17-features)
- [index](/zh/internals/index)
- [knowledge](/zh/knowledge)
- [logical-replication-ops](/zh/operations/logical-replication-ops)- [WAL 机制](/zh/internals/wal-mechanism)——被解码的原始日志。
- [流复制与同步](/zh/internals/streaming-replication-and-sync)——物理复制如何分工。
- [逻辑复制运维](/zh/operations/logical-replication-ops)——搭建与排障的操作手册。
- [版本升级](/zh/operations/version-upgrade)——逻辑复制跨版本升级的完整流程。

官方文档：<https://www.postgresql.org/docs/current/logical-replication.html> 与 <https://www.postgresql.org/docs/current/logicaldecoding.html>
