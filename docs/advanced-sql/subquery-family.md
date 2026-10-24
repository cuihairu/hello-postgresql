# The Subquery Family

A subquery is a SELECT nested inside another SQL statement. By position it falls into two families: those written inside WHERE/SELECT expressions (scalar, IN, EXISTS, ANY/ALL) and those written in FROM (derived tables). The writing style nests layer upon layer, but the optimizer does not always "compute the inner part first, then the outer part" — most subqueries get rewritten into a join or a plan that is evaluated once. This page catalogues the family members, sorts out the NULL semantic difference between IN and EXISTS, which forms the optimizer can flatten and which it cannot, and how to verify with EXPLAIN.

## Sample Tables

```sql
CREATE TABLE departments (
    dept_id int PRIMARY KEY,
    name    text NOT NULL
);

CREATE TABLE employees (
    id      int PRIMARY KEY,
    name    text NOT NULL,
    dept_id int REFERENCES departments(dept_id),
    salary  numeric(10,2) NOT NULL
);

INSERT INTO departments VALUES (1, 'Engineering'), (2, 'Sales'), (3, 'HR');

INSERT INTO employees VALUES
    (1, 'GM Zhang', 1, 30000),
    (2, 'Li',       1, 20000),
    (3, 'Wang',     1, 18000),
    (4, 'Zhao',     2, 15000),
    (5, 'Qian',     2, 12000),
    (6, 'Sun',      NULL, 9000);   -- an employee with no department, dedicated to demonstrating NULL semantics
```

## Scalar Subqueries: At Most One Value

A scalar subquery appears in an expression position and must return at most one row and one column: when the result is empty the whole expression takes NULL, and more than one row is an immediate error, `more than one row returned by a subquery used as an expression`.

```sql
-- Company-wide average salary (not correlated with the outer query; computed once for the whole statement)
SELECT name, salary,
       round(salary / (SELECT avg(salary) FROM employees), 2) AS ratio
FROM employees;

-- Employees paid above the company-wide average
SELECT name, salary
FROM employees
WHERE salary > (SELECT avg(salary) FROM employees);
```

"At most one row" has to be guaranteed by the subquery's own semantics: aggregate functions return exactly one row by nature; an ordinary query needs a uniqueness condition or LIMIT 1 as a backstop, otherwise once the data grows it turns from an occasional hiccup into a production incident.

## IN and EXISTS: NULL Is the Divide

IN treats the subquery result as a value list and compares element by element; EXISTS only cares whether the subquery returns at least one row (the SELECT list does not affect the result, so `SELECT 1` is idiomatic):

```sql
-- IN: element-wise equality comparison, returning Engineering and Sales; NULLs in the subquery do not affect a positive IN
SELECT name FROM departments
WHERE dept_id IN (SELECT dept_id FROM employees);

-- EXISTS: probes existence row by row, same result
SELECT name FROM departments d
WHERE EXISTS (SELECT 1 FROM employees e WHERE e.dept_id = d.dept_id);
```

In positive queries IN and EXISTS are semantically equivalent; NULL at worst just leads to "no match." The divide is in the negated forms. `x NOT IN (list)` is equivalent to an AND of "x is not equal to every value in the list" — as soon as one NULL sits in the list, `x <> NULL` is unknown and the whole AND can never be true, so the query returns an empty set:

```sql
-- Meant as "departments with no employees," but actually returns 0 rows: the subquery result contains a NULL (Sun)
SELECT name FROM departments
WHERE dept_id NOT IN (SELECT dept_id FROM employees);

-- NOT EXISTS is not affected by NULL and correctly returns HR
SELECT name FROM departments d
WHERE NOT EXISTS (SELECT 1 FROM employees e WHERE e.dept_id = d.dept_id);
```

Conclusion: always write NOT EXISTS for negative existence checks. `<> ALL (subquery)` has the same semantics as NOT IN and shares this trap.

## ANY / ALL / SOME

ANY (SOME is a synonym for it) means "true when compared against any one value in the list," and ALL means "true against every value in the list":

```sql
-- Above any one person in Sales (dept_id=2) = above their minimum salary of 12000 -> 4 rows
SELECT name, salary FROM employees
WHERE salary > ANY (SELECT salary FROM employees WHERE dept_id = 2);

-- Above everyone in Sales = above their maximum salary of 15000 -> 3 rows
SELECT name, salary FROM employees
WHERE salary > ALL (SELECT salary FROM employees WHERE dept_id = 2);
```

The array form `= ANY (ARRAY[1, 3, 5])` is often used as a substitute for a long OR list and is equivalent to IN. Three-valued logic applies here too: once a NULL is mixed into a `> ALL` list, the result can only be false or NULL and never true; `<> ALL` is exactly the NOT IN trap. When the list may contain NULLs, filter with `WHERE col IS NOT NULL` inside the subquery first.

## Correlated Subqueries

A subquery that references outer columns is a correlated subquery, which conceptually executes once for every outer row. A classic use is "the extreme value within each group":

```sql
-- The highest-paid employee in each department
SELECT e.name, e.dept_id, e.salary
FROM employees e
WHERE e.salary = (SELECT max(salary) FROM employees e2
                  WHERE e2.dept_id = e.dept_id)
ORDER BY e.dept_id;
```

Sun's dept_id is NULL, so `e2.dept_id = NULL` inside the subquery never matches and he does not appear in the result — another appearance of three-valued logic. If the business needs to account for employees without a department, handle them explicitly and separately.

## Derived Tables: Subqueries in FROM

```sql
-- Departments whose average salary exceeds the company-wide average
SELECT d.name, s.avg_salary
FROM departments d
JOIN (SELECT dept_id, avg(salary) AS avg_salary
      FROM employees
      GROUP BY dept_id) s ON s.dept_id = d.dept_id
WHERE s.avg_salary > (SELECT avg(salary) FROM employees);
```

