# Window Functions in Depth

Building on the three parts of OVER, this page collects the most frequently used advanced patterns in day-to-day analysis: LAG/LEAD for period-over-period comparisons, FIRST_VALUE/LAST_VALUE for boundary values, NTILE for bucketing, ROWS frames for moving averages, per-group Top-N, and the combination limits between FILTER and window functions. For the basic syntax (PARTITION BY/ORDER BY/frame defaults), see [Window Functions](./window-functions).

## LAG and LEAD: Values from Adjacent Rows

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

- `lag(column, offset, default)`: takes the row N positions before the current one; the offset defaults to 1 and the default value to NULL (the first row has no "previous day").
- `lead` goes the opposite way, taking the row N positions after; `lead(amount, 2)` means two days ahead, and the last two rows come out NULL.
- The WINDOW clause names a shared window definition once so several functions can reuse it, avoiding repeated long OVER clauses.

## The frame Trap with FIRST_VALUE and LAST_VALUE

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

- `first_amt` is always 100, which matches intuition.
- `last_wrong` always equals the current row's own amount: the default frame only extends to CURRENT ROW, so the "last row" is always yourself — this is the most frequent misuse in window functions.
- `last_right` extends the frame explicitly to UNBOUNDED FOLLOWING, giving the true partition final value (160 in this example).

## NTILE Bucketing

```sql
SELECT day, amount, ntile(2) OVER (ORDER BY amount) AS half
FROM daily_revenue;
```

6 rows split into 2 buckets: the first 3 rows in ascending amount order get `half = 1` and the last 3 get `half = 2`. When the row count does not divide evenly, the remainder is filled from the front: 7 rows in 4 buckets gives 2, 2, 2, 1. Typical uses are splitting stores into revenue quartiles and assigning users to activity tiers. Note that bucketing depends on the stability of ORDER BY; when the sort key is not unique, add a unique column (such as id) to keep results reproducible.

## ROWS Frames and Moving Averages

```sql
SELECT day, amount,
       round(avg(amount) OVER (ORDER BY day
             ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING), 1) AS ma3
FROM daily_revenue
ORDER BY day;
```

Taking day 2 as an example, the window contains the previous row, the current row, and the next row: (100+120+90)/3 = 103.3. At the edges the window shrinks automatically, so day 1 gets (100+120)/2 = 110.

Two easy confusions:

- ROWS takes the window by physical row count; RANGE takes it by the value of the sort key — `RANGE BETWEEN 1 PRECEDING AND 1 FOLLOWING` means "rows whose key value differs by at most 1," which is a completely different meaning from ROWS on date and amount columns. Do not mix them up.
- When days are missing from the data, a ROWS moving average simply skips the missing days and the average metric drifts. When you need calendar alignment, generate a date skeleton with generate_series first and then left join the business table onto it; see [LATERAL and FROM Subqueries](./lateral-and-from-subquery).

## Per-Group Top-N

```sql
CREATE TABLE staff_sales (
    id     int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    region text NOT NULL,
    seller text NOT NULL,
    amount numeric(10,2) NOT NULL
);

INSERT INTO staff_sales (region, seller, amount) VALUES
    ('North China', 'Zhang', 1200), ('North China', 'Li',    800), ('North China', 'Zhou',  950),
    ('East China',  'Wang',  2000), ('East China',  'Zhao',  1500), ('East China',  'Wu',    1100),
    ('South China', 'Qian',  900),  ('South China', 'Sun',   800);
```

Take the top 2 sellers by amount in each region:

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

- row_number cuts off cleanly, but breaks ties arbitrarily; to keep ties use `rank() <= 2` or `dense_rank() <= 2`, which yields more rows.
- When there are many groups and you only need a few rows at the head of each, LATERAL + LIMIT with a (region, amount DESC) index is often cheaper; for a comparison of the two approaches see [LATERAL and FROM Subqueries](./lateral-and-from-subquery).
- There is also a DISTINCT ON form for taking exactly one row per group; see [Conditional Expressions](./conditional-expressions).

## FILTER Cannot Be Combined with Window Functions

The FILTER clause for aggregates applies only to plain aggregates; attaching it to a window function is a syntax error. The equivalent rewrite uses CASE:

```sql
-- Plain aggregate + FILTER: works
SELECT region,
       count(*)    FILTER (WHERE amount > 1000) AS big_cnt,
       sum(amount) FILTER (WHERE amount > 1000) AS big_sum
FROM staff_sales
GROUP BY region;

-- Window aggregates do not support FILTER; rewrite equivalently with CASE
SELECT region, seller, amount,
       sum(CASE WHEN amount > 1000 THEN amount END)
           OVER (PARTITION BY region) AS big_sum
FROM staff_sales;
```

CASE returns NULL for non-matching rows, and aggregate functions ignore NULL automatically, so the semantics match FILTER.

## Caveats and Common Traps

- The default-value argument to lag/lead only fills "out-of-bounds" rows; it does not handle NULLs that already exist in the column, so settle the metric definition first before writing it.
- LAST_VALUE with a forgotten frame extension: the output "looks like it has values but they are all the current row." Check this first when hunting window bugs.
- When you need to filter or aggregate window results again, you cannot do it in WHERE/HAVING — wrap them in a CTE first (reason in [Window Functions](./window-functions)).
- A moving average's window width is a row count, not a number of days: when the business wants a "7-day average," days with missing data distort the metric, so fill in the calendar before opening the window.
- When a named WINDOW already contains an ORDER BY, an OVER that references it cannot add another ORDER BY — only frame clauses can be appended.

## References

- [PostgreSQL official documentation · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL official documentation · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Window Functions](./window-functions)
- [LATERAL and FROM Subqueries](./lateral-and-from-subquery)
- [Conditional Expressions](./conditional-expressions)
- [Pagination and Sorting](./pagination-and-sorting)
- [index](index.md)
- [lateral-and-from-subquery](lateral-and-from-subquery.md)
- [window-functions](window-functions.md)
Official documentation: [Window functions reference](https://www.postgresql.org/docs/current/functions-window.html), [Window functions tutorial](https://www.postgresql.org/docs/current/tutorial-window.html).
