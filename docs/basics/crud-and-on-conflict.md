# CRUD and ON CONFLICT

INSERT / UPDATE / DELETE are the three statement families backend developers write most. PostgreSQL extends the SQL standard with `RETURNING`, `ON CONFLICT`, `UPDATE ... FROM`, `DELETE ... USING` and friends, so a "read once, then write once" round trip can collapse into a single statement. This page demonstrates those forms using one consistent example table.

## The example table

```sql
CREATE TABLE users (
    id          bigserial PRIMARY KEY,
    email       text NOT NULL UNIQUE,
    nickname    text NOT NULL,
    login_count int NOT NULL DEFAULT 0,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO users (email, nickname) VALUES
    ('a@example.com', 'Ming'),
    ('b@example.com', 'Hong');
```

## INSERT: column lists and multi-row inserts

Writing the column list explicitly is a habit worth keeping: when a table gains columns or columns are reordered, the statement does not silently change meaning. To insert multiple rows at once use several `VALUES` groups, which costs one network round trip less than inserting row by row; to load from another table use `INSERT ... SELECT`.

```sql
-- multi-row insert
INSERT INTO users (email, nickname) VALUES
    ('c@example.com', 'Gang'),
    ('d@example.com', 'Li');

-- insert from a query result: archive users inactive for a year
CREATE TABLE users_archive (
    id          bigint PRIMARY KEY,
    email       text NOT NULL,
    nickname    text NOT NULL,
    archived_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO users_archive (id, email, nickname)
SELECT id, email, nickname FROM users WHERE updated_at < now() - interval '1 year';
```

## UPDATE ... FROM: update using data from other tables

PostgreSQL's extension lets UPDATE join in additional tables and take values from them into SET:

```sql
CREATE TABLE user_stats (email text PRIMARY KEY, logins int NOT NULL);
INSERT INTO user_stats VALUES ('a@example.com', 10), ('b@example.com', 3);

UPDATE users u
SET login_count = s.logins,
    updated_at  = now()
FROM user_stats s
WHERE u.email = s.email;
```

Note: if a table in `FROM` can match more than one row for a given row, PostgreSQL picks an indeterminate one and does not report an error. So building `user_stats.email` as a primary key in the example above is not an unnecessary step.

## DELETE ... USING: delete based on other tables

The delete statement has the corresponding `USING` join:

```sql
DELETE FROM users u
USING user_stats s
WHERE u.email = s.email
  AND s.logins = 0;
```

## TRUNCATE

To empty an entire table use `TRUNCATE users;`: it does not delete row by row, so speed does not depend on table size, and you can opt into `RESTART IDENTITY` to reset the sequence. In PostgreSQL it is transactional and can be `ROLLBACK`ed, but it holds an exclusive table-level lock.

## ON CONFLICT: UPSERT

"Insert if it does not exist, update if it does" is the most common write pattern. `ON CONFLICT` finishes it in one statement, provided the columns used for conflict detection carry a unique constraint or a unique index — the database discovers conflicts through unique indexes, so a column that is "logically unique" in business terms but has no unique constraint will make `ON CONFLICT (col)` fail outright with: `there is no unique or exclusion constraint matching the ON CONFLICT specification`.

```sql
-- ignore on conflict
INSERT INTO users (email, nickname) VALUES ('a@example.com', 'Ming')
ON CONFLICT (email) DO NOTHING;

-- update on conflict (UPSERT); EXCLUDED refers to the row this statement tried to insert
INSERT INTO users (email, nickname) VALUES ('a@example.com', 'Ming Jr.')
ON CONFLICT (email) DO UPDATE
SET nickname   = EXCLUDED.nickname,
    updated_at = now();
```

Key points:

- `EXCLUDED` is a special table alias referring to the "would-be inserted" new values; reference the existing row's data with the table name (e.g. `users.login_count`).
- When you omit the conflict target and write `ON CONFLICT DO NOTHING`, any unique-constraint conflict is ignored; but `DO UPDATE` must name a conflict target.
- A unique constraint need not be on a single column — composite unique keys like `ON CONFLICT (tenant_id, email)` work just the same.

## RETURNING: get back the written rows

`INSERT` / `UPDATE` / `DELETE` can all take `RETURNING` and return the affected rows the way SELECT does. The most common use is retrieving the auto-generated primary key, which removes one `SELECT currval` or one "look up by unique key after the insert" query:

```sql
INSERT INTO users (email, nickname) VALUES ('e@example.com', 'Wang')
RETURNING id, nickname;          -- straight to the new id

UPDATE users SET login_count = login_count + 1
WHERE email = 'a@example.com'
RETURNING login_count;           -- the value after the update

DELETE FROM users WHERE email = 'e@example.com'
RETURNING id;
```

Paired with UPSERT: `DO UPDATE ... RETURNING` returns the updated rows; rows skipped by `DO NOTHING` never appear in the result, so do not use `DO NOTHING` when you need to distinguish "newly created" from "already existed".

## Gotchas and common pitfalls

- **UPDATE / DELETE missing a WHERE** acts on the whole table. Wrapping the run in `BEGIN;` and confirming the affected row count before `COMMIT;` is a cheap protection habit.
- **Multi-row inserts can conflict within the same statement**: when two `VALUES` rows share a unique key, `ON CONFLICT` does not deduplicate inside the statement, and you get `ON CONFLICT DO UPDATE command cannot affect row a second time`. Deduplicate on the unique key before a bulk import.
- **Concurrent UPSERT**: when two transactions upsert the same key, the later one waits for the first to commit and then takes the update branch, which is semantically safe; but large batches upserting many rows in different orders can wait on each other and deadlock, so sort rows by unique key before a bulk write, see [Batch Writes](../advanced-sql/batch-and-write).
- **`ON CONFLICT` matches a unique constraint, not business meaning**. If another unique constraint is involved (say the table also has a unique phone-number key), the same insert may conflict on a constraint you never wrote and never reach the branch you intended.
- The TRUNCATE versus `DELETE` trade-off involves locks and dead-tuple reclamation, see [VACUUM and HOT](../internals/vacuum-and-hot).

## References

- [PostgreSQL official documentation · Part I. Tutorial](https://www.postgresql.org/docs/current/tutorial.html)
- [PostgreSQL official documentation · The SQL Language](https://www.postgresql.org/docs/current/sql.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [WHERE and Expressions](./where-and-expressions)
- [Transaction Basics](./transaction-basics)
- [Batch Writes](../advanced-sql/batch-and-write)
- [Common Errors and Troubleshooting](../appendix/common-errors-and-troubleshooting)
- [batch-and-write](/advanced-sql/batch-and-write.md)
- [sql-command-reference](/appendix/sql-command-reference.md)
- [index](index.md)
- [primary-key-design](/database-design/primary-key-design.md)
- [transactions-and-isolation](/internals/transactions-and-isolation.md)
- [real-world-cases](/tools/real-world-cases.md)
Official documentation: [INSERT](https://www.postgresql.org/docs/current/sql-insert.html), [UPDATE](https://www.postgresql.org/docs/current/sql-update.html), [DELETE](https://www.postgresql.org/docs/current/sql-delete.html).
