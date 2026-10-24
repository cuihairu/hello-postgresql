# Generated Columns and CHECK Expressions

A generated column lets the database compute and persist a derived value from other columns in the same row, so the writer never has to maintain it by hand. A CHECK constraint, by contrast, is a validation rule over the values of existing columns that rejects a write on violation. The two are often confused, but their division of labor is clear: **CHECK validates "is the data right," while a generated column derives "what the data should be."** This page threads one example, "fully lowercase email," through both techniques.

## Sample Table

```sql
CREATE TABLE users (
    id          bigserial PRIMARY KEY,
    email_raw   text NOT NULL,
    email       text GENERATED ALWAYS AS (lower(email_raw)) STORED,
    email_ok    boolean CHECK (email_raw = lower(email_raw)),
    age         int CHECK (age IS NULL OR age BETWEEN 0 AND 150)
);

INSERT INTO users (email_raw) VALUES ('Alice@Example.COM');
SELECT id, email_raw, email, email_ok FROM users;
--  1 | Alice@Example.COM | alice@example.com | f
```

The `email` column is computed automatically by the database. INSERT/UPDATE statements are **not** allowed to assign it directly, and doing so raises a `GENERATED ALWAYS` related error. There is not even an escape hatch like `OVERRIDING SYSTEM VALUE` — a generated column can only be written by the database.

## GENERATED ALWAYS AS (...) STORED

The syntax was introduced in PG 12, and the `STORED` keyword is mandatory: the value is computed at write time and occupies disk space. The core semantics:

```sql
ALTER TABLE users ADD COLUMN name_len int
    GENERATED ALWAYS AS (char_length(email_raw)) STORED;

ALTER TABLE users DROP COLUMN email;   -- dropping the generated column itself is allowed
-- But you cannot drop email_raw, which the generated column references, and get a dependency error
```

Two hard limits:

- **Cannot reference other generated columns**: the expression may only reference ordinary columns (base columns) in the same row; referencing another generated column errors out at table creation.
- **Cannot use volatile functions**: the expression must be IMMUTABLE. `lower()`, `char_length()`, and arithmetic are fine; `now()`, `random()`, and `nextval()` are not. This limit is a semantic necessity — a generated column's value must yield the same result whenever it is recomputed, otherwise the STORED value would diverge from the expression.

Also note: generated columns behave normally in logical replication and `pg_dump`, but when upgrading across major versions with `pg_upgrade`, earlier versions received patches for support of tables containing generated columns, so check the release notes for your versions before upgrading.

## Generated Columns vs. Trigger-Maintained Redundant Columns

Before PG 12, derived redundant columns could only be maintained by triggers. The comparison:

| Dimension | Generated column | Trigger-maintained |
| --- | --- | --- |
| Expression limits | Must be IMMUTABLE, may only reference base columns | Arbitrary PL/pgSQL logic, can read other tables |
| Consistency | Guaranteed by the database, cannot diverge | Diverges if the logic is wrong; you must test it yourself |
| Visibility | The expression is visible directly in `psql \d` | You have to read the trigger function source |
| Update cost | Recomputed on every write | Triggered on every write, the same |
| Cross-table / cross-row | Not supported | Supported (such as maintaining a summary table) |

Use a generated column rather than a trigger whenever you can: the constraint is harder and the audit trail more direct. Only fall back to a trigger or application-layer maintenance when you need cross-row aggregation (an order header's `total_amount` summed from its line items) or need to read other tables. See [Normalization and Denormalization](../database-design/normalization-and-denormalization).

## Indexing a Generated Column

A generated column is an ordinary column: you can index it, add a unique constraint, and use it in a foreign key:

```sql
CREATE UNIQUE INDEX idx_users_email ON users (email);

-- A query hits the index on the generated column directly
SELECT id FROM users WHERE email = 'alice@example.com';
```

This is one of the substantive advantages of "generated column + index" over an "expression index": an expression index requires the query to spell out the identical expression, whereas an index on a generated column only needs the query to reference the column name. Another advantage is that a generated column can declare `NOT NULL` and `UNIQUE`; an expression index can do uniqueness too, but the semantics are one layer more indirect.

## Virtual Generated Columns (PG 18)

From PG 18, `VIRTUAL` generated columns enter the standard: the value is not stored on disk and is computed on read, saving storage and write amplification. The cost is paying the computation on every read, and indexes cannot yet be built on them. Users of PG 12 through 17 on existing systems should just continue with `STORED`; virtual columns suit derived fields that "cost a lot to compute but are rarely read."

## The Division of Labor Between CHECK and Generated Columns

Back to the opening example: `email` (a generated column) answers "what is the normalized email," while `email_ok` (a CHECK) answers "does the raw input already conform." If you want to **reject** non-normalized input like `'Alice@Example.COM'`, use a CHECK directly instead of "store it, then derive":

```sql
ALTER TABLE users ADD CONSTRAINT email_lowercase_chk
    CHECK (email_raw = lower(email_raw));
-- Inserting 'Alice@...' now errors out immediately
```

The criterion for choosing: if the value is **uniquely determined** and you are willing to let the database compute it for you, use a generated column; if the value needs to be **guaranteed by a human** and you would rather error than silently rewrite on violation, use a CHECK. You can also use both: CHECK to enforce well-formed input, and a generated column to derive (for example, slicing `email_domain` out of `email_raw`).

## Caveats and Common Traps

- A generated column's expression cannot use subqueries or reference columns from other tables; it can only see "this row's base columns."
- A `STORED` generated column increases per-row size and write amplification; before adding one for an infrequently read derived value on a wide table, use `EXPLAIN ANALYZE` to evaluate the benefit on the read side.
- There is no shortcut for modifying a generated column's expression other than `ALTER COLUMN ... SET EXPRESSION` (which only landed in PG 17); earlier versions can only drop and recreate the column, and dropping a column also drops any indexes depending on it.
- A CHECK constraint always lets NULL pass (a NULL result is treated as passing), so `CHECK (age BETWEEN 0 AND 150)` does not error on rows where `age IS NULL`; to reject NULL add `NOT NULL` separately.
- On a large table, `ADD CONSTRAINT ... CHECK` defaults to a full table scan that locks the table; in production use the two-step `NOT VALID` + `VALIDATE CONSTRAINT` approach. See [Constraints and Data Quality](../database-design/constraints-and-data-quality).

## References

- [PostgreSQL official documentation · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL official documentation · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [CHECK and Domains](../database-design/check-and-domains)
- [Constraints and Data Quality](../database-design/constraints-and-data-quality)
- [Expression indexes](../indexing/expression-indexes)
- [Modeling Anti-Patterns](../database-design/anti-patterns)
- [index](index.md)
- [jsonb-design-patterns](jsonb-design-patterns.md)
- [jsonb-operations](jsonb-operations.md)
- [check-and-domains](/database-design/check-and-domains.md)
- [expression-indexes](/indexing/expression-indexes.md)
Official documentation: [Generated columns](https://www.postgresql.org/docs/current/ddl-generated-columns.html), [CHECK constraints](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-CHECK-CONSTRAINTS).
