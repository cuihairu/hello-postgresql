# 事务入门

事务是数据库保证一组操作"要么全做、要么全不做"的机制。PostgreSQL 默认每条语句都在一个事务里执行（autocommit），你手写的 `BEGIN/COMMIT/ROLLBACK` 只是显式地把多条语句包进同一个原子单元。事务的正确性来自 MVCC 与 WAL，这里只讲最基础的控制语句、回滚语义与常见的隔离级别读现象，深入的锁与可见性规则见 [MVCC 与多版本](../internals/mvcc-and-multi-version)。

## BEGIN / COMMIT / ROLLBACK

事务边界由这三条语句控制。`BEGIN` 开启事务，`COMMIT` 提交并持久化，`ROLLBACK` 丢弃所有未提交修改：

```sql
BEGIN;

UPDATE accounts SET balance = balance - 30 WHERE id = 1;
UPDATE accounts SET balance = balance + 30 WHERE id = 2;

-- 检查通过再提交；任何一步失败就整体回滚
COMMIT;
-- ROLLBACK;   -- 取消全部未提交修改
```

在 `psql` 里，`BEGIN` 之后若某条语句报错，事务会进入"aborted"状态，此时任何语句都只会提示 `ERROR: current transaction is aborted, commands ignored until end of transaction block`，直到 `ROLLBACK`。这是正常的保护行为，不是 bug。

## autocommit：psql 与驱动的语义差异

- **psql 交互模式**：默认 autocommit 开启，每条单独发送的语句自成事务。若一条语句报错，psql 通常仍继续（除非开了 `ON_ERROR_ROLLBACK`），错误只影响那一条语句。
- **驱动的 `autocommit` 开关**：Python psycopg3、JDBC、Go `database/sql` 等默认 `autocommit=false`，此时每条语句**不会自动提交**，连接关闭或显式 `commit` 前修改不落盘。最典型的坑是：跑完 `UPDATE` 后没 commit，别的连接看不到改动。
- **psql 的 `\set autocommit off`**：可以让 psql 手动管理事务；`\set ON_ERROR_ROLLBACK on` 后单条报错时自动回滚该语句，方便交互调试。

无论客户端怎么包装，**数据库侧的原子性单位始终是显式 `BEGIN...COMMIT` 的块**。自动提交的本质是"每条语句前后各加一对隐式 BEGIN/COMMIT"。

## SAVEPOINT：事务内部的子回滚点

长事务里若只需撤销后半段，可以用 `SAVEPOINT` 设置子回滚点，避免整段重来：

```sql
BEGIN;

INSERT INTO orders(user_id, amount) VALUES (1, 100);   -- 步骤 1
SAVEPOINT after_order;

INSERT INTO order_items(order_id, sku, qty) VALUES (currval('orders_id_seq'), 'SKU-1', 2);

-- 若后续步骤 3 失败，回滚到 SAVEPOINT 即可，步骤 1 保留
ROLLBACK TO SAVEPOINT after_order;
UPDATE orders SET amount = 0 WHERE id = currval('orders_id_seq');

RELEASE SAVEPOINT after_order;   -- 释放，提交前可选
COMMIT;
```

注意 `ROLLBACK TO SAVEPOINT` 不会结束外层事务，只是回到该点；之后仍可继续执行并 `COMMIT`。

## 事务里的 DDL 也可回滚

这是 PostgreSQL 与 MySQL 的重要差异：**MySQL 的 DDL（如 `ALTER TABLE`）会隐式提交当前事务**，无法回滚；PostgreSQL 的 DDL 是事务性的，可以与 DML 一起提交或回滚。

```sql
BEGIN;

CREATE TABLE audit_log (id bigint PRIMARY KEY, op text);
INSERT INTO audit_log VALUES (1, 'test');
ALTER TABLE audit_log ADD COLUMN created_at timestamptz DEFAULT now();

ROLLBACK;   -- 上述建表 + 插入 + 加列全部撤销
```

