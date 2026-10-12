# 条件表达式

条件表达式让 SQL 在查询内部做分支决策：`CASE` 是标准 SQL 的通用形态，`COALESCE`/`NULLIF` 处理 NULL 兜底，`FILTER (WHERE ...)` 是 PostgreSQL 专属的条件聚合语法，`DISTINCT ON` 则解决「每组取一行」这个经典问题。这一页还覆盖与排序绑定的 `NULLS FIRST`/`NULLS LAST`——不显式声明时它在 `ASC` 和 `DESC` 下的默认行为相反，是报表排序错乱的常见根源。

## 示例表

```sql
CREATE TABLE orders (
    id          bigserial PRIMARY KEY,
    user_id     bigint NOT NULL,
    amount      numeric(10,2),
    status      text NOT NULL,      -- paid / refunded / pending
    paid_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO orders (user_id, amount, status, paid_at) VALUES
    (1, 120.00, 'paid',    '2026-01-05 10:00+08'),
    (1,  80.00, 'refunded', '2026-01-06 10:00+08'),
    (2, 300.00, 'paid',    '2026-01-07 10:00+08'),
    (2, NULL,   'pending', NULL),
    (3,  50.00, 'paid',    '2026-01-09 10:00+08'),
    (3, 200.00, 'paid',    '2026-01-10 10:00+08');
```

## CASE 的两种形态

**简单形态**把一个表达式与若干值逐一比较，适合等值分支：

```sql
SELECT id, status,
       CASE status
           WHEN 'paid'     THEN '已支付'
           WHEN 'refunded' THEN '已退款'
           ELSE '待支付'
       END AS status_label
FROM orders;
```

**搜索形态**逐个评估布尔条件，命中即返回，能力上完全覆盖简单形态：

```sql
SELECT id, amount,
       CASE
           WHEN amount >= 200 THEN '大额'
           WHEN amount >= 100 THEN '中额'
           WHEN amount IS NULL THEN '未定价'
           ELSE '小额'
       END AS bucket
FROM orders
ORDER BY id;
```

**没有 ELSE 且都不命中时返回 NULL**，不是报错也不是空串——漏写 ELSE 是「查出来一堆 NULL」的最常见原因。

### 短路求值的边界

`CASE` 的分支按顺序求值，命中的分支之后的表达式不会执行。但官方文档明确列出一个例外：**聚合表达式先于 CASE 的判断被计算**，用 CASE 包住聚合并不能阻止聚合参数里的错误发生：

```sql
CREATE TABLE orders_bad (id int PRIMARY KEY, cnt int NOT NULL);
INSERT INTO orders_bad VALUES (1, 2), (2, 0), (3, 5);

-- 看似安全：min 算出 0 才走 THEN；但 sum(1/cnt) 是聚合，
-- 会在 CASE 判断之前对所有行求值，cnt=0 的行直接抛除零错
SELECT CASE WHEN min(cnt) > 0 THEN sum(1.0 / cnt) END
FROM orders_bad;
```

文档推荐的解法是用 `WHERE` 或 `FILTER` 让有问题的行根本到不了聚合函数；等价地，把分支放进聚合参数内部也行：

```sql
SELECT sum(1.0 / cnt) FILTER (WHERE cnt > 0) FROM orders_bad;
SELECT sum(CASE WHEN cnt > 0 THEN 1.0 / cnt END) FROM orders_bad;
```

另一个反直觉的注意点：常量子表达式可能在**规划期**就被求值，`CASE WHEN x > 0 THEN x ELSE 1/0 END` 依然会除零，因为 `1/0` 在计划阶段就被简化掉了。涉及除零、转型这类会抛错的计算，不要指望外层 CASE 兜底。

## COALESCE 与 NULLIF

这两个函数在 [WHERE 与表达式](../basics/where-and-expressions) 已介绍过，这里只强调使用边界：

```sql
SELECT coalesce(sum(amount), 0) AS total FROM orders WHERE status = 'paid';  -- 空组给 0
SELECT coalesce(paid_at, created_at) AS effective_time FROM orders;         -- 列级兜底
SELECT NULLIF(status, 'pending') FROM orders;   -- pending 变 NULL，便于后续 coalesce
```

`NULLIF(a, b)` 等价于 `CASE WHEN a = b THEN NULL ELSE a END`，常见用途是把「哨兵值」临时转成 NULL。注意 `coalesce` 所有参数类型必须一致或可隐式转换，混用 `text` 和 `int` 会报类型错误。

## FILTER (WHERE ...) 条件聚合

PG 9.4 起支持 `FILTER` 子句，让同一个聚合函数只统计满足条件的行。与等价的 `CASE` 写法对比：

