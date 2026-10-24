# Set Operations

UNION, UNION ALL, INTERSECT, and EXCEPT combine the results of two SELECTs under set rules: deduplicating union, non-deduplicating union, intersection, and difference. Their division of labor versus JOIN is this — JOIN associates rows horizontally by columns, while set operations stack result sets vertically by rows, requiring the same number of columns on both sides and compatible types at each position. This page records the semantics, the cost of deduplication, and the easiest-to-mistake ordering position and NULL behavior.

## Semantics of the Four Operations

```sql
CREATE TABLE list_2025 (email text);
CREATE TABLE list_2026 (email text);

INSERT INTO list_2025 VALUES ('a@x.com'), ('b@x.com'), ('c@x.com'), (NULL);
INSERT INTO list_2026 VALUES ('b@x.com'), ('c@x.com'), ('d@x.com'), (NULL);
```

```sql
SELECT email FROM list_2025
UNION SELECT email FROM list_2026;      -- a, b, c, d, NULL: 5 rows after dedup

SELECT email FROM list_2025
UNION ALL SELECT email FROM list_2026;  -- all 8 rows as-is

SELECT email FROM list_2025
INTERSECT SELECT email FROM list_2026;  -- b, c, NULL

SELECT email FROM list_2025
EXCEPT SELECT email FROM list_2026;     -- a (NULL exists on both sides, gets subtracted)
```

Quick reference:

- UNION: union then deduplicate; UNION ALL does not deduplicate.
- INTERSECT: values that appear on both sides (after dedup).
- EXCEPT: values present on the left and absent on the right (after dedup); `A EXCEPT B` generally differs from `B EXCEPT A`.
- All three operations have multiset counterparts: `UNION ALL`, `INTERSECT ALL`, `EXCEPT ALL` (union/intersection/difference by duplicate count); the latter two are rarely used.

## ALL and the Cost of Deduplication

UNION, INTERSECT, and EXCEPT without ALL must deduplicate, which usually shows up in the plan as Sort + Unique or HashAggregate. Memory and temp-disk overhead scale with input size, and the sorting variant is O(n log n); UNION ALL only concatenates and is the cheapest.

Rules of thumb:

- When neither side has duplicates on its own (for example each is filtered by primary key) or the business tolerates duplicates: use UNION ALL directly, and handle uniqueness uniformly on the outside if needed.
- Do not force UNION ALL just to save a sort in scenarios that genuinely need dedup; duplicate rows will pollute downstream statistics.
- INTERSECT/EXCEPT have no non-deduplicating default variant, so narrow each side's scope with filters before the operation; do not take a difference between two full tables.

## Column Count and Type Compatibility

```sql
SELECT 1, 'a'
UNION
SELECT 2.5, 'b';      -- fine: column 1 is unified as numeric

SELECT 1, 'a'
UNION
SELECT 'x', 2;        -- error: column 1 has no common type between integer and text
```

Rules:

- The two SELECTs must have the same number of columns, aligned by position; column names do not participate in matching.
- Each column's types must resolve to a common type; when they cannot, it is an immediate error.
- The result's column names come from the first SELECT; aliases on later SELECTs are ignored.

## Precedence, Parentheses, and Ordering Position

- INTERSECT binds tighter than UNION and EXCEPT; UNION and EXCEPT have the same precedence and associate left to right, so `A UNION B INTERSECT C` equals `A UNION (B INTERSECT C)`. Do not rely on remembering this — always add parentheses when mixing them.
- ORDER BY and LIMIT may appear only after the final SELECT and apply to the whole result; placing them in the middle is a syntax error, and an ORDER BY inside one of the SELECTs has no effect on the final result.

EXCEPT's associativity is a classic trap. For example, to find "values that appear on only one side" (the symmetric difference), you must parenthesize each EXCEPT:

```sql
(SELECT email FROM list_2025
 EXCEPT
 SELECT email FROM list_2026)
UNION ALL
(SELECT email FROM list_2026
 EXCEPT
 SELECT email FROM list_2025)
ORDER BY email;        -- a, d
```

Without the parentheses the statement parses as `((A EXCEPT B) UNION ALL C) EXCEPT D`, which is a different result.

## Finding Different Rows with EXCEPT

EXCEPT compares whole rows and treats NULLs as equal to each other — consistent with DISTINCT and GROUP BY, and unlike `=` in WHERE. That makes it a sharp tool for comparing two structurally identical tables, for example validating new and old snapshots after a data migration:

```sql
CREATE TABLE products_old (id int, name text, price numeric(10,2));
CREATE TABLE products_new (id int, name text, price numeric(10,2));

INSERT INTO products_old VALUES
    (1, 'Keyboard', 199.00), (2, 'Mouse', 99.00), (3, 'Monitor', 1299.00);
INSERT INTO products_new VALUES
    (1, 'Keyboard', 219.00), (2, 'Mouse', 99.00), (4, 'Desk Pad', 39.00);
```

```sql
-- Rows added to or changed in the new table
SELECT * FROM products_new
EXCEPT
SELECT * FROM products_old;
-- (1, Keyboard, 219.00), (4, Desk Pad, 39.00)

-- Rows missing from or changed in the old table
SELECT * FROM products_old
EXCEPT
SELECT * FROM products_new;
-- (1, Keyboard, 199.00), (3, Monitor, 1299.00)
```

How to read it: id=1 appears in both directions, which means it is a "changed row"; appearing in only one direction means a pure insert or a pure delete. Even if price contains NULLs, EXCEPT still aligns whole rows, whereas `NOT IN` and `<>` joins both fail on NULL.

## Caveats and Common Traps

- Wanting to sort one of the SELECTs inside a UNION and then merge: impossible; only the final ORDER BY counts. When you need ordering within a branch, wrap each branch in a numbered subquery first.
- The result's column names come from the first SELECT: aliases on the second do not take effect, so do not reference them in docs or code.
- A positionally shifted type that "happens to be compatible" will not error but is semantically wrong (for example mapping id onto amount); recheck set operations after any column-order change.
- The non-UNION ALL set operations are all heavyweight; when you see lots of Sort/HashAggregate in monitoring, first check whether an unnecessary UNION is the cause.

## References

- [PostgreSQL official documentation · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL official documentation · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Recursive CTEs](./recursive-cte)
- [Aggregates and GROUP BY](../basics/aggregate-and-group-by)
- [Conditional Expressions](./conditional-expressions)
- [EXPLAIN basics](../performance/explain-basics)
- [index](index.md)
- [recursive-cte](recursive-cte.md)
Official documentation: [Combining queries (UNION, INTERSECT, EXCEPT)](https://www.postgresql.org/docs/current/queries-union.html), [SELECT syntax](https://www.postgresql.org/docs/current/sql-select.html).
