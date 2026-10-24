# 事务与隔离级别

PostgreSQL 实现了 SQL 标准的四个隔离级别，但实现方式和标准描述、MySQL 都有出入：任何级别都不会出现脏读（READ UNCOMMITTED 只是兼容标准的别名，行为等同 READ COMMITTED），默认级别是 READ COMMITTED，而 REPEATABLE READ 在 PostgreSQL 中连幻读也一并消除。各级行为差异的底层是「快照什么时候取」，见 [MVCC 与多版本](/zh/internals/mvcc-and-multi-version)。

## 四个级别的 PostgreSQL 实现

| 级别 | 快照时机 | 脏读 | 不可重复读 | 幻读 | 写冲突 |
| --- | --- | --- | --- | --- | --- |
| READ COMMITTED（默认） | 每条语句取新快照 | 无 | 可能 | 可能 | 等待对方结束后基于新版本重评 |
| REPEATABLE READ | 事务第一条语句时 | 无 | 无 | 无 | 报 40001，事务需回滚重试 |
| SERIALIZABLE | 事务第一条语句时 | 无 | 无 | 无 | SSI 主动中止一方，报 40001 |
| READ UNCOMMITTED | 同 READ COMMITTED | 无 | 可能 | 可能 | 同 READ COMMITTED |

## READ COMMITTED：每条语句一个新快照

- 同一事务内先后两条相同的 SELECT 可能返回不同结果（中间有其他事务提交）；
- UPDATE/DELETE 遇到目标行正被并发事务修改时先等待；对方提交后，基于该行**最新版本**重新评估 WHERE：仍满足则在其上继续操作，不再满足则跳过该行；
- 这让单条语句的行为可预期，但跨语句一致性要应用自己保证。典型坑是「先 SELECT 检查再 UPDATE」在并发下不成立——应该改成 `UPDATE ... WHERE <条件>` 的原子条件写法，或 `INSERT ... ON CONFLICT`，写法见 [INSERT 冲突处理](/zh/basics/crud-and-on-conflict)。

## REPEATABLE READ：事务级快照

快照在事务第一条查询语句时建立，保持到事务结束：

- 普通 SELECT 反复执行结果一致，不读别人新提交的数据；幻读也不存在——可见性由快照决定，不靠加锁挡住新行；
- 写冲突显式报错：要更新的行在快照建立后被其他事务修改并提交时，收到 `could not serialize access`（SQLSTATE 40001），事务必须整体回滚重试；
- 长报表、一致性导出适合这个级别：整份结果基于同一时点。

## SERIALIZABLE：SSI 与可重试的失败

SERIALIZABLE 在 REPEATABLE READ 之上叠加可串行化快照隔离（SSI，PG 9.1 起）：

- 用谓词锁（SIReadLock）跟踪事务间的读写依赖，识别出会导致「串行执行结果不一致」的 rw 反依赖环；
- 检测到危险结构时主动中止其中一个事务，报 SERIALIZATION FAILURE（40001）；
- 冲突检测是乐观的：谓词锁在内存中，低冲突负载几乎没有额外代价；高冲突负载下 40001 重试率上升，这是设计内行为。

用 SERIALIZABLE 的前提是应用实现了重试循环，并且**重跑整个事务**（包括其中的读），不能只重试最后一条语句。

## 设置隔离级别

```sql
-- 只影响当前事务，必须写在事务内第一条查询之前
BEGIN;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SELECT ...;
COMMIT;

-- 等价写法
BEGIN ISOLATION LEVEL SERIALIZABLE;
...

-- 调整会话默认（重启前有效的全局默认用 ALTER SYSTEM）
SET default_transaction_isolation = 'repeatable read';
```

```sql
-- 观察当前值
SHOW transaction_isolation;
SELECT name, setting FROM pg_settings
WHERE name IN ('default_transaction_isolation', 'transaction_isolation');
```

## 与 MySQL 的路线差异

MySQL InnoDB 默认 REPEATABLE READ，一致性读基于 undo 版本链 + ReadView，同时用间隙锁（next-key lock）在当前读场景锁住范围、阻止幻影行插入；PostgreSQL 的 REPEATABLE READ/SERIALIZABLE 不对普通读加范围锁，幻读靠快照消除，串行化靠 SSI 乐观检测。迁移系统时不要假设两边锁行为一致，尤其是依赖 MySQL 间隙锁做「防插入」语义的代码。

## 应用层重试模式

40001（serialization_failure）和 40P01（deadlock_detected）都应当重试：

```plaintext
for attempt in 1..MAX_RETRIES:
    try:
        BEGIN (REPEATABLE READ 或 SERIALIZABLE)
        执行事务内全部读和写
        COMMIT
        return 成功
    except SQLSTATE in (40001, 40P01):
        ROLLBACK
        sleep(随机指数退避，如 50ms * 2^attempt * rand())
    except 其他错误:
        ROLLBACK
        raise
```

要点：

- 事务尽量短小，把「查询后问用户、调外部接口」这类跨事务交互移出事务；
- 退避加随机抖动，避免多个客户端同步重试制造新的冲突峰；
- 重试次数设上限并留监控，长期重试率高的业务说明该级别或该段逻辑不适合当前负载。

## 观测 SQL

```sql
-- SERIALIZABLE 事务持有的谓词锁（pg_locks 里以聚合形式出现，不是逐条列出）
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT * FROM orders WHERE amount > 1000;
SELECT pid, mode, granted FROM pg_locks WHERE mode = 'SIReadLock';
ROLLBACK;
```

```sql
-- 看其他会话的事务时长与状态，配合重试率判断冲突压力
SELECT pid, state, now() - xact_start AS xact_age, query_start, query
FROM pg_stat_activity
WHERE backend_type = 'client backend' AND xact_start IS NOT NULL
ORDER BY xact_start;
```

## 注意事项与常见坑

- 隔离级别不消除死锁：任何级别都可能死锁，处理方式都是 40P01 重试，见 [锁系统](/zh/internals/lock-system)。
- REPEATABLE READ/SERIALIZABLE 下长事务叠加大并发写，40001 会明显变多；升级隔离级别前先确认业务能接受重试。
- 连接池（事务级复用）下 `SET default_transaction_isolation` 的会话效果可能被下一个租户复用，建议在事务内用 `SET TRANSACTION` 显式声明。

## 参考资料

- [PostgreSQL 官方文档 · 13.2. Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [PostgreSQL 官方文档 · Chapter 51. Overview of PostgreSQL Internals](https://www.postgresql.org/docs/current/overview.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [pagination-and-sorting](/zh/advanced-sql/pagination-and-sorting)
- [transaction-basics](/zh/basics/transaction-basics)
- [comparison-with-mysql](/zh/ecosystem/comparison-with-mysql)
- [index](/zh/internals/index)
- [lock-system](/zh/internals/lock-system)
- [mvcc-and-multi-version](/zh/internals/mvcc-and-multi-version)
- [snapshot-and-visibility](/zh/internals/snapshot-and-visibility)
- [knowledge](/zh/knowledge)- [MVCC 与多版本](/zh/internals/mvcc-and-multi-version)——快照与可见性的底层机制。
- [快照与可见性](/zh/internals/snapshot-and-visibility)——可见性判断的完整规则。
- [锁系统](/zh/internals/lock-system)——显式锁与死锁排查。
- [事务基础](/zh/basics/transaction-basics)——BEGIN/COMMIT/SAVEPOINT 基本用法。

官方文档：<https://www.postgresql.org/docs/current/transaction-iso.html>
