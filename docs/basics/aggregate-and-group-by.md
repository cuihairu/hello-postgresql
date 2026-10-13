# 聚合与 GROUP BY

聚合函数把多行折叠成一个值，`GROUP BY` 先把行分成若干组，聚合函数再逐组计算。这一页覆盖最常用的五个聚合函数、`COUNT` 的三种形态、非聚合列的规则、`HAVING` 与 `WHERE` 的分工、NULL 分组的行为，以及条件聚合 `FILTER` 和多维汇总 `GROUPING SETS` 的入口。

## 示例表

```sql
CREATE TABLE sales (
    id        bigserial PRIMARY KEY,
    region    text,
    category  text NOT NULL,
    amount    numeric(10,2) NOT NULL,
    sale_date date NOT NULL
);

INSERT INTO sales (region, category, amount, sale_date) VALUES
    ('华北', '图书', 120.00, '2026-01-05'),
    ('华北', '图书', 80.00,  '2026-01-20'),
    ('华北', '数码', 3000.00,'2026-01-21'),
    ('华东', '图书', 200.00, '2026-02-01'),
    (NULL,   '数码', 900.00, '2026-02-03'),
    ('华东', '图书', 50.00,  '2026-02-10');
```

## 五个常用聚合函数

`count`、`sum`、`avg`、`min`、`max` 覆盖绝大多数报表需求。它们有一个共同规则：**除 `count(*)` 外，聚合函数都忽略 NULL 输入**。由此推出两个容易踩的差异：

```sql
SELECT sum(amount) FROM sales WHERE category = '家电';  -- NULL，不是 0
SELECT count(*)    FROM sales WHERE category = '家电';  -- 0
```

对「可能一行都没有」的 `sum`，习惯用 `coalesce(sum(amount), 0)` 兜底。`min`/`max` 同样忽略 NULL；`avg` 等于 `sum/count(该列)`，分母不包含 NULL 行，想要「把 NULL 当 0 参与平均」就要显式 `avg(coalesce(amount, 0))`——两种语义差别很大，写之前先确认需求。

## COUNT 的三种形态

```sql
SELECT count(*)              AS row_count,     -- 行数，含 NULL 行
       count(region)         AS region_count,  -- region 非 NULL 的行数：5
       count(DISTINCT region) AS distinct_regions  -- 去重后：2（华北、华东）
FROM sales;
```

`count(*)` 数行，`count(col)` 数「该列非 NULL 的行」，`count(DISTINCT col)` 数去重后的个数。统计「有下单行为的用户数」时用 `count(user_id)` 还是 `count(*)`，取决于你是想数订单行还是数用户——写错不会报错，只会悄悄给错数。

## GROUP BY 语义与非聚合列规则

SELECT 列表里的每个列，要么出现在 `GROUP BY` 里，要么被包在聚合函数中，否则报错 `column must appear in the GROUP BY clause`。这条规则保证每组输出一行时，非聚合列的取值是确定的：

```sql
SELECT region, category, sum(amount) AS total
FROM sales
GROUP BY region, category
ORDER BY region NULLS LAST, category;
```

两个有用的放宽：`GROUP BY` 可以写输出列的序号（`GROUP BY 1, 2`）， exploratory 分析时方便但生产 SQL 建议写列名；按表的主键分组时，该表的其他列可以不聚合直接 SELECT（函数依赖推断，PG 9.1 起），例如 `SELECT o.id, o.status, sum(...)` 按 `o.id` 分组不必再写 `o.status`。

## HAVING vs WHERE

`WHERE` 在分组**前**过滤行，不能使用聚合函数；`HAVING` 在分组**后**过滤组，条件里可以（通常也应该）有聚合。以「总销售额超过 1000 的地区」为例：

```sql
SELECT region, sum(amount) AS total
FROM sales
WHERE sale_date >= '2026-01-01'          -- 先丢掉不需要的行
GROUP BY region
HAVING sum(amount) > 1000                -- 再按组的聚合值筛选
ORDER BY total DESC;
```

能放进 `WHERE` 的条件不要放进 `HAVING`：`WHERE` 越早过滤，参与分组和聚合的数据越少。反过来，把聚合条件误写进 `WHERE` 是语法错误。

## 分组键为 NULL 的组

与比较运算不同，`GROUP BY` 把所有 NULL 视为同一个值——`region` 为 NULL 的行会聚成一组，而不是各自消失。需要区分「确实是 NULL」和「漏分组」时，可以用 `coalesce(region, '未分配')` 给它一个可读的标签：

```sql
SELECT coalesce(region, '未分配') AS region, sum(amount) AS total
FROM sales
GROUP BY coalesce(region, '未分配');
```

上面 `ORDER BY region NULLS LAST` 也是同样的问题引出的：排序时 NULL 默认排在最前（DESC 时最后），报表里通常要显式处理。

## FILTER (WHERE ...)：条件聚合

PG 9.4 起支持 `FILTER` 子句，让同一个 GROUP BY 里并行计算多个口径，比在 `sum` 里塞 `CASE WHEN` 清晰：

```sql
SELECT category,
       count(*)                      AS all_rows,
       count(*) FILTER (WHERE amount >= 100)      AS big_orders,
       sum(amount) FILTER (WHERE region = '华北') AS north_total
FROM sales
GROUP BY category;
```

等价的旧写法是 `sum(amount) FILTER` 换成 `sum(CASE WHEN region = '华北' THEN amount END)`，功能相同，可读性差一截。

## GROUPING SETS 一瞥

一次查询同时按多个维度汇总，不必发多条 SQL 再 UNION：

```sql
SELECT region, category, sum(amount) AS total
FROM sales
GROUP BY GROUPING SETS ((region, category), (region), (category), ());
-- 分别输出：明细组合、按地区小计、按品类小计、总计
```

结果里「未参与该层分组的列」显示为 NULL，配合 `grouping()` 函数可以区分小计行。多维汇总、ROLLUP/CUBE 与窗口函数同属报表计算工具，见 [窗口函数](../advanced-sql/window-functions)。

## 注意事项与常见坑

- 不带 `ORDER BY` 时分组结果的顺序没有任何保证，报表 SQL 永远显式排序。
- `count(DISTINCT col)` 在大表上是内存消耗大户，海量去重计数考虑 HLL 类扩展或预聚合。
- JOIN 之后再 GROUP BY，要小心一对多把行数撑大导致计数虚高，见 [JOIN 全家族](./join-family) 的对应小节。
- `sum` 空组返回 NULL 已在开头强调；`avg` 忽略 NULL 的语义也要在需求层面确认。

## 参考资料

- [PostgreSQL 官方文档 · Part I. Tutorial](https://www.postgresql.org/docs/current/tutorial.html)
- [PostgreSQL 官方文档 · The SQL Language](https://www.postgresql.org/docs/current/sql.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [WHERE 与表达式](./where-and-expressions)
- [窗口函数](../advanced-sql/window-functions)
- [条件表达式](../advanced-sql/conditional-expressions)
- [conditional-expressions](/advanced-sql/conditional-expressions.md)
- [set-operations](/advanced-sql/set-operations.md)
- [window-functions](/advanced-sql/window-functions.md)
- [index](index.md)
- [join-family](join-family.md)
官方文档：[聚合函数](https://www.postgresql.org/docs/current/functions-aggregate.html)、[GROUP BY 与 HAVING 教程](https://www.postgresql.org/docs/current/tutorial-agg.html)。
