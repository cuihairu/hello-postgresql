# SQL Command Reference

A quick-reference list of commonly used commands, grouped by DDL / DML / DCL / TCL, with one copy-paste-ready minimal example per group. For full syntax, the official [SQL Command Reference](https://www.postgresql.org/docs/current/sql-commands.html) is authoritative.

## DDL: Defining Structure

| Command | Common form | Notes |
| --- | --- | --- |
| CREATE TABLE | `CREATE TABLE t (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL);` | Creates a table; `IF NOT EXISTS` makes it idempotent. |
| ALTER TABLE ADD COLUMN | `ALTER TABLE t ADD COLUMN email text;` | Adds a column; on a large table this rewrites the whole table, so watch the lock and the time cost. |
| ALTER TABLE DROP COLUMN | `ALTER TABLE t DROP COLUMN email;` | Drops a column; this rewrites the table too. |
| ALTER COLUMN | `ALTER TABLE t ALTER COLUMN name TYPE varchar(100);` | Changes a type; incompatible types need an explicit cast via a `USING` clause. |
| ALTER COLUMN SET / DROP | `ALTER TABLE t ALTER COLUMN name SET NOT NULL;` / `DROP NOT NULL;` | Changes a constraint attribute; `SET DEFAULT` only affects new writes. |
| ADD / DROP CONSTRAINT | `ALTER TABLE t ADD CONSTRAINT t_email_uniq UNIQUE (email);` | Adds a constraint; `DROP CONSTRAINT` removes one. |
| RENAME | `ALTER TABLE t RENAME TO users;` / `RENAME COLUMN a TO b;` | Renames a table or a column. |
| CREATE INDEX | `CREATE INDEX ON t (email);` | Creates an index; `UNIQUE` makes it a unique index. |
| CREATE INDEX CONCURRENTLY | `CREATE INDEX CONCURRENTLY ON t (email);` | Builds an index without blocking reads and writes; a failure leaves an INVALID index that needs cleanup. |
| DROP INDEX | `DROP INDEX CONCURRENTLY idx_name;` | Drops an index; `IF EXISTS` makes it idempotent. |
| CREATE SCHEMA | `CREATE SCHEMA IF NOT EXISTS app;` | Creates a schema. |
| DROP SCHEMA | `DROP SCHEMA app CASCADE;` | Drops a schema; `CASCADE` removes the objects inside it as well. |
| CREATE DATABASE | `CREATE DATABASE appdb OWNER app;` | Creates a database; it cannot run inside a transaction block, so `createdb` is more convenient in scripts. |
| DROP DATABASE | `DROP DATABASE appdb;` | Drops a database; likewise cannot run inside a transaction block. |

```sql
-- The full lifecycle: create a table, add a column, add an index, change a constraint
CREATE TABLE users (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN email text;
CREATE UNIQUE INDEX users_email_uniq ON users (email);
ALTER TABLE users ALTER COLUMN email SET NOT NULL;
```

## DML: Manipulating Data

| Command | Common form | Notes |
| --- | --- | --- |
| INSERT | `INSERT INTO t (a, b) VALUES (1, 'x'), (2, 'y');` | Inserts in bulk; `RETURNING id` retrieves generated values. |
| INSERT ... ON CONFLICT | `INSERT ... ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v;` | Updates on conflict (PG 9.5 and later); use `DO NOTHING` to skip instead. |
| UPDATE | `UPDATE t SET v = 1 WHERE id = 2;` | Updates by condition; always include a WHERE. |
| UPDATE ... FROM | `UPDATE t SET v = s.v FROM staging s WHERE t.id = s.id;` | Bulk-updates using another table or a subquery. |
| DELETE | `DELETE FROM t WHERE created_at < now() - interval '90 days';` | Deletes by condition; delete large batches in chunks to avoid long transactions. |
| DELETE ... USING | `DELETE FROM t USING s WHERE t.id = s.id;` | Deletes by a join condition. |
| TRUNCATE | `TRUNCATE t;` | Empties a table, faster than DELETE; `RESTART IDENTITY` resets sequences, and `CASCADE` also empties referencing tables. |
| MERGE | `MERGE INTO t USING s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET v = s.v WHEN NOT MATCHED THEN INSERT ...;` | Merges inserts and updates (PG 15 and later). |

```sql
-- Upsert: update on conflict, and return the affected row
INSERT INTO users (id, name, email)
VALUES (1, 'Zhang San', 'zhangsan@example.com')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name, email = EXCLUDED.email
RETURNING id, name;

-- Bulk-update using a staging table
UPDATE users u
SET email = s.email
FROM staging s
WHERE u.id = s.id;
```

## DCL: Roles and Privileges

| Command | Common form | Notes |
| --- | --- | --- |
| CREATE ROLE | `CREATE ROLE app LOGIN PASSWORD 'secret';` | Creates a role; `LOGIN` makes it a user, `NOLOGIN` makes it a pure privilege group. |
| CREATE USER | `CREATE USER app LOGIN;` | An alias for CREATE ROLE with identical semantics. |
| ALTER ROLE | `ALTER ROLE app SET search_path = app, public;` | Changes role attributes: password, connection limit, search_path, and so on. |
| DROP ROLE | `DROP ROLE IF EXISTS app;` | Drops a role; you must first transfer the objects it owns. |
| GRANT | `GRANT SELECT, INSERT ON users TO app;` | Grants privileges; `ALL PRIVILEGES` grants everything, and `ON SCHEMA app TO app` grants schema-level privileges. |
| GRANT ROLE | `GRANT app TO deploy;` | Grants a role to another role, implementing privilege groups. |
| REVOKE | `REVOKE INSERT ON users FROM app;` | Revokes privileges. |
| ALTER DEFAULT PRIVILEGES | `ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO app;` | Auto-grants on objects created in the future. |

```sql
-- Create a role and grant privileges: the app account can only read and write its own tables
CREATE ROLE app LOGIN PASSWORD 'secret';
GRANT USAGE ON SCHEMA app TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
```

## TCL: Transaction Control

| Command | Common form | Notes |
| --- | --- | --- |
| BEGIN | `BEGIN;` or `START TRANSACTION;` | Starts a transaction; may carry modifiers such as `ISOLATION LEVEL` and `READ ONLY`. |
| COMMIT | `COMMIT;` or `END;` | Commits the transaction. |
| ROLLBACK | `ROLLBACK;` | Rolls back the entire transaction. |
| SAVEPOINT | `SAVEPOINT sp1;` | Places a checkpoint inside a transaction. |
| ROLLBACK TO | `ROLLBACK TO SAVEPOINT sp1;` | Rolls back to the checkpoint while the transaction itself continues. |
| RELEASE SAVEPOINT | `RELEASE SAVEPOINT sp1;` | Drops the checkpoint. |
| SET TRANSACTION | `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;` | Sets transaction characteristics; it must come after BEGIN and before the first statement. |

```sql
-- Use savepoints inside a transaction to roll back partially
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
SAVEPOINT before_second;
UPDATE accounts SET balance = balance + 100 WHERE id = 2;
-- If the second step fails: ROLLBACK TO SAVEPOINT before_second;
COMMIT;
```

## Further Reading

- [PostgreSQL official docs · MERGE](https://www.postgresql.org/docs/current/sql-merge.html)
- [PostgreSQL official docs · SQL Commands](https://www.postgresql.org/docs/current/sql-commands.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Glossary](./glossary)
- [CRUD and ON CONFLICT](../basics/crud-and-on-conflict)
- [Transaction Basics](../basics/transaction-basics)
- [Roles and Privileges](../security/roles-and-permissions)
- [index](index.md)
- [references-and-docs](references-and-docs.md)
Official docs: [SQL Command Reference](https://www.postgresql.org/docs/current/sql-commands.html), [MERGE (PG 15 and later)](https://www.postgresql.org/docs/current/sql-merge.html)
