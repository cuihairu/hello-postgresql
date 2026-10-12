# 锁冲突排查

锁等待的表象往往是"语句慢"或"连接堆积"，瓶颈不在执行而在等待。排查思路固定三步：找到等待者、找到阻塞者、决定等还是终止。PostgreSQL 9.6+ 的 `pg_blocking_pids()` 把最难的一步变成了一行调用；再配合 `lock_timeout` 兜底与死锁重试，大多数锁问题都能收敛。官方参考：[pg_locks 与锁监控](https://www.postgresql.org/docs/current/monitoring-locks.html)。

## 一条 SQL 找到谁在等谁

```sql
SELECT blocked.pid     AS blocked_pid,
       blocked.usename AS blocked_user,
       left(blocked.query, 60)          AS blocked_query,
       now() - blocked.xact_start       AS blocked_xact_age,
       pg_blocking_pids(blocked.pid)    AS blocked_by,
       left(blocker.query, 60)          AS blocker_query,
       now() - blocker.xact_start       AS blocker_xact_age
FROM   pg_stat_activity blocked
JOIN   pg_stat_activity blocker
       ON blocker.pid = ANY (pg_blocking_pids(blocked.pid))
WHERE  cardinality(pg_blocking_pids(blocked.pid)) > 0
ORDER  BY blocked_xact_age DESC;
```

- `pg_blocking_pids(pid)` 返回"直接挡在前面"的会话 pid 数组；空数组表示没在等锁。
- 结果包含**排队在我前面的人**，未必是锁的当前持有者；队列长时需要顺着数组追。
- 该函数每次调用要扫锁表，别在监控脚本里对全量会话高频轮询。

## pg_locks 与 pg_stat_activity 联查等待链

```sql
SELECT l.pid,
       a.wait_event_type || ':' || a.wait_event AS waiting_on,
       l.locktype, l.mode, l.granted,
       l.relation::regclass AS rel,
       l.transactionid
FROM   pg_locks l
JOIN   pg_stat_activity a USING (pid)
WHERE  NOT l.granted
ORDER  BY l.pid;
```

典型信号：行锁等待是 `Lock:transactionid`（在等某个事务结束），表锁等待是 `Lock:relation`。找到等待者后，反过来找持有者——在 `pg_locks` 里查同一 transactionid / 同一 relation 且 `granted = true` 的 pid，再回 `pg_stat_activity` 看它在跑什么、事务开了多久。

## 复现一：行锁等待

```sql
-- 会话 A
BEGIN;
UPDATE accounts SET balance = balance - 10 WHERE id = 1;  -- 持有该行行锁

-- 会话 B
UPDATE accounts SET balance = balance + 10 WHERE id = 1;  -- 挂起

-- 会话 C（监控会话）执行上面的联查：
-- B 的 waiting_on = Lock:transactionid，blocked_by = {A 的 pid}
```

A 提交后 B 立即继续。注意 READ COMMITTED 的细节：B 等到后会基于**最新行版本**重新评估 WHERE，`id = 1` 仍满足则在 A 改过的值上继续加 10，不会丢更新。

## 复现二：表锁等待与"排队不插队"

```sql
-- 会话 A
BEGIN;
SELECT * FROM orders WHERE id = 1;        -- 持有 ACCESS SHARE，未提交

-- 会话 B
ALTER TABLE orders ADD COLUMN note text;  -- ACCESS EXCLUSIVE，等 A 提交

-- 会话 C（B 还在等时执行）
SELECT count(*) FROM orders;              -- 也要等 B！
```

坑就在会话 C：锁请求按到达顺序排队，ACCESS EXCLUSIVE 一旦入队，后到的 ACCESS SHARE 也得等它。所以"只是加个列"也可能让整张表瞬间不可用——长只读事务 + 随手 ALTER TABLE 是线上事故的常见组合。

## 用 lock_timeout / statement_timeout 兜底

```sql
SET lock_timeout = '3s';
ALTER TABLE orders ADD COLUMN note text;  -- 3 秒拿不到锁就放弃
RESET lock_timeout;
```

- `lock_timeout` 只管"等锁"这一段（报 `canceling statement due to lock timeout`，SQLSTATE 55P03）；`statement_timeout` 管整条语句。两者默认 0，即不限时。
- 给所有 DDL 变更脚本加 `SET lock_timeout` 是运维标配：拿不到锁就退出重试，而不是把表锁成停车场。改不成就走重试循环或维护窗口。
- 可以按角色/库设默认值：`ALTER ROLE ddl_runner SET lock_timeout = '5s';`
- OLTP 角色单独设 `statement_timeout`，避免一条失控报表占死连接。

## 死锁：检测、报错解读与重试

两个事务互相持有对方想要的锁就形成环。PostgreSQL 不预防，而是等超时后检测：等待时间超过 `deadlock_timeout`（默认 1 秒）时发起死锁检测，发现环就终止其中代价小的一方：

```plaintext
ERROR:  deadlock detected
DETAIL:  Process 12345 waits for ShareLock on transaction 20001;
         blocked by process 12346.
Process 12346 waits for ShareLock on transaction 20000;
         blocked by process 12345.
HINT:  See server log for query details.
```

DETAIL 里 "waits for ShareLock on transaction N" 的 N 就是持有行锁的事务 id，对应 `pg_locks.transactionid` 列。被终止的事务回滚，另一方正常完成，数据无损。

经典交叉更新复现：

```sql
-- 会话 A                           -- 会话 B
BEGIN;                               BEGIN;
UPDATE t SET v = v WHERE id = 1;     UPDATE t SET v = v WHERE id = 2;
UPDATE t SET v = v WHERE id = 2;     UPDATE t SET v = v WHERE id = 1;
-- 约 1 秒后其中一方收到 deadlock detected
```

应用层用随机退避重试，捕获 SQLSTATE `40P01`（死锁）与 `40001`（序列化冲突）：

```plaintext
for attempt in 1..max_retries:
    try:      run_transaction(); break
    except e where e.sqlstate in ('40P01', '40001'):
        sleep(random_between(10, 200) * attempt ms)   # 随机抖动
```

固定间隔重试会让两个事务再次同时发车、再次互撞，随机化才能打散。`deadlock_timeout` 不宜调太小：锁冲突多时频繁做全环检测本身有开销。

## idle in transaction：看不见的阻塞源头

不持任何行锁、表锁的长事务同样危险：它的事务快照钉住一个 xmin，使 VACUUM 无法清理其后产生的死元组，逐步造成表膨胀；它还会顶住 xid 冻结进度（见[快照与可见性判定](./snapshot-and-visibility)）。最常见来源是 ORM 忘了 commit、事务开着等人等网络。

```sql
SELECT pid, usename, state,
       now() - xact_start   AS xact_age,
       now() - state_change AS idle_age,
       backend_xmin,
       left(query, 60)      AS last_query
FROM   pg_stat_activity
WHERE  state IN ('idle in transaction', 'idle in transaction (aborted)')
ORDER  BY xact_start;
```

兜底参数：

- `idle_in_transaction_session_timeout`（PG 9.6+）：事务空闲超时自动终止。
- `transaction_timeout`（PG 17+）：整个事务（包括一直在干活的长事务）超时。
- `backend_xmin` 显示它钉住的最老 xmin；配合 `pg_stat_user_tables.n_dead_tup` 判断膨胀程度，处理思路见[VACUUM 与 HOT](./vacuum-and-hot)与[autovacuum 调优](./autovacuum-tuning)。

## 注意事项与常见坑

- **先看等待再谈慢查询**：`pg_stat_activity` 里 `wait_event_type = 'Lock'` 的会话不该出现在慢 SQL 优化清单里，优化它没用。
- **锁等待会级联**：排在前面的 ACCESS EXCLUSIVE 会让整条队列全部变慢，杀掉队首的 ALTER 而不是逐个杀后面的查询。
- **只读副本上也查得到**：`pg_stat_activity` 与 `pg_locks` 在备库同样可用，行锁等待则只在主库出现。
- **终止用 `pg_terminate_backend(pid)`**：`pg_cancel_backend` 只取消当前正在执行的语句，杀不掉 idle in transaction。

## 相关页面

- [锁系统](./lock-system)
- [VACUUM 与 HOT](./vacuum-and-hot)
- [锁与并发瓶颈](../performance/lock-and-concurrency-bottlenecks)
- [连接与 ORM 优化](../performance/connection-and-orm-optimization)

官方文档参考：[Monitoring Database Activity](https://www.postgresql.org/docs/current/monitoring.html)
