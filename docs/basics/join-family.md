# The JOIN Family

JOIN stitches rows from two tables together according to a join condition, and the family members differ by "what happens to rows that do not match": INNER keeps only rows matched on both sides, LEFT/RIGHT/FULL additionally keep unmatched left-table, right-table, and both sides' unmatched rows (filling the missing side with NULL), while CROSS does no matching at all and emits every combination. This page demonstrates each JOIN with an employee-department example, and focuses on two common real-world error patterns.

## The example tables

```sql
CREATE TABLE departments (
    dept_id int PRIMARY KEY,
    name    text NOT NULL
);

CREATE TABLE employees (
    id         int PRIMARY KEY,
    name       text NOT NULL,
    dept_id    int REFERENCES departments(dept_id),
    manager_id int REFERENCES employees(id)
);

INSERT INTO departments VALUES (1, 'R&D'), (2, 'Sales'), (3, 'HR');

INSERT INTO employees VALUES
    (1, 'Zhang', 1, NULL),
    (2, 'Li', 1, 1),
    (3, 'Wang', 1, 2),
    (4, 'Zhao', 2, 1),
    (5, 'Qian', NULL, 1);   -- no department assigned
```

The data hides two sources of "no match": employee Qian has no department, and the HR department has no employees.

## INNER / LEFT / RIGHT / FULL

```sql
-- INNER: only the 4 employees who have a department; Qian and the HR department do not appear
SELECT e.name AS employee, d.name AS dept
FROM employees e
JOIN departments d ON e.dept_id = d.dept_id;

-- LEFT: the whole left table is kept, Qian's dept is NULL (5 rows total)
SELECT e.name AS employee, d.name AS dept
FROM employees e
LEFT JOIN departments d ON e.dept_id = d.dept_id;

-- RIGHT: the whole right table is kept, the HR department's employee is NULL
SELECT e.name AS employee, d.name AS dept
FROM employees e
RIGHT JOIN departments d ON e.dept_id = d.dept_id;

-- FULL: unmatched rows on both sides are kept
SELECT e.name AS employee, d.name AS dept
FROM employees e
FULL JOIN departments d ON e.dept_id = d.dept_id;
```

`LEFT JOIN ... WHERE right_table.key IS NULL` is the common anti-join form, used to find "rows with no match at all", such as finding departments with no employees:

```sql
SELECT d.name
FROM departments d
LEFT JOIN employees e ON e.dept_id = d.dept_id
WHERE e.id IS NULL;      -- HR
```

Practical advice: standardize on LEFT/INNER for everyday modeling (a RIGHT JOIN can always be rewritten as a LEFT JOIN with the table order swapped, and mixing both directions in one team hurts readability).

## CROSS JOIN

No `ON` clause, and the output is the Cartesian product of the two tables (M x N rows). A legitimate use is generating combinations, such as a skeleton table of "every store x every month" that you then LEFT JOIN the real data onto; the row count multiplies, so use it carefully on large tables.

```sql
SELECT d.name AS dept, e.name AS employee
FROM departments d CROSS JOIN employees e;   -- 3 x 5 = 15 rows
```

## USING and NATURAL

When the join columns of the two tables share a name, `USING` is terser than `ON` and emits only one such column:

```sql
SELECT e.name AS employee, d.name AS dept, dept_id
FROM employees e JOIN departments d USING (dept_id);
```

Compared with the `ON` form, `dept_id` appears only once in the result; a column named in `USING` cannot be referenced again with a table prefix. It requires columns of the same name and type on both sides of the JOIN, otherwise you get `column referenced in USING clause not found in any FROM item`.

`NATURAL JOIN` is the fully automatic version of `USING`: every same-named column in the two tables becomes a join condition. The danger is that adding a same-named column to a table (such as `updated_at`) silently changes the JOIN's meaning. In production code, writing the join condition explicitly is more reliable than relying on coincidental same-named columns.

## Self-join: the employee-manager table

The same table joined with itself, with aliases telling the two roles apart. In employees, `manager_id` points back at the table's own `id`, and to find "each person together with their manager":

