# Common Beginner Mistakes

This page collects the most frequent traps at the **semantic** level: most of them do not error out, but quietly return "plausible-looking" wrong results, and they are only noticed once the business data is already dirty. Each one gets a minimal reproducible example plus the fix. For syntax- and permission-related error troubleshooting see [Common Errors and Troubleshooting](../appendix/common-errors-and-troubleshooting).

## Case folding: accessing a `"Name"` table by its bare name errors out

Unquoted identifiers fold to lowercase, while quoted ones are kept literally. Creating a table with double quotes is where the trap starts:

```sql
CREATE TABLE "Users" ("Id" int);       -- that is Users / Id in the catalogs

SELECT * FROM Users;                   -- ERROR: relation "users" does not exist
SELECT * FROM "Users";                 -- OK, but quotes are required everywhere from here on
```

The fix is to rebuild it as a lowercase table and migrate the data:

```sql
BEGIN;
CREATE TABLE users (id int);
INSERT INTO users (id) SELECT "Id" FROM "Users";
DROP TABLE "Users";
COMMIT;
```

There is only one preventive convention: identifiers are always lowercase snake_case, never quoted — see [Naming and Style Conventions](./naming-and-style-conventions).

## NULL comparisons: `= NULL` is always UNKNOWN, and `NOT IN` with NULL returns nothing

`NULL` means "unknown", and comparing it with any value (including itself) using `=` or `<>` yields `UNKNOWN`; `WHERE` keeps only `TRUE` rows:

```sql
CREATE TABLE t (id int, v int);
INSERT INTO t VALUES (1, 10), (2, NULL), (3, 20);

SELECT * FROM t WHERE v <> 10;      -- returns only id=3; id=2 is silently filtered out
SELECT * FROM t WHERE v = NULL;     -- always an empty set, not a syntax error
SELECT * FROM t WHERE v IS NULL;    -- the correct form
SELECT * FROM t WHERE v IS DISTINCT FROM 10;  -- safe form treating NULL as "not equal"
```

More insidious: `NOT IN` returns an empty set for the whole result if the subquery yields even one `NULL`:

```sql
CREATE TABLE blacklist (user_id int);
INSERT INTO blacklist VALUES (999), (NULL);

-- intent: "find users not on the blacklist"; in reality nothing is returned
SELECT id FROM users
WHERE  id NOT IN (SELECT user_id FROM blacklist);

-- two correct forms
SELECT id from users
WHERE  id NOT IN (SELECT user_id from blacklist WHERE user_id IS NOT NULL);

SELECT id from users u
WHERE  NOT EXISTS (SELECT 1 from blacklist b WHERE b.user_id = u.id);  -- recommended
```

`NOT EXISTS` is unaffected by `NULL` and is also the form the planner most easily turns into an anti join, see [The Subquery Family](../advanced-sql/subquery-family).

## Implicit type conversion and index invalidation: comparing a varchar column to a number

When a column's type does not match the type of the value being compared against, PostgreSQL implicitly converts the **column**, which means a B-tree index cannot be used directly:

```sql
CREATE TABLE accounts (phone varchar(20));
CREATE INDEX accounts_phone_idx ON accounts (phone);

-- bad example: phone is varchar, compared against a number, so the column is cast to numeric
EXPLAIN SELECT * FROM accounts WHERE phone = 13800138000;
--  Planner: Filter: ((phone)::numeric = 13800138000)   -> Seq Scan

-- correct: write the comparison value as a string
EXPLAIN SELECT * FROM accounts WHERE phone = '13800138000';
--  Index Cond: (phone = '13800138000'::text)           -> Index Scan
```

Both directions convert (`varchar`→`numeric` or `int`→`text`), but **the column side is always the one converted**, which gives up the index. The fix is to write the literal in the same type as the column, or to build an expression index on `(col::numeric)` to match it. The same problem shows up when comparing a `timestamp` column against a `date` string; for how to read a plan see [How to Read EXPLAIN](../performance/explain-basics).

## The time-zone trap with `timestamp without time zone`

`timestamp` (i.e. `timestamp without time zone`) stores no time zone: whatever is written is what is stored, and that is what is read back. `timestamptz` stores a UTC instant and converts to the session `TimeZone` at display time. Mixing the two most easily produces the illusion of an "8-hour offset":

```sql
CREATE TABLE ev (ts timestamp, tstz timestamptz);

SET timezone = 'Asia/Shanghai';
INSERT INTO ev VALUES ('2026-10-12 08:00:00', '2026-10-12 08:00:00');

SET timezone = 'UTC';
SELECT ts, tstz from ev;
-- ts   : 2026-10-12 08:00:00   (unchanged, no time-zone concept)
-- tstz : 2026-10-12 00:00:00+00 (converted to UTC for display)
```

The recommendation is **to use `timestamptz` uniformly in business tables**, leaving time-zone conversion to the database and drivers rather than scattering it through application code; only "calendar-meaning local times" (store opening hours, birthdays) suit `timestamp` plus a separate time-zone/offset column. For the `AT TIME ZONE` expansion rules see [Data Types Overview](./data-types-overview).

## `count(*)` is slow: the visibility cost under MVCC

Intuitively "count the rows" is O(1), but in PostgreSQL `count(*)` has to check tuple visibility for the current transaction row by row (every row has `xmin`/`xmax`) and cannot simply take an index row-count estimate the way MySQL InnoDB can:

