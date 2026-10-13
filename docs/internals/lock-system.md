# 锁系统

PostgreSQL 的锁按对象层级分为表级锁、行级锁与咨询锁（advisory lock），外加保护共享内存结构、不参与死锁检测的 lightweight lock。应用开发者最常打交道的是前两类：表级锁决定 DDL 与 DML 能否并行，行级锁决定两个事务改同一行时谁先谁后。这一页给出完整的表锁模式与冲突矩阵、行级锁与咨询锁的用法；排查正在发生的锁等待见[锁冲突排查](./lock-conflict-troubleshooting)。官方参考：[Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)。

## 表级锁：八种模式与冲突矩阵

任何语句访问表之前都会先取表级锁，最普通的 `SELECT` 也不例外。八种模式按强度递增：

| 模式 | 典型语句 |
| --- | --- |
| ACCESS SHARE | `SELECT`（一切只读查询） |
| ROW SHARE | `SELECT ... FOR UPDATE / FOR SHARE` |
| ROW EXCLUSIVE | `INSERT / UPDATE / DELETE / MERGE` |
| SHARE UPDATE EXCLUSIVE | `VACUUM`（非 FULL）、`ANALYZE`、`CREATE INDEX CONCURRENTLY` |
| SHARE | `CREATE INDEX`（非并发） |
| SHARE ROW EXCLUSIVE | `CREATE TRIGGER`、`ALTER TABLE ... ADD FOREIGN KEY` 等 |
| EXCLUSIVE | `REFRESH MATERIALIZED VIEW`（非并发） |
| ACCESS EXCLUSIVE | `ALTER TABLE`、`DROP TABLE`、`TRUNCATE`、`VACUUM FULL`、`REINDEX` |

冲突矩阵（✕ 表示冲突，后到者必须等待）：

| 已持有＼请求 | ACCESS SHARE | ROW SHARE | ROW EXCL. | SHARE UPDATE EXCL. | SHARE | SHARE ROW EXCL. | EXCLUSIVE | ACCESS EXCL. |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ACCESS SHARE | | | | | | | | ✕ |
| ROW SHARE | | | | | | | ✕ | ✕ |
| ROW EXCLUSIVE | | | | | ✕ | ✕ | ✕ | ✕ |
| SHARE UPDATE EXCLUSIVE | | | | ✕ | ✕ | ✕ | ✕ | ✕ |
| SHARE | | | ✕ | ✕ | | ✕ | ✕ | ✕ |
| SHARE ROW EXCLUSIVE | | | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| EXCLUSIVE | | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| ACCESS EXCLUSIVE | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |

三个关键读法：

- **DML 之间互不冲突**：多个 `INSERT/UPDATE/DELETE`（ROW EXCLUSIVE）可以并发，行的正确性由行级锁与 MVCC 保证。
- **读写不冲突**：ROW EXCLUSIVE 与 ACCESS SHARE 兼容，所以写不阻塞普通读——这是 MVCC 的功劳，不是锁的宽容。
- **写与"重"操作互斥**：ROW EXCLUSIVE 与 SHARE（建索引）、SHARE ROW EXCLUSIVE、EXCLUSIVE、ACCESS EXCLUSIVE 都冲突。

## ROW EXCLUSIVE 与 DDL 的互斥

- `ALTER TABLE ...` 拿 **ACCESS EXCLUSIVE**，与一切模式冲突：连普通 `SELECT`（ACCESS SHARE）都进不来。改表结构的代价不在改多快，而在锁队列。
- `CREATE INDEX` 拿 **SHARE**：不阻塞读，但与所有写互斥。大表在线建索引必须用 `CREATE INDEX CONCURRENTLY`（只拿 SHARE UPDATE EXCLUSIVE，可与 DML 并行，代价是更慢且失败会留下无效索引）。
- `TRUNCATE`、`VACUUM FULL`、`DROP TABLE` 都是 ACCESS EXCLUSIVE。
- `ALTER TABLE ... ADD FOREIGN KEY` 在**被引用表**上拿 SHARE ROW EXCLUSIVE，会阻塞对方表的写。

两会话复现：未提交的写会阻塞建索引。

```sql
-- 会话 A
BEGIN;
INSERT INTO orders VALUES (1, 'x');            -- 持有 ROW EXCLUSIVE，未提交

-- 会话 B（另开一个 psql）
CREATE INDEX idx_orders_note ON orders(note);  -- 卡住，直到 A 提交/回滚
```

反过来更危险：会话 B 的 ACCESS EXCLUSIVE 一旦进入等待队列，排在它后面的所有普通查询也全部排队（锁按到达顺序申请，不允许插队），整张表瞬间"停车场"。兜底手段见[锁冲突排查](./lock-conflict-troubleshooting)。

## 行级锁

行级锁只在事务里存在，提交或回滚后自动释放。它不进主锁表：锁信息记录在元组头（xmax 字段复用），只有出现等待者时才在事务 id 锁（locktype = transactionid）上排队。

DML 会隐式取行锁：`UPDATE/DELETE` 持有行锁直到事务结束；改的是普通列时取 FOR NO KEY UPDATE（不阻塞 FOR KEY SHARE，即别的会话仍能做外键引用检查），改动涉及主键/唯一键列时升级为 FOR UPDATE。显式的四种强度与冲突：