```sql
SELECT e.name AS employee, m.name AS manager
FROM employees e
LEFT JOIN employees m ON e.manager_id = m.id
ORDER BY e.id;

-- employee | manager
-- Zhang    | NULL (no superior, LEFT JOIN keeps this row)
-- Li       | Zhang
-- Wang     | Li
```

LEFT JOIN is required here: INNER would drop the whole row for employees with no manager (Zhang). To walk the entire reporting chain recursively you need a recursive CTE, see [Recursive CTEs](../advanced-sql/recursive-cte).

## Common mistakes with JOIN + aggregation

**Mistake one: a right-table condition written in WHERE turns the LEFT JOIN into an INNER JOIN.** When filtering the right side of a LEFT JOIN, putting the condition in `ON` versus `WHERE` gives entirely different results:

```sql
-- wrong: WHERE applies to the JOIN result, so Qian (dept NULL) is filtered out
SELECT e.name, d.name AS dept
FROM employees e
LEFT JOIN departments d ON e.dept_id = d.dept_id
WHERE d.name = 'R&D';

-- correct: the condition goes in ON, so right-table non-matches stay as NULL
SELECT e.name, d.name AS dept
FROM employees e
LEFT JOIN departments d
  ON e.dept_id = d.dept_id AND d.name = 'R&D';
```

"Filter first, then join" is exactly what putting the condition in ON or in a subquery expresses; putting it in WHERE is "join, then filter", and the LEFT semantics disappear with it.

**Mistake two: aggregating straight after a one-to-many JOIN inflates counts and sums.** The departments table LEFT JOINed to the employees table is one-to-many, and `count(*)` counts the "department with no employees" as 1 row:

```sql
-- wrong: HR shows count = 1 (from the NULL-filled row)
SELECT d.name, count(*) AS headcount
FROM departments d
LEFT JOIN employees e ON e.dept_id = d.dept_id
GROUP BY d.name;

-- correct: count a left-table column, so unmatched rows count as 0
SELECT d.name, count(e.id) AS headcount
FROM departments d
LEFT JOIN employees e ON e.dept_id = d.dept_id
GROUP BY d.name;
```

The same inflation shows up in sums: after joining the orders table to the order-items table, `sum(order_amount)` accumulates once per item row; the correct approach is to aggregate by order in a subquery first, then JOIN. The rule in one sentence: **after a one-to-many JOIN, any count or sum over a column of the "one" side must be aggregated before the JOIN**.

## JOIN order and the optimizer

In SQL the written order of JOINs (except for outer joins) does not decide execution order; the optimizer reorders inner joins based on statistics and picks implementations such as Nested Loop, Hash Join, or Merge Join. When tuning, look at the execution plan rather than mechanically reshuffling table order, see [JOIN Implementations](../internals/join-implementations) and [How to Read EXPLAIN](../performance/explain-basics).

## Gotchas and common pitfalls

- After joining many tables you get `column reference is ambiguous`: a same-named column lacks a table prefix, so qualify every output column.
- Both sides of a `FULL JOIN` can produce NULL-filled rows, so output keys are usually normalized with `coalesce(a.key, b.key)`.
- Outer joins limit how freely the optimizer can reorder; when plans with nested outer joins degrade, check whether OUTER is really needed.
- A LEFT JOIN can return more rows than the left table (one-to-many), so run `EXPLAIN` before assuming it de-duplicates.

## References

- [PostgreSQL official documentation · Part I. Tutorial](https://www.postgresql.org/docs/current/tutorial.html)
- [PostgreSQL official documentation · The SQL Language](https://www.postgresql.org/docs/current/sql.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Aggregation and GROUP BY](./aggregate-and-group-by)
- [JOIN Implementations](../internals/join-implementations)
- [Foreign Keys and Referential Actions](../database-design/foreign-keys-and-referential-actions)
- [LATERAL and FROM Subqueries](../advanced-sql/lateral-and-from-subquery)
- [subquery-family](/advanced-sql/subquery-family.md)
- [aggregate-and-group-by](aggregate-and-group-by.md)
- [index](index.md)
Official documentation: [Join queries documentation](https://www.postgresql.org/docs/current/tutorial-join.html), [FROM and JOIN full syntax](https://www.postgresql.org/docs/current/queries-table-expressions.html).