这把 PostgreSQL 的在线 DDL（如给大表加列）变得安全得多：`ALTER TABLE ... ADD COLUMN` 是轻量操作，可放进事务里与业务 DML 一起提交，失败则整批回滚。代价是 DDL 会持有锁（见 [锁系统](../internals/lock-system)），长事务里的 DDL 会让后续 DDL 排队等待。

## 读现象一瞥：脏读 / 不可重复读 / 幻读

不同隔离级别下，同一查询可能看到不同的结果。PostgreSQL 默认 `READ COMMITTED`，三种读现象与对应最低隔离级别：

| 读现象 | 含义 | 最低隔离级别 |
| --- | --- | --- |
| 脏读 | 读到另一个事务**未提交**的修改 | `READ COMMITTED` |
| 不可重复读 | 同一事务内两次读同一行，结果不同 | `REPEATABLE READ` |
| 幻读 | 同一事务内两次按同一范围查询，行数不同 | `SERIALIZABLE` |

用会话 1 和会话 2 同时开两个 psql 连接即可复现 `READ COMMITTED` 下的不可重复读：

```sql
-- 会话 A
BEGIN;
UPDATE users SET balance = 999 WHERE id = 1;   -- 未提交

-- 会话 B（另开连接，自动提交下读到旧值 100）
SELECT balance FROM users WHERE id = 1;        -- 100

-- 会话 A 提交
COMMIT;

-- 会话 B 再次读，读到新值 999 —— 不可重复读
SELECT balance FROM users WHERE id = 1;        -- 999
```

PostgreSQL 的 `REPEATABLE READ` 基于 MVCC 快照实现，不靠锁，且能避免幻读；`SERIALIZABLE` 才引入谓词锁与序列化冲突检测。四种隔离级别的完整语义与 `SET TRANSACTION ISOLATION LEVEL` 用法见 [事务与隔离级别](../internals/transactions-and-isolation)。

## 长事务与 dblink 的危害

- **长事务**：事务不提交会让旧版本元组无法被 VACUUM 回收，导致表膨胀（bloat），进而拖慢 `UPDATE/DELETE` 与索引扫描。线上应避免"开着业务事务去等人、等网络、等人工确认"。
- **`dblink` / `postgres_fdw` 的嵌套事务**：跨库操作不会自动与本地事务一起原子提交，需要两阶段提交或补偿逻辑，避免"一边成功一边悬挂"。
- 排查长事务可直接查 `pg_stat_activity`，看 `state = 'idle in transaction'` 的会话及其 `xact_start`：

```sql
SELECT pid, state, now() - xact_start AS age, query
FROM   pg_stat_activity
WHERE  state = 'idle in transaction'
ORDER  BY age DESC;
```

## 注意事项与常见坑

- **autocommit 下的"伪事务"**：连续敲两条 `UPDATE`，第二条失败时第一条已经提交，无法靠后续 `ROLLBACK` 撤销——需要显式 `BEGIN`。
- **`BEGIN` 不是"清空状态"**：进入事务后任何语句失败都会把事务置为 aborted，必须 `ROLLBACK` 才能继续。
- **DDL 也要包事务**：即使是 `CREATE INDEX CONCURRENTLY`（不锁表但不能在事务块内执行）之外的 DDL，也建议放进事务，避免半成品对象。
- **别在事务里干慢活**：长事务 + DDL 组合会放大锁冲突，常见于"加索引 / 加列 / 改类型"混在业务事务里跑，见 [锁与并发瓶颈](../performance/lock-and-concurrency-bottlenecks)。

## 相关页面

- [MVCC 与多版本](../internals/mvcc-and-multi-version)
- [事务与隔离级别](../internals/transactions-and-isolation)
- [锁系统](../internals/lock-system)
- [psql 入门](./psql-getting-started)
