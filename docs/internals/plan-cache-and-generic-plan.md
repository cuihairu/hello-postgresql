# 计划缓存与 generic plan

应用里反复执行的同构 SQL（只有参数不同）没必要每次都重新规划。PostgreSQL 会在**会话内**缓存 prepared statement 的执行计划，并且在"代入真实参数规划"（custom plan）与"不绑定参数的通用计划"（generic plan）之间做切换。这个机制省了规划开销，但带来了参数嗅探类的计划漂移问题——同一句 SQL 突然变慢，往往出在这里。

## prepared statement 的两个入口

- SQL 级：`PREPARE` / `EXECUTE` / `DEALLOCATE`，在 psql 里可以直接实验。
- 协议级（扩展查询）：驱动用 Parse / Bind / Execute 报文实现，JDBC 的 `PreparedStatement`、libpq 的 `PQexecParams` 都属于这类。执行若干次后驱动会把它升级为**命名语句**，从而进入服务端的计划缓存流程。

两个共同点：计划缓存是**每个会话私有**的，没有跨会话的共享池（这点与 Oracle 等数据库不同）；会话结束、连接归还连接池，缓存即释放。查看当前会话已缓存了什么：

```sql
SELECT name, statement, prepare_time,
       custom_plans, generic_plans
FROM pg_prepared_statements;
```

## custom plan 与 generic plan 的切换

对每个命名 prepared statement：

1. **前 5 次执行**都用 custom plan——把实际参数值代入，结合统计信息规划（等于每次重新规划）。
2. **第 6 次起**，规划器生成一份 generic plan 并估算代价；如果它的代价**不高于**前 5 次 custom plan 的平均代价，就切换为 generic 并缓存复用；否则继续用 custom plan（每次重规划）。

`plan_cache_mode` 可以改变这个行为（PG 12+，会话级可设）：

| 值 | 行为 |
| --- | --- |
| `auto`（默认） | 上述 5 次启发式 |
| `force_custom_plan` | 永远用真实参数规划，不缓存 generic |
| `force_generic_plan` | 跳过比较，直接 generic |

`EXPLAIN EXECUTE stmt(参数)` 显示的就是当前实际使用的计划；`pg_prepared_statements` 里 `custom_plans`/`generic_plans` 计数则能告诉你它走到哪一步了。

## 参数嗅探：skew 场景下 generic 变慢

generic plan 规划时不知道参数值，对等值条件只能按统计信息猜一个"平均选择性"。数据倾斜明显时，这个平均计划会伤到某一边：

```sql
CREATE TABLE orders (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status text NOT NULL
);
INSERT INTO orders (status)
SELECT CASE WHEN g % 100 = 0 THEN 'pending' ELSE 'done' END
FROM generate_series(1, 1000000) g;
CREATE INDEX ON orders (status);
ANALYZE orders;

PREPARE q(text) AS SELECT count(*) FROM orders WHERE status = $1;
```

`done` 占 99%、`pending` 占 1%：

```sql
-- 第一次执行（custom plan，参数代入统计）：走索引，毫秒级
EXPLAIN EXECUTE q('pending');

-- 连续 EXECUTE 5 次后：
EXPLAIN EXECUTE q('pending');
-- generic plan 按两种状态各 50% 估行数 → 改成 Seq Scan，低频值查询慢一个量级
```

应对顺序：

- 该业务连接设置 `SET plan_cache_mode = force_custom_plan;`（更常见的做法是给这类服务单独一个角色，`ALTER ROLE app_rw SET plan_cache_mode = ...`）。
- 或者应用侧把两种语义拆成两句文本不同的 SQL，各自形成独立缓存，让高频路径缓存 generic、低频路径不受牵连。
- 反方向也要意识到：高 QPS 的简单查询如果一直 custom plan，每次规划的 CPU 开销会显著吃掉收益，此时 `force_generic_plan` 反而是优化。

## 会话级缓存的失效边界

已缓存的计划在以下情况失效并重新规划：

- 相关对象的**定义变化**：`ALTER TABLE`、`DROP INDEX`、`TRUNCATE` 等 DDL 会发出失效消息，下一次执行时重新规划。
- 会话结束、`DEALLOCATE`。

不在失效范围内、容易踩坑的一条：

- **`ANALYZE` 更新统计信息不会使已缓存的 generic plan 失效**。旧计划里的行数估算已经冻结，统计变了它也不会自动重选。统计漂移后想让它重规划，得重建语句（重新 PREPARE）或重建连接。

排查"统计更新了但计划没变"时，先确认语句是不是走了缓存，再决定重建。

## 应用侧 prepared 池与 pgbouncer 事务模式

命名 prepared statement 绑定在**某一条物理连接**上。pgbouncer 以 transaction 模式池化时，同一客户端的两条语句可能落在不同后端连接：Parse 报文留在连接 A，Bind 却发到连接 B，于是报错 `prepared statement "..." does not exist`。驱动默认的 prepared 行为在这种架构下必须处理：

- pgbouncer 1.21 起支持在 transaction 模式下跟踪协议级 prepared statement（`max_prepared_statements`），可以在后端连接间按需重放 Parse；老版本没有这条路。
- JDBC 的兜底是连接串 `preferQueryMode=simple`，完全退回简单查询协议（放弃服务端 prepared）。
- 规划时间与连接数的权衡：prepared 省的是规划 CPU，事务池省的是连接数；连接先爆就先保池子，规划开销再用 `pg_stat_statements` 里的规划耗时量化。

## 注意事项与常见坑

- "同一条 SQL 昨天快今天慢"且 SQL 文本带 `$1`：先看是不是第 6 次执行切了 generic plan，`EXPLAIN EXECUTE` + `pg_prepared_statements` 两步就能定位。
- 本页讨论的是**执行计划缓存**；`EXPLAIN` 的行数估算来自 `pg_statistic`，两者如何配合见[优化器代价模型](./optimizer-cost-model)与[统计信息与 ANALYZE](../performance/statistics-and-analyze)。
- 测试时注意：psql 的 `PREPARE` 与驱动的扩展查询是两套入口，但服务端切换规则相同；复现问题时优先用驱动自己的连接参数。

## 参考资料

- [PostgreSQL 官方文档 · PREPARE](https://www.postgresql.org/docs/current/sql-prepare.html)
- [PostgreSQL 官方文档 · 19.7. Query Planning](https://www.postgresql.org/docs/current/runtime-config-query.html#GUC-PLAN-CACHE-MODE)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [postgresql-16-features](/ecosystem/postgresql-16-features.md)
- [index](index.md)
- [query-execution-pipeline](query-execution-pipeline.md)
- [common-bad-plans](/performance/common-bad-plans.md)
- [connection-and-orm-optimization](/performance/connection-and-orm-optimization.md)
- [partition-pruning](/performance/partition-pruning.md)- [优化器代价模型](./optimizer-cost-model)——custom/generic 的代价都由它算出。
- [统计信息与 ANALYZE](../performance/statistics-and-analyze)——选择性的来源。
- [pg_stat_statements](../performance/pg-stat-statements)——量化规划开销与语句耗时。
- [psql 进阶](../tools/psql-advanced)——PREPARE/EXPLAIN EXECUTE 的交互技巧。

官方文档：<https://www.postgresql.org/docs/current/sql-prepare.html> 与 <https://www.postgresql.org/docs/current/runtime-config-query.html#GUC-PLAN-CACHE-MODE>
