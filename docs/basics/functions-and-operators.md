# Functions and Operators

Functions and operators are reusable units of computation in SQL. Operators are mostly built-in syntax (`+`, `= ANY`, `@>`), while functions are callable named logic (`lower()`, `date_part()`). Both can be used in `SELECT`, `WHERE`, `ORDER BY`, and `UPDATE SET`, and both can be registered as custom functions for later SQL to reuse. This page first gives a quick tour of common functions and the type-cast syntax, adds minimal runnable custom-function examples from `LANGUAGE sql` up to PL/pgSQL, and finishes by explaining why the `VOLATILE/STABLE/IMMUTABLE` markings affect the execution plan.

## Common string functions

String functions are the most-used group in everyday queries. Almost all of them return `NULL` for a `NULL` argument (rather than an empty string), which differs from MySQL's `CONCAT` behavior:

```sql
SELECT length('hello')            AS len,   -- 5
       upper('hello')             AS up,    -- HELLO
       lower('HELLO')             AS low,   -- hello
       trim('  hi  ')             AS trimmed,
       ltrim('  hi  ')            AS l,     -- left spaces only
       replace('a-b-c', '-', '_') AS rep,   -- a_b_c
       split_part('a-b-c', '-', 2) AS p2,   -- b
       left('abcdefgh', 3)        AS l3;    -- abc
```

Regular expressions and pattern matching are a PostgreSQL strength, and operators read better than nested functions:

```sql
SELECT 'abc123' ~ '^abc'          AS regex_match,   -- true
       'abc123' ~* 'ABC'          AS regex_ic,      -- case-insensitive match
       'abc123' !~ '^abc'         AS not_match,
       'abc123' ~ '.*[0-9]$'      AS ends_digit,
       'abc123' SIMILAR TO 'a%'   AS like_similar,  -- the SQL-standard LIKE, enhanced
       regexp_matches('a1b2c3', '([a-z])([0-9])')   AS matches;
```

