# 查询执行管道

一条 SQL 从文本到结果要经过五个阶段：parse → analyze → rewrite → plan → execute。前四个是"编译期"，在内存里产出各种树结构，不碰数据；最后一个是"运行期"。理解每个阶段的产物，才能知道 EXPLAIN 为什么长那样、视图为什么能被下推优化、pg_stat_statements 计的到底是哪段时间。官方参考：[查询处理概览](https://www.postgresql.org/docs/current/overview.html)。

## 五个阶段总览

```plaintext
SQL 文本
  │ ① parse    词法 + 语法分析        → 原始解析树（raw parse tree）
  │ ② analyze  语义分析               → 查询树（query tree）
  │ ③ rewrite  规则系统               → 改写后的查询树（视图在这一步展开）
  │ ④ plan     优化器                 → 计划树（plan tree，EXPLAIN 显示的就是它）
  │ ⑤ execute  执行器                 → 元组流 → 结果集
```

`EXPLAIN`（不带 ANALYZE）只走到第 ④ 步，不会执行语句；`EXPLAIN ANALYZE` 才真的跑第 ⑤ 步并回放统计。

## ① parse：词法与语法

parser 只认 SQL 的"形状"，不碰任何表结构：`SELECT foo FROM bar` 语法完全合法，即使 bar 表不存在也能通过。词法切分与语法分析基于 flex/bison（gram.y、scan.l），产出原始解析树——节点是 SELECT/INSERT 等语法结构，列还是字符串名字。`ERROR: syntax error at or near ...` 都报在这一关。

## ② analyze：语义分析与查询树

analyze 阶段做语义解析：表名/列名解析成系统目录里的 OID，函数与操作符选定具体实现，补上隐式类型转换，检查对象权限。产物是查询树（Query 结构），此时列引用已经是编号（attnum）而非字符串。表不存在、列不存在、类型不匹配、权限不足，都报在这一步。

## ③ rewrite：规则系统与视图展开

rewrite 阶段应用规则系统（规则存在 pg_rewrite 表里）：

- **视图就是一条 `_RETURN` 规则**：查询树里引用视图的位置被替换为视图定义的子查询，之后优化器把它当作普通子查询处理。
- 可更新视图的改写、物化视图的定义维护也走这一阶段。

```sql
CREATE VIEW active_users AS
  SELECT id, name FROM users WHERE deleted_at IS NULL;

EXPLAIN (VERBOSE, COSTS OFF)
SELECT name FROM active_users WHERE id = 42;
-- Seq Scan on public.users
--   Output: name
--   Filter: ((id = 42) AND (deleted_at IS NULL))
```

计划里没有"视图"这个对象——它在 rewrite 阶段已被展开，`id = 42` 也被优化器下推到了基表扫描上。查看视图定义用 `\d+ 视图名` 或 `pg_get_viewdef()`。

## ④ plan：计划树

planner 以查询树为输入，枚举扫描方式、join 顺序与 join 算法，按代价模型挑出代价最低的一棵计划树。EXPLAIN 显示的就是这棵树：节点嵌套对应数据流，子节点是父节点的输入。每个节点上标注的 cost 与 rows 来自估算，估算来源见[优化器代价模型](/zh/internals/optimizer-cost-model)，三种 join 算法的取舍见 [join 实现](/zh/internals/join-implementations)。

## ⑤ execute：火山模型与节点类型

执行器是经典的 Volcano 迭代器模型：每个计划节点实现"要下一条元组"的拉取接口，上层节点逐条向下层拉（pull），处理一条发一条。内存占用与输入规模解耦，LIMIT 才能提前短路。

- **Scan 类**：Seq Scan、Index Scan、Index Only Scan、Bitmap Heap Scan。
- **Join 类**：Nested Loop、Hash Join、Merge Join。
- **辅助节点**：Sort、HashAggregate/GroupAggregate、Limit、Materialize、CTE Scan、WindowAgg 等。

注意流水线断点（pipeline breaker）：Sort、HashAggregate、Hash Join 的 build 阶段必须吃完全部输入才能吐第一行，所以 `LIMIT` 对聚合/排序查询省不了执行时间，只省传输。

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT status, count(*) FROM orders GROUP BY status ORDER BY 2 DESC LIMIT 3;
```

## pg_stat_statements 在哪一环计时

pg_stat_statements 只计量两段：**planning**（PG 13+ 的 `plans`/`total_plan_time` 列）与 **execution**（`calls`/`total_exec_time`）。parse/analyze/rewrite 不单独计量——它们通常只花亚毫秒，慢语句几乎都慢在 plan 或 execute：

```sql
SELECT query, plans, total_plan_time, calls, total_exec_time, mean_exec_time
FROM   pg_stat_statements
ORDER  BY total_exec_time DESC
LIMIT  5;
```

`total_plan_time` 占比高的语句（简单 OLTP 查询、大量不同常量拼接的 SQL）说明问题在规划而不是执行，方向是参数化与连接池侧治理，见 [pg_stat_statements](/zh/performance/pg-stat-statements)。

## PREPARE 与已缓存的计划

`PREPARE` 的语句在 prepare 时完成 parse/analyze/rewrite，计划可复用。想看某条 prepared statement 此刻会采用什么计划：

```sql
EXPLAIN EXECUTE stmt_name;
```

generic plan 与 custom plan 的切换规则见[计划缓存与 generic plan](/zh/internals/plan-cache-and-generic-plan)。

## 注意事项与常见坑

- 视图展开后**过滤下推是优化器干的，不是规则系统**：视图里出现窗口函数、DISTINCT、聚合、LIMIT 时，外层条件推不进去，"视图包一层就变慢"大多源于此。
- 权限检查在 analyze 阶段做，但**行级安全（RLS）的策略条件是规划期注入**的，用 `EXPLAIN VERBOSE` 能看到策略过滤。
- 绑定参数让用户输入永远只是数据，不进入第 ① 步的 SQL 文本——SQL 注入的根源是字符串拼接把这层边界打穿了。
- execute 阶段的内存分配受 `work_mem` 约束，Sort/Hash 超限就落盘，见[体系结构与内存](/zh/internals/architecture-and-memory)。

## 参考资料

- [PostgreSQL 官方文档 · Chapter 51. Overview of PostgreSQL Internals](https://www.postgresql.org/docs/current/overview.html)
- [PostgreSQL 官方文档 · Chapter 13. Concurrency Control](https://www.postgresql.org/docs/current/mvcc.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [优化器代价模型](/zh/internals/optimizer-cost-model)
- [join 实现](/zh/internals/join-implementations)
- [计划缓存与 generic plan](/zh/internals/plan-cache-and-generic-plan)
- [EXPLAIN 基础](/zh/performance/explain-basics)
- [index](/zh/internals/index)
- [join-implementations](/zh/internals/join-implementations)
官方文档参考：[Query Processing Overview](https://www.postgresql.org/docs/current/overview.html)
