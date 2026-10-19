# 窗口函数进阶

在 OVER 三要素的基础上，这里整理日常分析里最高频的几组进阶用法：LAG/LEAD 环比、FIRST_VALUE/LAST_VALUE 取边界值、NTILE 分桶、按行数 frame 做移动平均、组内 Top-N，以及 FILTER 与窗口函数的组合限制。基础语法（PARTITION BY/ORDER BY/frame 默认行为）见 [窗口函数](./window-functions)。

## LAG 与 LEAD：相邻行取值

```sql
CREATE TABLE daily_revenue (
    day    date PRIMARY KEY,
    amount numeric(10,2) NOT NULL
);

INSERT INTO daily_revenue VALUES
    ('2026-03-01', 100), ('2026-03-02', 120), ('2026-03-03', 90),
    ('2026-03-04', 150), ('2026-03-05', 130), ('2026-03-06', 160);
```

```sql
SELECT day, amount,
       lag(amount) OVER w AS prev_amt,
       amount - lag(amount, 1, 0) OVER w AS day_over_day,
       lead(amount, 2) OVER w AS two_days_later
FROM daily_revenue
WINDOW w AS (ORDER BY day);
```

- `lag(列, 偏移, 默认值)`：取当前行之前第 N 行；偏移缺省为 1，默认值缺省为 NULL（首行没有「前一天」）。
- `lead` 方向相反，取之后第 N 行；`lead(amount, 2)` 表示后两天，末尾两行补 NULL。
- WINDOW 子句把公共窗口定义命名一次，多个函数复用，避免重复写长 OVER。

## FIRST_VALUE 与 LAST_VALUE 的 frame 坑

```sql
SELECT day, amount,
       first_value(amount) OVER (ORDER BY day) AS first_amt,
       last_value(amount)  OVER (ORDER BY day) AS last_wrong,
       last_value(amount)  OVER (ORDER BY day
                                 ROWS BETWEEN UNBOUNDED PRECEDING
                                          AND UNBOUNDED FOLLOWING) AS last_right
FROM daily_revenue
ORDER BY day;
```

- `first_amt` 恒为 100，符合直觉。
- `last_wrong` 恒等于当前行自己的 amount：默认 frame 只到 CURRENT ROW，「最后一行」永远是自己，这是窗口函数里最高频的误用。
- `last_right` 显式把 frame 扩到 UNBOUNDED FOLLOWING，才是真正的分区末值（本例恒为 160）。

## NTILE 分桶

```sql
SELECT day, amount, ntile(2) OVER (ORDER BY amount) AS half
FROM daily_revenue;
```

6 行分 2 桶，amount 升序前 3 行 `half = 1`，后 3 行 `half = 2`。行数不能整除时余数从前往后补：7 行分 4 桶得到 2、2、2、1。典型用途是把门店按营收切成四分位、给用户分活跃层级。注意分桶结果依赖 ORDER BY 的稳定性，排序键不唯一时补一列唯一键（如 id）保证可复现。

## ROWS frame 与移动平均

```sql
SELECT day, amount,
       round(avg(amount) OVER (ORDER BY day
             ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING), 1) AS ma3
FROM daily_revenue
ORDER BY day;
```

以第 2 天为例，窗口含前一行、当前行、后一行：(100+120+90)/3 = 103.3。边界处窗口自动收缩，第 1 天只有 (100+120)/2 = 110。

两个易混点：

- ROWS 按物理行数取窗口；RANGE 按排序键的值取窗口——`RANGE BETWEEN 1 PRECEDING AND 1 FOLLOWING` 是「键值相差不超过 1 的行」，两者在日期、金额列上含义完全不同，别写混。
- 数据缺日期时，ROWS 移动平均会把缺的日子跳过去，均值口径漂移。需要日历对齐时先用 generate_series 生成日期骨架再左连业务表，见 [LATERAL 与 FROM 子查询](./lateral-and-from-subquery)。

## 组内 Top-N

```sql
CREATE TABLE staff_sales (
    id     int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    region text NOT NULL,
    seller text NOT NULL,
    amount numeric(10,2) NOT NULL
);

INSERT INTO staff_sales (region, seller, amount) VALUES
    ('华北', '小张', 1200), ('华北', '小李', 800), ('华北', '小周', 950),
    ('华东', '小王', 2000), ('华东', '小赵', 1500), ('华东', '小吴', 1100),
    ('华南', '小钱', 900),  ('华南', '小孙', 800);
```

每个地区取销售额前 2 名：

```sql
WITH ranked AS (
    SELECT region, seller, amount,
           row_number() OVER (PARTITION BY region ORDER BY amount DESC) AS rn
    FROM staff_sales
)
SELECT region, seller, amount
FROM ranked
WHERE rn <= 2
ORDER BY region, rn;
```

- row_number 截断干脆，但并列时取舍随机；想保留并列改用 `rank() <= 2` 或 `dense_rank() <= 2`，行数会变多。
- 组数很多、每组只要头部几行时，LATERAL + LIMIT 配 (region, amount DESC) 索引往往更省，两种写法的对比见 [LATERAL 与 FROM 子查询](./lateral-and-from-subquery)。
- 每组恰好取一行还有 DISTINCT ON 写法，见 [条件表达式](./conditional-expressions)。

## FILTER 不能与窗口函数组合

聚合的 FILTER 子句只适用于普通聚合，套在窗口函数上会直接报语法错误，等价改法是用 CASE：

```sql
-- 普通聚合 + FILTER：可行
SELECT region,
       count(*)    FILTER (WHERE amount > 1000) AS big_cnt,
       sum(amount) FILTER (WHERE amount > 1000) AS big_sum
FROM staff_sales
GROUP BY region;

-- 窗口聚合不支持 FILTER，用 CASE 等价改写
SELECT region, seller, amount,
       sum(CASE WHEN amount > 1000 THEN amount END)
           OVER (PARTITION BY region) AS big_sum
FROM staff_sales;
```

CASE 不匹配的行返回 NULL，聚合函数自动忽略 NULL，语义与 FILTER 一致。

## 注意事项与常见坑

- lag/lead 的默认值参数只补「越界」的行，不处理列里本身存在的 NULL，先明确口径再写。
- LAST_VALUE 忘了扩 frame：输出「看起来有值但全是当前行」，排查窗口 bug 先查这里。
- 需要对窗口结果再过滤或再聚合时，不能写进 WHERE/HAVING，先包一层 CTE（原因见 [窗口函数](./window-functions)）。
- 移动平均的窗口宽度是行数不是天数：业务要「近 7 天均值」时，缺数的日子会扭曲口径，先补日历再开窗。
- WINDOW 命名窗口已含 ORDER BY 时，引用它的 OVER 不能再追加 ORDER BY，只能追加 frame 子句。

## 参考资料

- [PostgreSQL 官方文档 · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL 官方文档 · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [窗口函数](./window-functions)
- [LATERAL 与 FROM 子查询](./lateral-and-from-subquery)
- [条件表达式](./conditional-expressions)
- [分页与排序](./pagination-and-sorting)
- [index](index.md)
- [lateral-and-from-subquery](lateral-and-from-subquery.md)
- [window-functions](window-functions.md)
官方文档：[窗口函数参考](https://www.postgresql.org/docs/current/functions-window.html)、[窗口函数文档](https://www.postgresql.org/docs/current/tutorial-window.html)。
