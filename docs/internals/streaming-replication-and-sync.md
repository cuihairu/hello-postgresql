# 流复制与同步

流复制（物理复制）把主库生成的 WAL 记录几乎实时地流式传输到备库，备库重放同样的物理变更，得到一份字节级一致的副本。9.0 引入流式传输、9.1 引入同步复制。这一页讲清传输链路上的进程分工、`synchronous_commit` 的强度频谱、半同步的降级风险，以及备库可读时的冲突处理。

## 进程与传输链路

- 主库端：每个流复制连接对应一个 **walsender** 进程，从 WAL 缓冲/文件里读记录发给对端。
- 备库端：**walreceiver** 进程主动连主库（连接串在 `primary_conninfo`，通常由 `pg_basebackup` 生成的配置带上），收到的 WAL 先落盘到本地 `pg_wal`；**startup** 进程再重放（replay）。
- walreceiver 按 `wal_receiver_status_interval`（默认 10s）向上游回报接收/落盘/重放进度，这就是主库侧延迟视图的数据来源。
- 备库还可以级联：下层备库连上层备库，减轻主库扇出压力。

搭建步骤（含 `pg_basebackup` 与 `primary_conninfo` 配置）见[流复制搭建](../operations/streaming-replication-setup)。

## synchronous_commit 的强度频谱

`synchronous_commit` 决定"commit 返回给客户端前，WAL 必须落到哪一步"。它是会话级参数，可以按业务差异化设置：

| 取值 | 本地 WAL | 备库收到并写入 OS | 备库 fsync | 备库重放（可查） | 断电丢数据风险 |
| --- | --- | --- | --- | --- | --- |
| `off` | 异步 | 不等 | 不等 | 不等 | 主库崩溃可能丢最近事务 |
| `local` | fsync 完即返回 | 不等 | 不等 | 不等 | 主库安全，备库可能滞后丢 |
| `remote_write` | 等 | 等 | 不等 | 不等 | 备库机器掉电可能丢 |
| `on`（默认） | 等 | 等 | 等 | 不等 | 同步复制标准语义 |
| `remote_apply` | 等 | 等 | 等 | 等 | 读-your-writes，延迟最大 |

`on` 保证提交过的数据在至少一个备库的磁盘上；`remote_apply` 进一步保证备库上**已经可查**——用它实现"写完立刻在备库读到"的读写分离。

## synchronous_standby_names 与同步候选

`synchronous_standby_names` 指定哪些备库参与同步确认，按备库的 `application_name`（来自其 `primary_conninfo`）匹配：

```sql
-- 优先级模式：第一个可用者作为同步备库，第二个是候选
synchronous_standby_names = 'FIRST 1 (standby_a, standby_b)';

-- 法定人数模式：两个备库里任意 1 个确认即提交
synchronous_standby_names = 'ANY 1 (standby_a, standby_b)';
```

每个备库在主库 `pg_stat_replication` 里有一行，`sync_state` 显示它在当前策略下的角色：`sync`（正在确认）/ `quorum` / `potential`（候选）/ `async`。

## 半同步降级风险

这是流复制最重要的一条运行纪律：**`synchronous_commit = on/remote_apply` 时，如果没有任何满足条件的同步备库，主库的写事务 commit 会一直阻塞等待**，PostgreSQL 没有内置超时，也不会自动退回异步。备库宕机意味着主库"写不进去"，直到备库回来或管理员动手：

```sql
-- 应急：清空同步名单并 reload（不重启）
ALTER SYSTEM SET synchronous_standby_names = '';
SELECT pg_reload_conf();
-- 或者只对当前会话绕过：SET synchronous_commit = 'local';
```

生产上的预防姿势：同步候选至少配两个（`FIRST 1 (a, b)` 或 `ANY 1 (a, b)`），并把 `sync_state` 长期不等于 `sync/quorum` 作为告警项。等待期间已经提交的事务是安全的，风险只是新的提交在排队。

## replay 延迟观测

主库侧看每个 walsender 的进度与耗时：

```sql
SELECT application_name, sync_state,
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS replay_lag_bytes,
       write_lag, flush_lag, replay_lag
FROM pg_stat_replication;
```

注意 `write_lag/flush_lag/replay_lag`（PG 10+）只在有新流量时刷新，实例空闲后可能停在旧值甚至为 NULL，判断"现在滞后多少"要以 `replay_lsn` 与 `pg_current_wal_lsn()` 的字节差为准。

备库侧自查：

```sql
SELECT pg_is_in_recovery() AS in_recovery,
       pg_last_wal_receive_lsn() AS received,
       pg_last_wal_replay_lsn()  AS replayed,
       pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()) AS not_yet_replayed,
       now() - pg_last_xact_replay_timestamp() AS replay_delay;
```

## 热备查询与冲突

`hot_standby = on` 时备库可接受只读查询，但重放与查询共享同一份数据：主库 VACUUM 清理掉的行，备库上可能还有查询正拿着旧快照在读。这时重放有两种选择——等查询，或取消它：

- `max_standby_streaming_delay`（默认 30s）：重放最多为查询让路这么久，超时后取消冲突的备库查询，客户端收到 `canceling statement due to conflict with recovery`。设成 `-1` 表示永远等（重放滞后无限增长）。
- `hot_standby_feedback = on`：备库把最小事务快照回报给主库，主库 VACUUM 就不会清理备库还在用的行——冲突大幅减少，代价是主库死元组堆积（膨胀），大查询频繁的库要权衡。
- 长时间重放等待还可能触发锁类冲突（如主库 `DROP TABLE` 取 `AccessExclusiveLock`）。备库侧按类型分桶的统计在 `pg_stat_database_conflicts`。

## 注意事项与常见坑

- 同步复制的"安全"以备库配置为前提：备库如果 `synchronous_commit=off` 只影响它自己作为主库时的行为，确认语义看的是确认方是否 fsync，别把参数复制错了方向。
- `remote_apply` 事务延迟明显，只给真正需要读-your-writes 的会话开，别全库设置。
- 重放延迟的告警要用字节差（`pg_wal_lsn_diff`）而非时间字段，理由见上文 lag 字段的刷新语义。
- 主备切换后的重新接线、同步候选与 HA 编排的关系见[高可用架构](../operations/high-availability-architecture)。

## 相关页面

- [WAL 机制](./wal-mechanism)——被传输的到底是什么。
- [流复制搭建](../operations/streaming-replication-setup)——从零建一套主备。
- [高可用架构](../operations/high-availability-architecture)——切换与选主。
- [锁冲突排查](./lock-conflict-troubleshooting)——另一种"卡住"的排查方法。

官方文档：<https://www.postgresql.org/docs/current/warm-standby.html#STREAMING-REPLICATION> 与 <https://www.postgresql.org/docs/current/runtime-config-replication.html>