`split_part`, `regexp_matches`, `regexp_replace` are the three-piece set for cleaning dirty data. Official reference: [String functions and operators](https://www.postgresql.org/docs/current/functions-string.html).

## Common numeric functions

```sql
SELECT round(3.14159, 2)     AS r2,      -- 3.14
       trunc(3.9)            AS t,       -- 3 (truncated)
       floor(3.9)            AS f,       -- 3
       ceil(3.1)             AS c,       -- 4
       greatest(1, 5, 3)     AS g,       -- 5
       least(1, 5, 3)        AS l,       -- 1
       power(2, 10)          AS p,       -- 1024
       sqrt(144)             AS s,       -- 12
       random()              AS rnd,     -- 0..1
       abs(-42)              AS a,
       mod(10, 3)            AS m,       -- 1
       width_bucket(5, 0, 10, 4) AS bucket;  -- bucketing, often used in reports
```

`round(numeric)` rounds half-values "away from zero" (ordinary rounding), not banker's rounding: `round(2.5::numeric) = 3` and `round(-2.5::numeric) = -3`. But the half-value handling of `round(double precision)` depends on the platform (most platforms use round-half-to-even, so `round(2.5::double precision)` often gives 2) — the same literal can produce different results depending on its type. For anything involving money, use `numeric`, see [Money and Numeric Types](../database-design/money-and-numeric).

## Common date and time functions

```sql
SELECT now()                              AS ts,
       current_date                       AS d,
       date_trunc('day', now())           AS day,
       date_trunc('month', now())         AS month,
       date_part('hour', now())           AS h,      -- extract the hour
       extract(year FROM now())           AS y,      -- equivalent form
       now() AT TIME ZONE 'Asia/Shanghai' AS local,
       ('2026-10-12')::date + interval '7 days' AS week,
       age('1990-01-01')                  AS age_out,
       date_part('epoch', now())          AS epoch,  -- seconds since 1970
       to_char(now(), 'YYYY-MM-DD HH24:MI:SS') AS fmt;
```

`date_trunc` and `date_part` represent two different orientations: the former truncates a time to the boundary at a given granularity, the latter extracts only a component. Using the two together is the core technique for reports and time windows; the full reference is [Date/Time functions](https://www.postgresql.org/docs/current/functions-datetime.html).

## Type casts: `::` and `CAST`

PostgreSQL offers two forms, completely equivalent in effect:

```sql
SELECT '42'::int                 AS a,      -- 42
       CAST('42' AS integer)     AS b,      -- 42
       '2026-10-12'::date        AS d,
       '1.5'::numeric(10,2)      AS n,
       'abc'::text::jsonb        AS j,      -- text first, then jsonb
       '42'::bigint::int         AS round_trip;
```

`::` is PostgreSQL's extended form, terse and suited to interactive use; `CAST(... AS ...)` is the SQL standard, which helps code that may migrate between databases. Two things to note:

- Implicit conversion from string to integer happens **only in an expression context** (such as `WHERE id = '1'`); `SELECT '1'` returns the string as-is and is not automatically turned into an integer.
- A failure raises an error rather than returning `NULL`. When you need to tolerate dirty data, use `NULLIF` plus `try_cast` (PG has no `TRY_CAST`, so you must write your own function or rely on `dblink` / a PL/pgSQL `EXCEPTION` block), see [Common Beginner Mistakes](./common-beginner-mistakes).

## `COALESCE` / `NULLIF` / `GREATEST` / `LEAST`

These four are the standard four-piece set for "pick one from several values":

```sql
SELECT COALESCE(NULL, NULL, 'fallback')        AS coalesce,  -- first non-NULL
       COALESCE(1, 2, 3)                   AS coalesce2, -- 1
       NULLIF('', '')                      AS nif_empty, -- NULL (NULL if equal)
       NULLIF('a', 'b')                    AS nif_diff,  -- a
       GREATEST(1, 5, 3)                   AS g,
       LEAST(1, 5, 3)                      AS l;
```

Real-world uses: normalize empty strings to `NULL`, supply a default for missing fields, and pick the best value among several columns by business rule.

```sql
-- treat an empty string as missing, and fall back to a default when missing
UPDATE users
SET   email = COALESCE(NULLIF(email, ''), 'nobody@example.com'),
      age   = GREATEST(LEAST(age, 120), 0)   -- clamp to [0,120]
WHERE age IS NOT NULL;
```

## SQL-language functions: a minimal example

The simplest custom function uses `LANGUAGE sql`, where the body is just one SQL statement. `CREATE FUNCTION` is executed by a privilege-limited role (see [Roles and Permissions](../security/roles-and-permissions)):

```sql
-- return money to two decimals, NULL-safe
CREATE OR REPLACE FUNCTION money_round(v numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE                          -- same inputs always give the same output, and can be indexed
AS $$
  SELECT COALESCE(round(v, 2), 0);
$$;

SELECT money_round(3.14159), money_round(NULL);
```

If a function modifies data, or its return value depends on state outside the current transaction, it cannot be marked `IMMUTABLE`; see the next section.

## PL/pgSQL basics

PL/pgSQL is PostgreSQL's bundled procedural language, with variables, flow control, and exception handling — the workhorse for complex business logic. Minimal example:

```sql
-- deduct from a user's balance; return false if insufficient, rolling back within the transaction
CREATE OR REPLACE FUNCTION deduct(uid int, amt numeric)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  cur numeric;
BEGIN
  SELECT balance INTO cur FROM accounts WHERE id = uid;
  IF cur IS NULL THEN
    RAISE EXCEPTION 'account % does not exist', uid;
  END IF;
  IF cur < amt THEN
    RETURN false;
  END IF;
  UPDATE accounts SET balance = balance - amt WHERE id = uid;
  RETURN true;
END;
$$;

-- business table + data
CREATE TABLE accounts (id int PRIMARY KEY, balance numeric(12,2));
INSERT INTO accounts VALUES (1, 100), (2, 10);

SELECT deduct(1, 30);   -- true
SELECT * FROM accounts WHERE id = 1;  -- balance = 70
SELECT deduct(2, 30);   -- false (insufficient balance)
SELECT * FROM accounts WHERE id = 2;  -- balance is still 10
```

Key points: `DECLARE ... BEGIN ... END` wraps the variable declarations and the statement body; `SELECT ... INTO` reads a query result into a variable; `RAISE EXCEPTION` makes the function raise an error; `RETURNS SETOF xxx` can return multiple rows (using `RETURN QUERY` or `RETURN NEXT`). For the full function feature set plus `RETURNS SETOF`, cursors, and triggers, see [Advanced SQL Functions](../advanced-sql/sql-functions-advanced).

## VOLATILE / STABLE / IMMUTABLE markings

Functions carry one of three volatility markings, and they **directly affect whether the optimizer can reuse a result**:

- `IMMUTABLE`: the same inputs always give the same result, with no dependence on state outside the database. The optimizer will do constant folding, index the expression, and push the function expression down into subqueries. Examples: `abs()`, `lower()`, `date_part()` are all built-in IMMUTABLE.
- `STABLE`: the same input gives the same result within one query execution, but may differ across queries. Examples: `now()` and `current_user` are STABLE.
- `VOLATILE`: may change at any time or has side effects (such as modifying data). The optimizer does **not** do any folding or pushdown; every row and every call is recomputed. `random()`, `nextval()`, and `setval()` are VOLATILE.

When unspecified, the default is `VOLATILE`, the most conservative. Marking a function incorrectly causes two kinds of problems:

- Marking `VOLATILE` as `IMMUTABLE`: the optimizer may fold a per-row computation into a constant, and business results come out wrong.
- Marking `IMMUTABLE` as `VOLATILE`: you lose constant folding and index pushdown, producing a suboptimal plan.

```sql
-- correct: pure computation, no side effects, marked IMMUTABLE, usable by a btree expression index
CREATE FUNCTION hash_str(s text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT md5(s) $$;

-- wrong example: contains a random number but is marked IMMUTABLE — unpredictable in practice
-- CREATE FUNCTION rand_tag() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT md5(random()::text) $$;
```

## Gotchas and common pitfalls

- Most functions return `NULL` for a `NULL` argument, and `||` propagation is equally infectious (`'a' || NULL` returns `NULL`). When you need "skip NULL and keep concatenating" semantics, use `concat()` / `concat_ws()` (NULL arguments are ignored), or wrap the column in `COALESCE(col, '')`.
- `random()` produces a new value on every call, so `SELECT random(), random()` differs between the two columns of the same row — do not expect it to be reproducible like a seed inside SQL; use `seed()` to get stable randomness.
- Mixing strings with numbers (`WHERE varchar_col = 1`) triggers an implicit conversion that can invalidate an index (see [Common Beginner Mistakes](./common-beginner-mistakes)); also, `CREATE OR REPLACE` does not refresh views or materialized views that depend on the function.

## References

- [PostgreSQL official documentation · Part I. Tutorial](https://www.postgresql.org/docs/current/tutorial.html)
- [PostgreSQL official documentation · The SQL Language](https://www.postgresql.org/docs/current/sql.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [WHERE and Expressions](./where-and-expressions)
- [Advanced SQL Functions](../advanced-sql/sql-functions-advanced)
- [Data Types Overview](./data-types-overview)
- [Common Beginner Mistakes](./common-beginner-mistakes)
- [pattern-matching](/advanced-sql/pattern-matching.md)
- [sql-functions-advanced](/advanced-sql/sql-functions-advanced.md)
- [index](index.md)
- [where-and-expressions](where-and-expressions.md)