| 请求的行锁 | 与之冲突的已持有锁 |
| --- | --- |
| FOR KEY SHARE | FOR UPDATE |
| FOR SHARE | FOR NO KEY UPDATE、FOR UPDATE |
| FOR NO KEY UPDATE | FOR SHARE、FOR NO KEY UPDATE、FOR UPDATE |
| FOR UPDATE | 四种都冲突 |

`SELECT ... FOR UPDATE / FOR SHARE` 在取行锁的同时也会取表的 ROW SHARE 表锁。两个最实用的修饰符：

- **NOWAIT**：拿不到立即报错 `ERROR: could not obtain lock on row`，适合不允许排队的前台操作。
- **SKIP LOCKED**：跳过已被别的会话锁住的行，是任务队列表的经典模式：

```sql
-- 会话 A
BEGIN;
SELECT id FROM jobs WHERE status = 'pending'
ORDER BY id LIMIT 1
FOR UPDATE SKIP LOCKED;          -- 拿到 id = 1
UPDATE jobs SET status = 'running' WHERE id = 1;
COMMIT;

-- 会话 B 立刻执行同样的查询：id=1 已被锁，SKIP LOCKED 直接跳过，拿到 id=2
```

## 咨询锁（advisory lock）

咨询锁是给应用当"命名互斥量"用的协作锁，数据库本身不使用它。分两族：**会话级**（与事务无关，显式解锁或断开连接才释放）与**事务级**（COMMIT/ROLLBACK 自动释放）。

| 函数 | 粒度 | 说明 |
| --- | --- | --- |
| `pg_advisory_lock(key)` | 会话级 | 阻塞直到拿到 |
| `pg_try_advisory_lock(key)` | 会话级 | 立即返回 bool，拿不到不等待 |
| `pg_advisory_unlock(key)` / `pg_advisory_unlock_all()` | 会话级 | 手动释放 |
| `pg_advisory_xact_lock(key)` | 事务级 | 事务结束自动释放，无对应 unlock |
| `pg_try_advisory_xact_lock(key)` | 事务级 | 立即返回 bool |

定时任务防重叠执行的典型用法：

```sql
SELECT pg_try_advisory_lock(hashtext('nightly-report')) AS got;
-- got = true 才继续干活；干完：
SELECT pg_advisory_unlock(hashtext('nightly-report'));
```

注意事项：

- 会话级锁**不受事务回滚影响**，忘了解锁就泄漏到连接关闭——连接池长期复用会话时尤其危险，拿不准就用事务级版本。
- 阻塞式获取按先到先得排队，公平。
- key 是一个 bigint 或两个 int；用 `hashtext()` 把字符串压成 int 时注意哈希碰撞可能让两个不同任务互锁。
- 观测：`SELECT * FROM pg_locks WHERE locktype = 'advisory';`

## 内存里的锁：fast path 与 lightweight lock

一句带过：每个后端持有的少量常规锁（最多 16 把）可以直接放在私有 fast path 数组里，不必进共享锁表，绝大多数 `SELECT` 的 ACCESS SHARE 都走这条捷径；保护 buffer pool 等共享内存数据结构的是 LWLock（轻量锁），它不参与死锁检测，也不会出现在 `pg_locks` 的普通锁里。进程与内存结构的整体图见[体系结构与内存](./architecture-and-memory)。

## 观测与常见坑

看某张表上当前的所有锁：

```sql
SELECT l.pid, a.usename, l.locktype, l.mode, l.granted, l.waitstart,
       left(a.query, 60) AS query
FROM   pg_locks l
JOIN   pg_stat_activity a USING (pid)
WHERE  l.relation = 'orders'::regclass
ORDER  BY l.granted, l.pid;
```

- **长事务里的行锁是定时炸弹**：行锁持续到事务结束，"开着事务去等人"会把后续更新全部挂起。
- **READ COMMITTED 下的行锁重评估**：等到对方提交后，本语句会在最新行版本上重新检查 WHERE 条件，行已不满足则跳过。
- **外键检查会拿父行 FOR KEY SHARE**：高并发向子表插入会锁住引用的父行，与"改父表主键"的 UPDATE 冲突（与普通父表 UPDATE 兼容）。
- **不要用 `LOCK TABLE` 滥用强锁**：显式 `LOCK TABLE orders IN ACCESS EXCLUSIVE MODE` 会让所有查询排队，仅用于维护窗口。

## 参考资料

- [PostgreSQL 官方文档 · 13.3. Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [PostgreSQL 官方文档 · Chapter 51. Overview of PostgreSQL Internals](https://www.postgresql.org/docs/current/overview.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [锁冲突排查](./lock-conflict-troubleshooting)
- [事务与隔离级别](./transactions-and-isolation)
- [MVCC 与多版本](./mvcc-and-multi-version)
- [锁与并发瓶颈](../performance/lock-and-concurrency-bottlenecks)
- [glossary](/appendix/glossary.md)
- [data-types-overview](/basics/data-types-overview.md)
- [transaction-basics](/basics/transaction-basics.md)
- [index](index.md)
- [lock-conflict-troubleshooting](lock-conflict-troubleshooting.md)
- [transactions-and-isolation](transactions-and-isolation.md)
- [ops-sop](/operations/ops-sop.md)
- [lock-and-concurrency-bottlenecks](/performance/lock-and-concurrency-bottlenecks.md)
- [schema-migration-tools](/tools/schema-migration-tools.md)
官方文档参考：[Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html)
