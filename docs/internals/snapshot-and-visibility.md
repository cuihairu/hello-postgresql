# 快照与可见性判定

MVCC 的每一次查询都在回答同一个问题：这行数据的哪个版本对当前事务可见？答案由两样东西决定——查询开始时取的**快照**，以及每个元组头里的 xmin/xmax。这一页拆开快照的结构、事务状态文件 pg_xact 的四种状态、可见性判定的完整步骤，以及冻结与 xid 回卷的风险边界。元组结构本身见 [MVCC 与多版本](./mvcc-and-multi-version)。

## 快照里有什么：xmin / xmax / xip_list

一个快照本质上是三个数字：

- **xmin**：快照创建时仍在运行的最早事务 id。所有小于 xmin 的事务，在快照创建时已经提交或回滚完毕。
- **xmax**：快照创建时的"下一个待分配事务 id"。所有大于等于 xmax 的事务还没开始，必然不可见。
- **xip_list**：快照创建时仍处于运行中的 xid 列表，只包含 [xmin, xmax) 区间内的。

PG 13+ 可以直接观察：

```sql
-- 会话 A：开一个不提交的事务，占住一个 xid
BEGIN;
SELECT txid_current();          -- 例：105

-- 会话 B：查看当前快照
SELECT pg_current_snapshot();   -- 例：100:105:100,102
COMMIT;
```

`100:105:100,102` 读法：xmin=100、xmax=105；xid 100 和 102 还在运行，101/103/104 已提交，105 及之后尚未提交。所以 101/103/104 的修改对本快照可见，100/102/105（含）之后不可见。旧版本用 `txid_current_snapshot()`，输出格式相同。

## pg_xact（clog）与事务四种状态

可见性判定要回答"xmin 提交了吗"，答案存在 pg_xact 目录（PG 10 前叫 pg_clog）：每个事务只占 2 个 bit，四种状态：

| 状态 | 含义 |
| --- | --- |
| IN_PROGRESS | 事务运行中 |
| COMMITTED | 已提交 |
| ABORTED | 已回滚 |
| SUB_COMMITTED | 子事务已提交，但顶层事务还未提交 |

它被访问极频繁，shared buffers 里有专门的 SLRU 缓存；PG 13+ 可用 `pg_stat_slru` 观察 Xact/Subtrans 缓存的命中情况。VACUUM 把老元组冻结之后，对应区间的 pg_xact 内容才能被截断复用。

## 可见性判定步骤

对元组的某个版本，按顺序简化成两步：

1. **看 xmin（创建这个版本的事务）**：
   - xmin 是自己事务的 xid → 看命令 id（下一节），cmin 小于当前命令 id 才可见。
   - xmin 在运行中（在 xip_list 里，或 ≥ 快照 xmax）→ 不可见。
   - xmin 已回滚 → 不可见。
   - xmin 已提交 → 进入第 2 步。
2. **看 xmax（删除/更新这个版本的事务）**：
   - 没设 xmax → 可见，这是最新版本。
   - xmax 在运行中、或已回滚 → 可见。
   - xmax 已提交且对当前快照"已完成"（xmax < 快照 xmax 且不在 xip_list）→ 不可见；否则可见。

`UPDATE` 的旧版本由 xmax 指向更新它的事务，新旧版本之间用 ctid 链接，执行器沿链走到第一个可见版本。这套判定正是 [事务与隔离级别](./transactions-and-isolation) 中各隔离级别读现象的实现基础。

## 命令 id（cmin/cmax）与同语句自见

快照是事务/语句级的，语句粒度的可见性靠元组头里的命令 id（cmin/cmax）：同一事务内，**前一条语句的修改对后一条语句可见，同一条语句看不到自己尚未完成的修改**：

```sql
BEGIN;
UPDATE t SET v = v + 1 WHERE id = 1 RETURNING v;  -- RETURNING 直接返回新值
INSERT INTO t (id) SELECT id + 1000 FROM t;       -- 刚插入的行不会被本语句再次扫到
COMMIT;
```

