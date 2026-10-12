# 分区裁剪与裁剪失败

分区表查得快的前提，是 planner 或 executor 能把不含目标数据的分区从计划中剔除——即「分区裁剪」。裁剪没发生时，查询会退化成扫描全部分区的 Append，性能可能还不如不分区。本页讲裁剪发生的三个时机、哪些写法会让它失效，以及如何在 EXPLAIN 输出里确认裁剪有没有发生。

## 裁剪的三个时机

官方文档把裁剪分为三个阶段，理解它们是排查裁剪失败的基础：

1. **规划期**：分区键条件在生成计划时就有确定值（常量、可在规划期求值的表达式）。被剪掉的分区在计划里完全不出现。
2. **执行器初始化期**：条件值在执行开始时才确定——prepared statement 参数、子查询输出等。初始化时一次性剔除，被剪掉的分区不再显示在计划中，剔除数量以 `Subplans Removed` 呈现。
3. **运行期**：值在执行过程中逐次变化——参数化 nested loop join 的内侧、随行变化的执行期参数。每次参数变化都重新裁剪。

```sql
CREATE TABLE measurements (
  taken_at  timestamptz NOT NULL,
  device_id int NOT NULL,
  value     numeric
) PARTITION BY RANGE (taken_at);

CREATE TABLE measurements_2026_09
  PARTITION OF measurements
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE measurements_2026_10
  PARTITION OF measurements
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
-- ……按月再建若干分区

-- 规划期裁剪：计划里只有 measurements_2026_09，
-- 其他分区根本不出现
EXPLAIN SELECT * FROM measurements
WHERE taken_at = '2026-09-15 12:00:00+08';
```

## 观测执行期裁剪

初始化期与运行期的裁剪只有在执行时才发生，要用 `EXPLAIN ANALYZE`（prepared 语句用 `EXPLAIN EXECUTE`）：

```sql
PREPARE q(timestamptz) AS
  SELECT * FROM measurements WHERE taken_at = $1;

EXPLAIN ANALYZE EXECUTE q('2026-09-15 12:00:00+08');
```

```plaintext
Append  (actual rows=5)
  ->  Seq Scan on measurements_2026_09 (actual rows=5)
  ->  Seq Scan on measurements_2026_10 (never executed)
  Subplans Removed: 1
```

- `Subplans Removed: N`：初始化期剔除了 N 个子计划；
- `(never executed)`：该子计划每次参数变化都被裁剪掉，一次也没跑——这是运行期裁剪的标志；
- 运行期裁剪的次数还可以看各子计划的 `loops`：被反复裁剪的分区 loops 远小于外侧驱动的次数。

注意：不带 ANALYZE 的 `EXPLAIN` 看不到执行期裁剪，计划里仍列着全部分区，这不代表裁剪失败，要执行一次才知道。

## 裁剪失败的常见形态

```sql
-- 1. 表达式包住分区键：条件不再是「分区键 与常量比较」
EXPLAIN SELECT * FROM measurements
WHERE date(taken_at) = date '2026-09-15';
-- 改写为区间比较即可恢复裁剪：
EXPLAIN SELECT * FROM measurements
WHERE taken_at >= '2026-09-15 00:00:00+08'
  AND taken_at <  '2026-09-16 00:00:00+08';

-- 2. 跨分区 OR：一侧不带分区键条件，整个 OR 无法证明分区无关
EXPLAIN SELECT * FROM measurements
WHERE taken_at >= '2026-09-01' OR device_id = 42;
-- 拆成 UNION，让带分区键的一支单独裁剪

-- 3. 分区键上做运算
EXPLAIN SELECT * FROM measurements
WHERE taken_at + interval '8 hours' > now();
-- 把运算移到常量一侧：taken_at > now() - interval '8 hours'
```

形态的共同点：裁剪要求能证明「这个分区不可能含满足条件的行」，任何让条件无法与分区边界直接比较的写法都会破坏证明。

## prepared 语句与 generic plan

prepared statement 执行若干次后可能切换到 generic plan（判定规则见[计划缓存与通用计划](../internals/plan-cache-and-generic-plan)）。对裁剪的影响：

- generic plan 不含具体参数值，规划期裁剪失效，计划树里带着全部分区；
- 裁剪推迟到执行器初始化期完成（`Subplans Removed` 会体现），结果正确、分区也不会被真扫，但每次执行要付大计划树的初始化与裁剪开销；
- 分区数上百、单条查询本身很轻时，这笔开销占比明显，表现为 prepared 语句比直写 SQL 慢。

绕开方式：让关键查询走 custom plan（参数分布差异大时往往自动如此），或在 PL/pgSQL 里用 `EXECUTE` 动态拼接常量，强制每次规划期裁剪。

## 分区键设计原则

- 选高频查询都会带的列（通常是时间列）；查询里从不出现的列做分区键，等于白分。
- 分区粒度与「单次查询摸到的分区数」匹配：按天分区的表跑一年跨度的报表要扫几百个分区，规划时间本身成为开销。
- 裁剪只认分区键上「与常量直接比较」的条件，设计时就想清楚主流查询的 WHERE 形态。
- 分区边界与业务语义对齐（自然月、自然日），便于把「查某段时间」翻译成闭开区间比较。

## 与 constraint_exclusion 的区别

`constraint_exclusion` 是更老的机制，服务于**继承表**（手工建 CHECK 约束模拟分区）的年代；声明式分区（`PARTITION BY`）有专门的裁剪机制，不依赖它。默认值 `partition` 表示只对分区表启用声明式裁剪路径；只有还在用继承表时才需要把它设为 `on`。它只在规划期工作，不能识别分区边界，只能验证 CHECK 约束，慢且覆盖面窄——新项目直接用声明式分区，见 [表的继承与分区设计](../database-design/table-inheritance-and-partitioning-design)。

## 相关页面

- [EXPLAIN 入门](./explain-basics)——读懂 Append 与计划结构。
- [EXPLAIN ANALYZE 与 BUFFERS](./explain-analyze-buffers)——量化每个分区实际扫了多少。
- [计划缓存与通用计划](../internals/plan-cache-and-generic-plan)——generic plan 的判定与切换。
- [表的继承与分区设计](../database-design/table-inheritance-and-partitioning-design)——分区键与粒度的设计决策。

官方文档：<https://www.postgresql.org/docs/current/ddl-partitioning.html#DDL-PARTITIONING-PRUNING>