```sql
-- on a large table this is a full table or full index scan, seconds to minutes
SELECT count(*) FROM orders;

-- count(col) must also skip NULLs, usually slower than count(*)
SELECT count(col) FROM orders;
```

Mitigations:

- Use `pg_class.reltuples` for the statistical estimate (close to reality after `ANALYZE`, and the first choice when the precision is enough).
- When an exact value is needed and called frequently, maintain a counter table with a trigger, or use a materialized view refreshed on a schedule.
- When you only need to know "whether there are any", use `EXISTS`, not `count(*) > 0`.

For the underlying mechanics see [MVCC and Multi-Version](../internals/mvcc-and-multi-version).

## UPDATE / DELETE without a WHERE

An `UPDATE`/`DELETE` without `WHERE` acts on the whole table, and once committed it cannot be undone by the database itself. The defensive approach is to **wrap it in a transaction and verify the row count before committing**:

```sql
BEGIN;
UPDATE orders SET status = 'archived' WHERE created_at < '2024-01-01';
-- check whether the returned UPDATE n row count matches expectation
ROLLBACK;          -- roll back and retry if wrong; COMMIT if it matches
```

Companion habits:

- Run an equivalent `SELECT count(*)` before deleting, to confirm the scope of impact.
- When you have written `DELETE FROM t`, stop before the semicolon and add the `WHERE`; make it a mandatory item in team code review.
- In production, consider a trigger on `DELETE` or a soft-delete column, see [Soft Deletes and Tombstones](../database-design/soft-delete-and-tombstone).
- If a wrong delete has already been committed, only a lagged replica or a backup can save you, see [Backup Strategy](../operations/backup-strategy).

## Division by zero and integer division: `1/2 = 0`

PostgreSQL's `/` between two integers is **integer division** (truncating), and dividing by zero raises an error outright:

```sql
SELECT 1 / 2          AS int_div,     -- 0, not 0.5
       1.0 / 2        AS numeric_div, -- 0.5
       1::numeric / 2 AS cast_div,    -- 0.5
       7 / 2 * 2      AS trick;       -- 6, not 7!

SELECT 10 / 0;        -- ERROR: division by zero
```

The typical way this bites is when computing ratios or splitting amounts evenly: if both sides of `sum(amount) / count(*)` are `integer`/`bigint`, you get a truncated average. The fix is to cast either side to `numeric`, or to use `avg()`. To guard against division by zero, use `NULLIF` to turn the denominator into `NULL` so the result quietly becomes `NULL` instead of erroring:

```sql
SELECT sum(amount) / NULLIF(count(*), 0)::numeric AS avg_amount
FROM   orders
WHERE  user_id = 42;
```

## Running out of integer in a sequence

`serial` defaults to `integer`, capped at 2147483647 (about 2.14 billion). High-write tables (orders, logs, events) can exhaust that within a few years, at which point `nextval` reports `nextval: reached maximum value of sequence` and every insert fails. To check and fix:

```sql
-- check the current sequence values and types (PG 10+)
SELECT sequencename, data_type, last_value, max_value
FROM   pg_sequences
WHERE  schemaname = 'public'
ORDER  BY last_value DESC;

-- fix: upgrade the column and the sequence to bigint together (rewrites the whole table, heavy lock, run off-peak)
ALTER TABLE big_table ALTER COLUMN id TYPE bigint;
ALTER SEQUENCE big_table_id_seq AS bigint;
```

New tables should use `bigint GENERATED ALWAYS AS IDENTITY` uniformly (since PG 10) — the storage cost is only 4 extra bytes, see [Primary Key Design](../database-design/primary-key-design). UUID primary keys have no such problem, but watch for index bloat and insert order, see [UUIDs and Indexes](../indexing/btree-structure).

## Gotchas and common pitfalls

- Almost no `NULL`-related mistake produces an error; they only quietly return an empty set or a wrong statistic. This is where silent bugs breed — before writing a `WHERE`, ask yourself once "can this column be NULL?"
- The type-mismatch trap exists just as much in `JOIN` conditions (joining an `int` column to a `varchar` column), causing implicit conversion and plan degradation.
- The `count(*)`, `1/2`, and `NOT IN` problem families share one trait: **the syntax is completely legal**, so they pass unnoticed in a test environment and only surface in production. Worth checking explicitly in code review.
- Most of these traps can be caught in advance with `EXPLAIN` and `\d table`: looking at column types, indexes, and plans is more direct than reading the code.

## References

- [PostgreSQL official documentation · Part I. Tutorial](https://www.postgresql.org/docs/current/tutorial.html)
- [PostgreSQL official documentation · The SQL Language](https://www.postgresql.org/docs/current/sql.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Naming and Style Conventions](./naming-and-style-conventions)
- [Data Types Overview](./data-types-overview)
- [How to Read EXPLAIN](../performance/explain-basics)
- [Common Errors and Troubleshooting](../appendix/common-errors-and-troubleshooting)
- [common-errors-and-troubleshooting](/appendix/common-errors-and-troubleshooting.md)
- [functions-and-operators](functions-and-operators.md)
- [index](index.md)
- [naming-and-style-conventions](naming-and-style-conventions.md)