常见的坑：在同一条语句里调用 VOLATILE 函数写表再读表，读不到本语句刚写的行——这不是 bug，是命令 id 语义；需要"写完立刻读"就拆成两条语句，或用 CTE `RETURNING` 串联。

## 冻结（frozen bit）与早期冻结

- 元组冻结后，其 xmin 被标记为"对所有快照可见"（PG 9.4 起是元组上的 HEAP_XMIN_FROZEN 标志位，不再改写 xid 值），可见性判定不再需要查 pg_xact。
- VACUUM 冻结年龄超过 `vacuum_freeze_min_age`（默认 5000 万）的元组；当库的 age 逼近 `autovacuum_freeze_max_age`（默认 2 亿）时，autovacuum 触发激进的全表扫描，把更多还不太老的元组**提前冻结**，避免之后一遍遍重扫。早期冻结多写一些 WAL，换取以后不再处理这些页。
- 观测每页冻结状态可用 pg_visibility 扩展：

```sql
CREATE EXTENSION IF NOT EXISTS pg_visibility;
SELECT * FROM pg_visibility_map('t') LIMIT 5;   -- all_visible / all_frozen
```

## xid 回卷（wraparound）：风险边界与警报

xid 是 32 位无符号数，总量约 42 亿；PostgreSQL 要求"最新 - 最老"的差距保持在约 20 亿以内，因此老事务必须持续被冻结，给计数器腾出空间。默认的三道防线：

1. **age 到 2 亿**（`autovacuum_freeze_max_age`）：对该库触发强制防回卷 vacuum，激进冻结并截断 pg_xact。
2. **距回卷约 4000 万事务**：日志开始高频出现 `database "x" must be vacuumed within N transactions` 警告。
3. **距回卷只剩数百万事务**：服务器拒绝执行大多数命令，报 `database is not accepting commands to avoid wraparound data loss`，只能人工介入：清理长事务/孤儿复制槽/prepared transaction，再手动 `VACUUM FREEZE`。

把下面这条接入监控（阈值告警建议远早于 2 亿）：

```sql
SELECT datname, age(datfrozenxid) AS oldest_xid_age
FROM   pg_database
ORDER  BY 2 DESC;
```

注意被遗忘的复制槽（`pg_replication_slots` 的 xmin 列）和两阶段提交残留（`pg_prepared_xacts`）会像长事务一样顶住冻结进度，是回卷告警最常见的根因。告警配置见[监控与告警](../operations/monitoring-and-alerting)。

## 注意事项与常见坑

- **REPEATABLE READ 的"快照过旧"**：设置了 `old_snapshot_threshold`（默认关闭）后，超时的长事务会收到 `snapshot too old` 错误；不设置则一切照旧，但膨胀与回卷压力转嫁给 VACUUM——本质是同一族问题。
- **冻结不是免费的**：激进冻结产生大量 WAL，可能撑大复制延迟，大表要在业务低峰处理。
- **别用 `txid_current()` 做业务 ID**：它消耗 xid 且只增不回退，业务序列用 sequences 或 `pg_current_xact_id_if_assigned()`。
- pg_xact 只有 2 bit/事务，但会随事务号区间持续增长；长期不冻结的库即使没有数据膨胀，pg_xact 也会异常大。

## 参考资料

- [PostgreSQL 官方文档 · 24.1. Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)
- [PostgreSQL 官方文档 · Chapter 51. Overview of PostgreSQL Internals](https://www.postgresql.org/docs/current/overview.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [MVCC 与多版本](./mvcc-and-multi-version)
- [事务与隔离级别](./transactions-and-isolation)
- [VACUUM 与 HOT](./vacuum-and-hot)
- [监控与告警](../operations/monitoring-and-alerting)
- [architecture-and-memory](architecture-and-memory.md)
- [index](index.md)
- [lock-conflict-troubleshooting](lock-conflict-troubleshooting.md)
- [mvcc-and-multi-version](mvcc-and-multi-version.md)
- [transactions-and-isolation](transactions-and-isolation.md)
- [knowledge](/knowledge.md)
官方文档参考：[Preventing Transaction ID Wraparound Failures](https://www.postgresql.org/docs/current/routine-vacuuming.html)
