# WHERE and Expressions

`WHERE` decides which rows take part in a query: the condition expression is evaluated for every row, rows that evaluate to `true` are kept, and `false` and `NULL` are both discarded. The syntax is not hard — nearly all the real traps come from NULL and three-valued logic. The operators below are grouped by class, and the examples run directly in psql.

## The example table

```sql
CREATE TABLE products (
    id       bigserial PRIMARY KEY,
    name     text NOT NULL,
    price    numeric(10,2) NOT NULL,
    category text,
    active   boolean DEFAULT true,
    remark   text
);

INSERT INTO products (name, price, category, active, remark) VALUES
    ('Keyboard', 199.00, 'Peripherals', true, 'Red switch'),
    ('Mouse', 129.00, 'Peripherals', true, NULL),
    ('Monitor', 1499.50, 'Bulky', false, NULL),
    ('Desk Mat', 39.90, NULL, true, 'Large'),
    ('Keycaps', 89.00, 'Peripherals', NULL, 'Transparent');
```

## Comparison operators

`=`, `<>` (or `!=`), `<`, `>`, `<=`, `>=` apply to comparable types such as numbers, strings, and times. String comparison follows the collation, and non-Latin sorting depends on the database's locale setting. Also remember one null-safe comparison operator, `IS DISTINCT FROM`: it treats NULL as an ordinary value in the comparison and always returns true or false:

```sql
SELECT 1 <> 2, 'a' < 'b';                    -- t, t
SELECT NULL = NULL, NULL IS NULL;            -- NULL, t
SELECT NULL IS DISTINCT FROM NULL;           -- f (equivalent to "equal if both are NULL")
```

## AND / OR / NOT and precedence

Precedence from highest to lowest is `NOT` > `AND` > `OR`. This means `a OR b AND c` really is `a OR (b AND c)`. When writing mixed conditions, add parentheses explicitly so the reader (including you three months from now) does not have to recall the precedence:

```sql
SELECT name FROM products
WHERE category = 'Peripherals' OR category = 'Bulky' AND price > 1000;
-- equivalent to category = 'Peripherals' OR (category = 'Bulky' AND price > 1000)

SELECT name FROM products
WHERE (category = 'Peripherals' OR category = 'Bulky') AND price > 1000;
-- almost always the form you actually want
```

## BETWEEN and IN

`BETWEEN a AND b` includes both endpoints (a closed interval); `IN` tests whether a value appears in a list or a subquery result.

```sql
SELECT name FROM products WHERE price BETWEEN 100 AND 500;      -- 199 and 129

SELECT name FROM products WHERE category IN ('Peripherals', 'Bulky');

SELECT name FROM products
WHERE category IN (SELECT category FROM products GROUP BY category HAVING count(*) >= 2);
```

`NOT IN` has a trap you must remember: if a single NULL appears in the list (or the subquery result), `NOT IN` returns NULL for every row, and the whole query comes back empty. See the NULL section below.

## LIKE / ILIKE and wildcards

`LIKE` does pattern matching: `%` matches any length of characters (including zero), `_` matches a single character; `ILIKE` ignores case. Use `ESCAPE` to escape the wildcards themselves.

```sql
SELECT name FROM products WHERE name LIKE 'Key%';       -- Keyboard, Keycaps
SELECT name FROM products WHERE name LIKE '%board%';
SELECT name FROM products WHERE remark ILIKE '%pg%';
SELECT '50%' LIKE '50\%' ESCAPE '\';                   -- t
```

Two things to note: when a pattern starts with `%` a B-tree index cannot be used, and on a large table this turns into a full table scan; `LIKE` suits simple prefix/contains matching, while complex search needs should go to full-text search or pg_trgm, see [Pattern Matching](../advanced-sql/pattern-matching) and [Full-text Search](../advanced-sql/full-text-search).

## NULL: IS NULL / IS NOT NULL, and why `= NULL` never holds

In SQL, `NULL` means "unknown": the result of comparing any value with NULL using `=` or `<>` is NULL, not true. And `WHERE` keeps only rows whose result is `true`, so:

```sql
SELECT count(*) FROM products WHERE remark = NULL;      -- 0, never matches
SELECT count(*) FROM products WHERE remark IS NULL;     -- 2, the correct form
SELECT count(*) FROM products WHERE remark IS NOT NULL; -- 3
```

Three-valued logic extends to compound conditions: `NULL AND false` is `false`, `NULL AND true` is `NULL`, `NULL OR true` is `true`. This gives the `NOT IN` conclusion at the start of this section: in `category NOT IN ('Peripherals', NULL)`, evaluating `'Desk Mat' NOT IN (...)` yields NULL rather than true, so the row is discarded — even though it plainly is not in the list. Use `IS NULL` when hunting down NULL-value problems, and `IS DISTINCT FROM` for null-safe equality.

## Boolean columns as conditions directly

A boolean column can be used as a condition without writing a comparison, and `NOT` negates it:

```sql
SELECT name FROM products WHERE active;          -- equivalent to active = true
SELECT name FROM products WHERE NOT active;
```

But watch whether the column is nullable: in the example table `active` is nullable, so `WHERE active` excludes both `false` rows and NULL rows at the same time. If you mean "not disabled" semantically, either make the column `NOT NULL DEFAULT true`, or write `WHERE active IS NOT FALSE` explicitly. With a `NOT NULL` constraint on the boolean column, writing `WHERE active` directly is the clearest expression of intent.

## A look at expression indexes

If a condition in `WHERE` can match an index, the scan is fast; but the planner only matches indexes of the same "shape". When you often query by `lower(email)`, an ordinary index on the `email` column does not help, and you need an expression index:

```sql
CREATE TABLE accounts (id bigserial PRIMARY KEY, email text NOT NULL);
CREATE INDEX accounts_email_lower_idx ON accounts (lower(email));

SELECT * FROM accounts WHERE lower(email) = 'a@example.com';  -- can use the index above
```

For full expression-index usage (including combining with a unique constraint for case-insensitive uniqueness) see [Expression Indexes](../indexing/expression-indexes); for which forms defeat an index, see [Index Failure and Misuse](../indexing/index-failure-and-misuse).

## Gotchas and common pitfalls

- `col = NULL` does not error but is never true — a silent logic bug that only code review and tests catch.
- Quote date literals and write them out in full when comparing: `WHERE created_at >= '2026-01-01'`; against a `timestamptz` the literal is interpreted in the session's time zone.
- Do not use `=` for equality on floating-point/`real` columns; use a range or `numeric`.
- An empty string `''` and NULL are two different things; `WHERE remark = ''` does not match NULL rows.

## References

- [PostgreSQL official documentation · Part I. Tutorial](https://www.postgresql.org/docs/current/tutorial.html)
- [PostgreSQL official documentation · The SQL Language](https://www.postgresql.org/docs/current/sql.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Functions and Operators](./functions-and-operators)
- [Pattern Matching](../advanced-sql/pattern-matching)
- [Expression Indexes](../indexing/expression-indexes)
- [Index Failure and Misuse](../indexing/index-failure-and-misuse)
- [conditional-expressions](/advanced-sql/conditional-expressions.md)
- [aggregate-and-group-by](aggregate-and-group-by.md)
- [crud-and-on-conflict](crud-and-on-conflict.md)
- [functions-and-operators](functions-and-operators.md)
- [index](index.md)
Official documentation: [Comparison functions and operators](https://www.postgresql.org/docs/current/functions-comparison.html), [Pattern matching](https://www.postgresql.org/docs/current/functions-matching.html).
