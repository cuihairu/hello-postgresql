# 锁与并发瓶颈

并发瓶颈不总是「机器不够快」，更多时候是一批会话在排队等同一行、同一把锁或同一个内部数据结构。这里从最常见的热点行写说起，记录长事务的连锁伤害、advisory 锁排队、lock_timeout 兜底，最后给一套从等待事件入手的定位方法。

## 热点行：计数器行的集中 UPDATE

一行数据被高频集中更新（秒杀库存、全局计数器、热门账户余额）时，所有 UPDATE 会在行锁上串行化：即使机器很闲，TPS 也被压到「每行锁周转速度」的上限。现象很典型——CPU 和 IO 都不高，`UPDATE` 延迟却随并发线性上涨。

```sql
-- 复现：100 个会话同时给同一行加一
UPDATE page_views SET cnt = cnt + 1 WHERE page_id = 42;
-- pg_stat_activity 里大量会话处于：
-- wait_event_type = Lock, wait_event = tuple
```

解法按侵入性从小到大：

```sql
-- 1. 拆行：一行计数拆成 N 行，更新随机命中一行，读时聚合
CREATE TABLE page_view_shards (
  page_id int NOT NULL,
  shard   int NOT NULL,
  cnt     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (page_id, shard)
);
UPDATE page_view_shards SET cnt = cnt + 1
WHERE page_id = 42 AND shard = floor(random() * 16)::int;
-- 读侧：SELECT sum(cnt) FROM page_view_shards WHERE page_id = 42;

-- 2. 应用侧缓冲聚合：进程内攒增量，每秒 flush 一次回库，
--    把数据库的行锁压力换成应用内存中的合并
```

拆行用「空间换并行」；缓冲聚合用「小概率丢尾部数据换吞吐」，可接受半秒误差的计数场景（配合 `synchronous_commit = off`，见[写入吞吐优化](/zh/performance/write-throughput-optimization)）收益明显。

## 长事务的连锁伤害

一个长事务同时制造两类问题：

- **持锁**：它碰过的行一直带锁，别的会话等它；它的快照越老，等它的队列越长。DDL 在它后面排队（见下文 lock_timeout）。
- **持 xmin**：它的快照让全库所有「比它新的死元组」都不可回收，vacuum 无法推进，表与索引持续膨胀，最终拖慢的是与它毫无关系的查询。

```sql
-- 找出长事务及其持有的快照
SELECT pid, state, xact_start, now() - xact_start AS xact_age,
       backend_xid, backend_xmin, query
FROM pg_stat_activity
WHERE state <> 'idle'
ORDER BY xact_start;
```

idle in transaction 是最常见形态：业务代码开了事务不提交就去做 RPC。治理见 [MVCC 与多版本](/zh/internals/mvcc-and-multi-version)与 [VACUUM 卡顿对性能的影响](/zh/performance/vacuum-stall-and-performance)。

## advisory 锁排队观测

advisory 锁由应用显式申请，常用来做任务互斥。拿不到锁的会话会安静排队，应用侧只看到「慢」，数据库侧则看得清清楚楚：

```sql
-- 谁持有、谁在等
SELECT l.pid, l.granted, l.objid,
       a.query, a.wait_event_type, a.wait_event,
       pg_blocking_pids(l.pid) AS blocked_by
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.locktype = 'advisory'
ORDER BY l.granted, l.objid;
```

`granted = false` 的行就是队列；`pg_blocking_pids()` 直接给出队头。队列过长说明任务并发设计有问题——要么缩短持锁区间，要么改用带超时的 `pg_try_advisory_lock()`，拿不到就走降级路径。

## lock_timeout 兜底

等待类的雪崩往往由一次 DDL 引发：`ALTER TABLE` 申请 ACCESS EXCLUSIVE 后排在所有读事务后面，而它排队期间新来的读事务又排在它前面——读写互相堵成串。给有锁等待风险的操作设超时，把「无限排队」变成「快速失败 + 重试」：

```sql
SET lock_timeout = '3s';
ALTER TABLE orders ADD COLUMN remark text;
RESET lock_timeout;
```

迁移工具里更实用的写法是失败后由程序重试，而不是让一条 DDL 卡住整站。注意区分：`deadlock_timeout`（默认 1s）是死锁检测的灵敏度，不是锁等待上限，两者不要互相替代。

## 等待事件分类与定位

`pg_stat_activity.wait_event_type` 把「会话在等什么」分成几类，定位瓶颈先按类分组：

```sql
SELECT wait_event_type, wait_event, count(*)
FROM pg_stat_activity
WHERE state <> 'idle' AND wait_event IS NOT NULL
GROUP BY 1, 2
ORDER BY 3 DESC;
```

- **Lock**：重量级锁排队（表锁、行锁 `tuple`、事务锁 `transactionid`、advisory）。人多说明有争用点，用 `pg_blocking_pids()` 顺藤摸瓜。
- **LWLock**：内部数据结构的轻量锁（buffer 映射、WAL 插入点等）。偶发正常，持续高说明共享内存争用，常见诱因是连接数过大或 buffer 命中率过低。
- **IO**：等磁盘读写。检查是否缺索引、命中率和 checkpoint 是否正在刷盘。
- **Client**：等客户端发命令/取结果——通常是应用方没及时消费，数据库侧无需优化。
- **IPC / BufferPin / Timeout**：并行查询协调、vacuum 等待旧快照退出等，结合具体 wait_event 查文档。

定位顺序建议：先看等待事件分布锁定大类，再用 `pg_blocking_pids()` / `pg_locks` 收敛到具体会话与对象，最后回到应用层看这条会话对应的业务代码。锁系统本身的机制见 [锁系统](/zh/internals/lock-system)，锁冲突的逐一排查见 [锁冲突排查](/zh/internals/lock-conflict-troubleshooting)。

## 参考资料

- [PostgreSQL 官方文档 · 27.2. The Cumulative Statistics System](https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-ACTIVITY-VIEW)
- [PostgreSQL 官方文档 · 14.1. Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [transaction-basics](/zh/basics/transaction-basics)
- [lock-conflict-troubleshooting](/zh/internals/lock-conflict-troubleshooting)
- [lock-system](/zh/internals/lock-system)
- [benchmark-tools](/zh/performance/benchmark-tools)
- [connection-and-orm-optimization](/zh/performance/connection-and-orm-optimization)
- [index](/zh/performance/index)
- [schema-migration-tools](/zh/tools/schema-migration-tools)- [锁系统](/zh/internals/lock-system)——锁类型与粒度的完整机制。
- [锁冲突排查](/zh/internals/lock-conflict-troubleshooting)——逐个案例的排查路径。
- [pg_stat 观测体系](/zh/internals/pg-stat-observation)——等待事件与统计视图全景。
- [慢查询治理](/zh/performance/slow-query-governance)——把本页的定位动作纳入日常流程。

官方文档：<https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-ACTIVITY-VIEW>
