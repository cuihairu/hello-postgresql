# 窗口函数

窗口函数在「不折叠行」的前提下做跨行计算：聚合窗口函数（sum、avg、count 等）和专用窗口函数（row_number、rank、lag 等）都通过 OVER 子句声明在一片「窗口」上运算，每行输出自己的结果，明细行全部保留。这是它与 GROUP BY 最本质的区别，也让占比、排名、累计这类需求从「聚合后再 JOIN 回明细」变成一个表达式。

## OVER 的三要素

本页示例数据，amount 里故意埋了两处并列：

```sql
CREATE TABLE sales_rows (
    id     int PRIMARY KEY,
    region text NOT NULL,
    seller text NOT NULL,
    amount numeric(10,2) NOT NULL
);

INSERT INTO sales_rows VALUES
    (1, '华北', '小张', 1200),
    (2, '华北', '小李', 800),
    (3, '华东', '小王', 2000),
    (4, '华东', '小赵', 2000),
    (5, '华南', '小钱', 900),
    (6, '华南', '小孙', 800);
```

`OVER (...)` 有三要素，全部可省：

```sql
SELECT id, region, seller, amount,
       count(*)    OVER (PARTITION BY region) AS region_orders,
       sum(amount) OVER (PARTITION BY region) AS region_total,
       round(amount / sum(amount) OVER (PARTITION BY region) * 100, 1) AS pct
FROM sales_rows
ORDER BY region, id;
```

- PARTITION BY：把行分成若干分区，计算各自独立；不写则全表一个分区。
- ORDER BY：决定分区内的行序，累计类、排名类函数依赖它；不写则行序不参与语义。
- frame：把分区进一步切成「当前行附近的一小段」参与聚合，默认行为见下文。

## 与 GROUP BY 的区别：行数不变

```sql
-- GROUP BY：明细被折叠，每个 region 剩一行
SELECT region, sum(amount) AS total
FROM sales_rows
GROUP BY region;

-- 窗口：6 行明细都在，每行附带所属分区的合计
SELECT id, region, seller, amount,
       sum(amount) OVER (PARTITION BY region) AS region_total
FROM sales_rows;
```

需要「明细 + 汇总」同屏的场景（算占比、算与组均值的差距），窗口写法避免了聚合完再 JOIN 回明细的绕路；反过来，只要汇总不要明细时，GROUP BY 更直接，输出行数也更少。

## 排名三兄弟：ROW_NUMBER / RANK / DENSE_RANK

```sql
SELECT seller, amount,
       row_number() OVER (ORDER BY amount DESC) AS rn,
       rank()       OVER (ORDER BY amount DESC) AS rk,
       dense_rank() OVER (ORDER BY amount DESC) AS dr
FROM sales_rows;
```

amount 降序依次是 2000、2000、1200、900、800、800，三者差异全在并列值的处理上：

```plaintext
rn = 1 2 3 4 5 6    严格递增，并列也给不同号
rk = 1 1 3 4 5 5    并列同号，跳过被占用的名次
dr = 1 1 2 3 4 4    并列同号，名次连续不跳
```

选型直觉：每组取恰好 N 行用 row_number；并列名次都该保留（并列第一都发奖）用 rank 或 dense_rank。

## frame：默认行为与累计值陷阱

默认 frame 规则：

- OVER 里有 ORDER BY 时，frame 是 `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`，即从分区第一行到当前行；RANGE 把排序键相同的行（peers）视为一体。
- 没有 ORDER BY 时，frame 是整个分区。

陷阱出在排序键重复时：

```sql
SELECT id, amount,
       sum(amount) OVER (ORDER BY amount) AS running_range,
       sum(amount) OVER (ORDER BY amount
                         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_rows
FROM sales_rows
ORDER BY amount, id;
```

- `running_range`（默认 RANGE）：第一行 800 的累计值已经把第二行 800 一起算进去（直接 1600）；两个 2000 所在行显示全量 7700——重复键处累计值偏大且「平跳」。
- `running_rows`：按物理行逐行累计，得到 800、1600、2500、3700、5700、7700 的正常序列。

写「严格逐行累计」的账目、流水时，显式声明 ROWS frame；如果业务语义恰好是「同值同累计」，默认 RANGE 反而正确。

## 为什么 WHERE 里不能用窗口函数

SQL 的逻辑执行顺序里，窗口函数位于 FROM、WHERE、GROUP BY、HAVING 之后，只允许出现在 SELECT 输出列表和 ORDER BY 里。WHERE 在窗口计算之前筛行，自然看不到窗口结果，直接写会报错；GROUP BY 与 HAVING 同理。

标准解法是先在 CTE 或子查询里算窗口，再在外层过滤：

```sql
WITH ranked AS (
    SELECT region, seller, amount,
           row_number() OVER (PARTITION BY region ORDER BY amount DESC) AS rn
    FROM sales_rows
)
SELECT region, seller, amount
FROM ranked
WHERE rn = 1;
```

同理，想对窗口结果再做聚合，也要先包一层再 GROUP BY。

## 注意事项与常见坑

- 排名函数的 OVER 不写 ORDER BY 时，row_number 的顺序不确定，不能当稳定序号用。
- 默认 RANGE frame 的累计陷阱（上文）是流水类查询最常见的口径错误，写累计先问自己要不要 ROWS。
- 窗口函数不能嵌套（窗口里再套窗口）；需要两层计算时拆成两个 CTE 分步写。
- OVER 里的 ORDER BY 只作用于该窗口；主查询末尾的 ORDER BY 才决定最终输出顺序，两者各管各的。

## 相关页面

- [窗口函数进阶](./window-functions-advanced)
- [聚合与 GROUP BY](../basics/aggregate-and-group-by)
- [CTE 与非递归 WITH](./cte-and-non-recursive-with)
- [条件表达式](./conditional-expressions)

官方文档：[窗口函数教程](https://www.postgresql.org/docs/current/tutorial-window.html)、[窗口函数参考](https://www.postgresql.org/docs/current/functions-window.html)。
