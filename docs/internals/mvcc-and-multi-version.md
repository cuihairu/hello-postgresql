# MVCC 与多版本

PostgreSQL 用多版本并发控制（MVCC）实现读写互不阻塞：UPDATE/DELETE 不就地覆盖旧数据，而是生成新的行版本、把旧版本标记为过时，每个事务根据自己拿到的快照判断哪一版本可见。读不加锁、写不阻塞读，代价是堆里会积累旧版本（死元组），必须由 VACUUM 回收。

## 元组头：xmin、xmax、ctid 与 infomask

堆里的每一行（tuple）头部都带着版本控制字段：

- `xmin`：插入这一行版本的事务 ID（XID）；
- `xmax`：删除（或更新替换）这一版本的事务 ID，0 表示尚未被标记删除；
- `cmin` / `cmax`：事务内的命令序号，处理同一事务内先后多条语句的可见性；
- `ctid`：行的物理位置（页号， 页内偏移）。更新产生的新版本有新的 ctid，新旧版本由此构成版本链；
- `infomask`：标志位集合，缓存 xmin/xmax 的提交/中止状态（如 HEAP_XMIN_COMMITTED），避免每次可见性判断都去查事务状态（clog）。

## 插入、删除、更新在堆里的痕迹

- **INSERT**：写入一个新 tuple，xmin = 当前事务 ID；
- **DELETE**：不搬走数据，只把该 tuple 的 xmax 设为当前事务 ID；
- **UPDATE**：等价于「插入新版本 + 旧版本打上 xmax」。索引方面，所有索引都会为新版本追加索引项（除非走 HOT 更新，见 [VACUUM 与 HOT](./vacuum-and-hot)），这也是高频更新表索引容易膨胀的根源。

只要还有任何事务可能读到旧版本，它就必须留在堆里；「什么时候没人需要了」由快照的可见性规则和 VACUUM 决定。

## 快照如何决定可见性

一个快照记录三样东西：

- `xmin`：快照时刻所有活跃事务中的最小 XID，小于它的事务必然已结束；
- `xmax`：下一个将要分配的 XID，大于等于它的对快照必然不可见；
- `xip_list`：快照时刻仍在进行中的事务 ID 列表。

可见性判断（简化版）：一行可见，当且仅当 xmin 已提交且不在 xip_list 中，并且 xmax 为空、尚未提交、或 xmax 的事务已回滚。不同隔离级别在「什么时候取快照」上不同，这正是 [事务与隔离级别](./transactions-and-isolation) 中各级别行为差异的来源。

## 读写不阻塞的收益与代价

收益：

- 普通 SELECT 不加行锁，不会被写事务挡住，也不产生读锁等待；
- 一致性读天然成立：长查询看到的是快照时点的数据，不会被并发提交撕扯。

代价：

- 每次更新都产生一个旧版本，高频更新的表持续制造死元组；
- 死元组堆积导致表和索引膨胀：顺序扫描、索引扫描都要跳过更多垃圾，索引项新旧并存；
- 可见性判断要走版本链并查事务状态，版本链越长开销越大。

这些代价的回收出口是 VACUUM，机制与调参见 [VACUUM 与 HOT](./vacuum-and-hot) 与 [autovacuum 调优](./autovacuum-tuning)。

## 与 MySQL InnoDB 的实现差异

InnoDB 把旧版本写入独立的 undo log，聚簇索引上只保留最新版本；PostgreSQL 把新旧版本都留在堆里，靠后台 VACUUM 回收。两者的膨胀位置因此不同：InnoDB 膨胀体现在回滚段/历史链，PostgreSQL 直接体现在表文件和索引上。

## 观测 SQL

```sql
-- 在任意业务表上观察版本字段（把 t 换成你的表名）
SELECT ctid, xmin, xmax, *
FROM t
ORDER BY ctid
LIMIT 10;
```

```sql
-- 更新前后对比：旧版本被打上 xmax，新版本获得新的 ctid 和 xmin
BEGIN;
SELECT ctid, xmin, xmax FROM t WHERE id = 1;
UPDATE t SET val = val + 1 WHERE id = 1;
SELECT ctid, xmin, xmax FROM t WHERE id = 1;
ROLLBACK;
```

```sql
-- 快照三元组 xmin:xmax:xip_list 的直观形态
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SELECT txid_current_snapshot();   -- 输出形如 198560:198563:198560,198562
ROLLBACK;
```

```sql
-- 各表的死元组规模与占比
SELECT relname, n_live_tup, n_dead_tup,
       round(n_dead_tup * 100.0 / nullif(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       last_vacuum, last_autovacuum
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 10;
```

## 注意事项与常见坑

- 不要把 ctid 当作稳定行标识：更新、VACUUM FULL、CLUSTER 都会改变它。ctid 只用于排查和物理定位。
- 长事务是死元组堆积的第一根因：一个几小时不提交的事务会让它开始之后的所有旧版本都无法回收，配合 [快照与可见性](./snapshot-and-visibility) 检查 `pg_stat_activity.backend_xmin`。
- 高频 UPDATE 场景先从源头减负：让更新尽量走 HOT、控制索引数量，而不是靠事后清理兜底。

## 相关页面

- [VACUUM 与 HOT](./vacuum-and-hot)——死元组的回收与索引免更新。
- [事务与隔离级别](./transactions-and-isolation)——快照时机决定各级别行为。
- [快照与可见性](./snapshot-and-visibility)——可见性判断的完整规则。
- [索引膨胀与维护](../indexing/index-bloat-and-maintenance)——多版本带来的索引侧代价。

官方文档：<https://www.postgresql.org/docs/current/mvcc.html>