By convention give a derived table a short alias (from PG 16 the alias may be omitted, but writing it explicitly reads better). The "aggregate first, then JOIN" form also sidesteps the problem of "counts inflating after a one-to-many JOIN." A derived table with LATERAL can additionally reference columns from the left; see [LATERAL and FROM Subqueries](./lateral-and-from-subquery).

## How the Optimizer Handles Subqueries

The writing style is nested, but execution need not be. The optimizer mainly does two kinds of rewriting:

- **Flattening (pull-up)**: subqueries that do not reference the outer query, and derived tables that can be merged safely, are folded into the outer query; the final plan is identical to one written by hand as a join.
- **Decorrelation (subquery unlinking)**: EXISTS/IN is converted to a Semi Join, NOT EXISTS to an Anti Join; for correlated scalar subqueries that cannot be rewritten, a SubPlan node executes them row by row, and for equality correlation a hash cache of the parameters reduces redundant computation.

This capability has been strengthened progressively since PG 8.x (8.4 introduced the semi-join/anti-join implementation, and the convertible forms have kept expanding since), so "subqueries are always slower than a hand-written JOIN" is largely outdated advice on modern versions — look at the plan before drawing a conclusion.

Forms that cannot be pulled apart usually cannot, because rewriting would change the semantics:

- **LIMIT / OFFSET**: "the first N rows" has no equivalent join form, so the subquery stays as it is.
- **volatile functions or calls with side effects** (`random()`, `nextval()`, functions declared VOLATILE): they must be genuinely evaluated row by row and can be neither precomputed nor cached.
- **Correlated subqueries containing aggregates such as COUNT**: converting them to a join would change the row count, so they run only as SubPlans row by row, which easily degrades into "one scan per row" on large tables.
- **IN/EXISTS appearing inside an OR branch**: they cannot enter the join tree and fall back to SubPlan form (when uncorrelated, a hashed SubPlan caches the result).
- **NOT IN whose subquery column may be NULL**: it cannot become an anti-join (anti-join's NULL semantics differ from NOT IN's), and it is both slow and trap-laden — rewrite it as NOT EXISTS.

## Using EXPLAIN to Check Whether It Was Flattened

One of the most useful readings in [how to read EXPLAIN](../performance/explain-basics): look for InitPlan / SubPlan nodes in the plan.

After EXISTS is converted to a semi-join it is a flat join with no SubPlan:

```plaintext
EXPLAIN SELECT name FROM departments d
WHERE EXISTS (SELECT 1 FROM employees e WHERE e.dept_id = d.dept_id);

            QUERY PLAN
-----------------------------------
 Hash Semi Join
   Hash Cond: (d.dept_id = e.dept_id)
   ->  Seq Scan on departments d
   ->  Hash
         ->  Seq Scan on employees e
```

An uncorrelated scalar subquery becomes an InitPlan, shaped like `InitPlan 1 (returns $0)`; it is computed once for the whole query, and the outer `Filter: (salary > $0)` references its result as a parameter.

LIMIT blocks the rewrite, so the scalar subquery stays a SubPlan and the outer query executes it once per row:

```plaintext
EXPLAIN SELECT d.name,
       (SELECT e.name FROM employees e
        WHERE e.dept_id = d.dept_id
        ORDER BY e.salary DESC LIMIT 1) AS top_earner
FROM departments d;

        QUERY PLAN
---------------------------
 Seq Scan on departments d
   SubPlan 1
     ->  Limit
           ->  Sort
                 Sort Key: e.salary DESC
                 ->  Seq Scan on employees e
                       Filter: (dept_id = d.dept_id)
```

How to read it: `InitPlan` = computed once, nothing to worry about; `SubPlan` = executed row by row (or cached per parameter), so when the outer row count is large, prefer rewriting it into a join; neither present and only Semi/Anti/plain joins = already flattened. Compare actual timing before and after with `EXPLAIN ANALYZE`; see [EXPLAIN ANALYZE and BUFFERS](../performance/explain-analyze-buffers).

## Caveats and Common Traps

- A scalar subquery returning multiple rows errors out: switch to an aggregate, add a uniqueness condition, or use LIMIT 1 — do not gamble on the data volume.
- NOT IN meeting a nullable column = the empty-result trap; always write NOT EXISTS.
- An ORDER BY inside a subquery without LIMIT is meaningless (the sorted result gets discarded while still wasting CPU); write the ordering on the outside.
- When a correlated subquery appears in an OR branch or inside an aggregate, decorrelation frequently fails; for complex queries, EXPLAIN first to confirm the shape.
- From PG 12, CTEs are inlined and flattened by default (behavior matching derived tables); add MATERIALIZED when you need an optimization barrier. See [CTEs and Non-Recursive WITH](./cte-and-non-recursive-with).

## References

- [PostgreSQL official documentation · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL official documentation · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- Subtree overview: [Advanced SQL](/advanced-sql/)

- [Reading EXPLAIN](../performance/explain-basics)
- [LATERAL and FROM Subqueries](./lateral-and-from-subquery)
- [CTEs and Non-Recursive WITH](./cte-and-non-recursive-with)
- [The JOIN Family](../basics/join-family)
- [cte-and-non-recursive-with](cte-and-non-recursive-with.md)
- [index](index.md)
- [lateral-and-from-subquery](lateral-and-from-subquery.md)
- [common-beginner-mistakes](/basics/common-beginner-mistakes.md)
Official documentation: [Subquery expressions](https://www.postgresql.org/docs/current/sql-expressions.html), [Subquery expressions](https://www.postgresql.org/docs/current/sql-expressions.html).