```sql
SELECT user_id,
       count(*) FILTER (WHERE status = 'paid')                     AS paid_cnt,
       count(*) FILTER (WHERE status = 'refunded')                 AS refunded_cnt,
       count(*) FILTER (WHERE paid_at IS NOT NULL)                 AS paid_with_time,
       sum(amount) FILTER (WHERE status = 'paid')                  AS paid_amount
FROM orders
GROUP BY user_id
ORDER BY user_id;
```

用 `CASE` 等价改写：`count(CASE WHEN status = 'paid' THEN 1 END)`、`sum(CASE WHEN status = 'paid' THEN amount END)`。`FILTER` 的优势不在性能（两者执行计划基本一致），而在可读性和少写一次「NULL 化」的心智负担；且 `FILTER` 可以直接用在任何聚合上，包括 `avg`、`array_agg`。一张宽报表里有七八个条件指标时，`FILTER` 版本的 SQL 明显更接近需求描述。

## DISTINCT ON：每组取一行

`DISTINCT ON (expr)` 是 PostgreSQL 扩展：按 `expr` 分组后，每组只保留**排序后第一行**。语法规则很严格——`DISTINCT ON` 的表达式必须以最左前缀匹配 `ORDER BY` 的开头：

```sql
-- 每个用户最近一笔订单
SELECT DISTINCT ON (user_id)
       user_id, id, amount, paid_at
FROM orders
WHERE paid_at IS NOT NULL
ORDER BY user_id, paid_at DESC, id DESC;
```

`ORDER BY` 里 `DISTINCT ON` 列之后的部分（`paid_at DESC, id DESC`）决定「组内哪一行胜出」。**末尾必须带一个唯一键（如 `id DESC`）打破平局**，否则 `paid_at` 相同的两行谁被保留是不确定的。若 `ORDER BY` 的开头与 `DISTINCT ON` 表达式不匹配，PostgreSQL 会直接报错，但报错不会替你补上「唯一键兜底」，结果不稳定的问题仍要靠写对来避免。

它常被用来替代「窗口函数 ROW_NUMBER = 1 再过滤」的写法，两者结果相同；需要每组取前 N 行时窗口函数更合适，见 [窗口函数](./window-functions)。

## NULLS FIRST / NULLS LAST

升序 `ASC` 时 PostgreSQL 默认把 NULL 排在**最后**（`NULLS LAST`），降序 `DESC` 时默认排在**最前**（`NULLS FIRST`）——与某些数据库（如 Oracle 升序 NULL 最后、SQL Server 视 NULL 为最小）不同。这意味着「按时间倒序取最新的记录」时，`paid_at IS NULL` 的行会全部排在最前面：

```sql
SELECT id, paid_at FROM orders ORDER BY paid_at DESC;
-- NULL 行在最前（默认 NULLS FIRST）

SELECT id, paid_at FROM orders ORDER BY paid_at DESC NULLS LAST;
-- NULL 行在最后，符合「最新在前」的直觉
```

可空列倒序排序时，显式写 `NULLS LAST` 是成本极低的防御性习惯。注意 `NULLS FIRST/LAST` 影响索引使用：btree 索引默认按「ASC + NULLS LAST」排序，`ORDER BY col DESC NULLS LAST` 若没有对应排序的索引会多一个 Sort 节点，见 [btree 索引结构](../indexing/btree-structure)。

## 注意事项与常见坑

- `CASE` 各分支返回类型必须兼容，`THEN 1 ... THEN '一'` 会在解析期报错；需要混合类型时显式 `::text`。
- `DISTINCT ON` 缺少唯一键兜底时结果不稳定，且这种不稳定**不会报错**，只在数据量变化后才暴露。
- `FILTER` 只能跟在聚合函数后，不能用在窗口函数上；窗口函数的条件聚合要用 `CASE`。
- `ORDER BY` 别名与列名同名字段优先解析为输出别名，`ORDER BY lower(status)` 与 `ORDER BY status` 引用的可能不是同一个东西，排序表达式与索引表达式要一致。
- 在聚合参数里依赖 CASE 短路来规避除零/转型错误不可靠，把可能抛错的表达式放进分支内部。

## 相关页面

- [聚合与 GROUP BY](../basics/aggregate-and-group-by)
- [窗口函数](./window-functions)
- [分页与排序](./pagination-and-sorting)
- [btree 索引结构](../indexing/btree-structure)

官方文档：[条件表达式](https://www.postgresql.org/docs/current/functions-conditional.html)、[SELECT 的 DISTINCT 子句](https://www.postgresql.org/docs/current/sql-select.html#SQL-DISTINCT)、[排序顺序与 NULL](https://www.postgresql.org/docs/current/queries-order.html)。
