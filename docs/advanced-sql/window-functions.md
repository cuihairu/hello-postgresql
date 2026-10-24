# Window Functions

Window functions perform cross-row computations without collapsing rows: aggregate window functions (sum, avg, count, and so on) and dedicated window functions (row_number, rank, lag, and so on) all declare through the OVER clause that they operate over a "window," and each row emits its own result while every detail row is preserved. That is the essential difference from GROUP BY, and it turns requirements like proportions, rankings, and running totals from "aggregate, then JOIN back to the details" into a single expression.

## The Three Parts of OVER

The sample data for this page; note that two ties were deliberately planted in amount:

```sql
CREATE TABLE sales_rows (
    id     int PRIMARY KEY,
    region text NOT NULL,
    seller text NOT NULL,
    amount numeric(10,2) NOT NULL
);

INSERT INTO sales_rows VALUES
    (1, 'North China', 'Zhang', 1200),
    (2, 'North China', 'Li',    800),
    (3, 'East China',  'Wang',  2000),
    (4, 'East China',  'Zhao',  2000),
    (5, 'South China', 'Qian',  900),
    (6, 'South China', 'Sun',   800);
```

`OVER (...)` has three parts, all of them optional:

```sql
SELECT id, region, seller, amount,
       count(*)    OVER (PARTITION BY region) AS region_orders,
       sum(amount) OVER (PARTITION BY region) AS region_total,
       round(amount / sum(amount) OVER (PARTITION BY region) * 100, 1) AS pct
FROM sales_rows
ORDER BY region, id;
```

- PARTITION BY: splits rows into partitions that are computed independently; when omitted, the whole table is one partition.
- ORDER BY: determines row order inside a partition; running-total and ranking functions depend on it; when omitted, row order carries no semantics.
- frame: slices a partition further into "a short stretch around the current row" for aggregation; default behavior is described below.

## Difference from GROUP BY: Row Count Unchanged

```sql
-- GROUP BY: details are collapsed, one row per region
SELECT region, sum(amount) AS total
FROM sales_rows
GROUP BY region;

-- Window: all 6 detail rows remain, each carrying the total of its partition
SELECT id, region, seller, amount,
       sum(amount) OVER (PARTITION BY region) AS region_total
FROM sales_rows;
```

For cases that need "details + summary" on screen at the same time (computing proportions, computing distance from the group average), the window form avoids the detour of aggregating and then JOINing back to the details. Conversely, when you only want the summary and not the details, GROUP BY is more direct and produces fewer rows.

## The Ranking Trio: ROW_NUMBER / RANK / DENSE_RANK

```sql
SELECT seller, amount,
       row_number() OVER (ORDER BY amount DESC) AS rn,
       rank()       OVER (ORDER BY amount DESC) AS rk,
       dense_rank() OVER (ORDER BY amount DESC) AS dr
FROM sales_rows;
```

In descending amount order the values are 2000, 2000, 1200, 900, 800, 800, and the three functions differ entirely in how they handle ties:

```plaintext
rn = 1 2 3 4 5 6    strictly increasing, ties still get distinct numbers
rk = 1 1 3 4 5 5    ties share a number, skipped ranks stay skipped
dr = 1 1 2 3 4 4    ties share a number, ranks stay contiguous
```

Selection intuition: use row_number when you want exactly N rows per group; use rank or dense_rank when tied ranks should all be kept (award every first place).

## frame: Default Behavior and the Running-Total Trap

Default frame rules:

- When OVER contains an ORDER BY, the frame is `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`, meaning from the first row of the partition to the current row; RANGE treats rows sharing the same sort key (peers) as a single unit.
- Without an ORDER BY, the frame is the entire partition.

The trap appears when sort keys repeat:

```sql
SELECT id, amount,
       sum(amount) OVER (ORDER BY amount) AS running_range,
       sum(amount) OVER (ORDER BY amount
                         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_rows
FROM sales_rows
ORDER BY amount, id;
```

- `running_range` (the default RANGE): the running total for the first row's 800 already includes the second row's 800 (straight to 1600); the two rows with 2000 show the full total of 7700 — at repeated keys the running value comes out too large and "jumps flat."
- `running_rows`: accumulates row by row by physical position, giving the expected series 800, 1600, 2500, 3700, 5700, 7700.

When writing ledgers or flows that require "strictly row-by-row accumulation," declare a ROWS frame explicitly. If the business semantics happen to be "equal values share the same running total," then the default RANGE is actually correct.

## Why You Cannot Use Window Functions in WHERE

In SQL's logical execution order, window functions come after FROM, WHERE, GROUP BY, and HAVING, and are allowed only in the SELECT output list and in ORDER BY. WHERE filters rows before window computation, so it naturally cannot see window results — writing one there is an error. The same holds for GROUP BY and HAVING.

The standard solution is to compute the window in a CTE or subquery first, then filter on the outside:

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

Likewise, to aggregate window results you must wrap them in an extra layer and then GROUP BY.

## Caveats and Common Traps

- When a ranking function's OVER has no ORDER BY, row_number's order is indeterminate and must not be used as a stable sequence number.
- The default RANGE frame running-total trap (above) is the most common metric error in flow-style queries; before writing a running total, ask yourself whether you need ROWS.
- Window functions cannot be nested (a window inside a window); when you need two levels of computation, split it into two CTEs and write it step by step.
- The ORDER BY inside OVER applies only to that window; only the final ORDER BY of the main query determines the output order — they are independent of each other.

## References

- [PostgreSQL official documentation · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL official documentation · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Window Functions in Depth](./window-functions-advanced)
- [Aggregates and GROUP BY](../basics/aggregate-and-group-by)
- [CTEs and Non-Recursive WITH](./cte-and-non-recursive-with)
- [Conditional Expressions](./conditional-expressions)
- [conditional-expressions](conditional-expressions.md)
- [index](index.md)
- [lateral-and-from-subquery](lateral-and-from-subquery.md)
- [window-functions-advanced](window-functions-advanced.md)
- [aggregate-and-group-by](/basics/aggregate-and-group-by.md)
Official documentation: [Window functions tutorial](https://www.postgresql.org/docs/current/tutorial-window.html), [Window functions reference](https://www.postgresql.org/docs/current/functions-window.html).
