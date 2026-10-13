# SQL 命令速查

按 DDL / DML / DCL / TCL 分节的常用命令一览，每类配一个可直接粘贴的最小示例。完整语法以官方 [SQL 命令参考](https://www.postgresql.org/docs/current/sql-commands.html)为准。

## DDL：定义结构

| 命令 | 常用形态 | 说明 |
| --- | --- | --- |
| CREATE TABLE | `CREATE TABLE t (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL);` | 建表；`IF NOT EXISTS` 可幂等执行。 |
| ALTER TABLE ADD COLUMN | `ALTER TABLE t ADD COLUMN email text;` | 加列；大表加列会重写全表，注意锁与耗时。 |
| ALTER TABLE DROP COLUMN | `ALTER TABLE t DROP COLUMN email;` | 删列；同样会重写表。 |
| ALTER COLUMN | `ALTER TABLE t ALTER COLUMN name TYPE varchar(100);` | 改类型；不兼容的类型需 `USING` 子句显式转换。 |
| ALTER COLUMN SET / DROP | `ALTER TABLE t ALTER COLUMN name SET NOT NULL;` / `DROP NOT NULL;` | 改约束属性；`SET DEFAULT` 只影响新写入。 |
| ADD / DROP CONSTRAINT | `ALTER TABLE t ADD CONSTRAINT t_email_uniq UNIQUE (email);` | 加约束；`DROP CONSTRAINT` 删约束。 |
| RENAME | `ALTER TABLE t RENAME TO users;` / `RENAME COLUMN a TO b;` | 改表名或列名。 |
| CREATE INDEX | `CREATE INDEX ON t (email);` | 建索引；`UNIQUE` 建唯一索引。 |
| CREATE INDEX CONCURRENTLY | `CREATE INDEX CONCURRENTLY ON t (email);` | 不阻塞读写建索引，失败会留 INVALID 索引需清理。 |
| DROP INDEX | `DROP INDEX CONCURRENTLY idx_name;` | 删索引；`IF EXISTS` 可幂等。 |
| CREATE SCHEMA | `CREATE SCHEMA IF NOT EXISTS app;` | 建 schema。 |
| DROP SCHEMA | `DROP SCHEMA app CASCADE;` | 删 schema；`CASCADE` 连带删其中对象。 |
| CREATE DATABASE | `CREATE DATABASE appdb OWNER app;` | 建库；不能在事务块内执行，脚本里用 `createdb` 更顺手。 |
| DROP DATABASE | `DROP DATABASE appdb;` | 删库；同样不能在事务块内执行。 |

```sql
-- 建表、加列、加索引、改约束的完整生命周期
CREATE TABLE users (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN email text;
CREATE UNIQUE INDEX users_email_uniq ON users (email);
ALTER TABLE users ALTER COLUMN email SET NOT NULL;
```

## DML：操作数据

| 命令 | 常用形态 | 说明 |
| --- | --- | --- |
| INSERT | `INSERT INTO t (a, b) VALUES (1, 'x'), (2, 'y');` | 批量插入；`RETURNING id` 取回生成值。 |
| INSERT ... ON CONFLICT | `INSERT ... ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v;` | 冲突时更新（PG 9.5 起）；`DO NOTHING` 则跳过。 |
| UPDATE | `UPDATE t SET v = 1 WHERE id = 2;` | 按条件更新；务必带 WHERE。 |
| UPDATE ... FROM | `UPDATE t SET v = s.v FROM staging s WHERE t.id = s.id;` | 用另一张表/子查询批量更新。 |
| DELETE | `DELETE FROM t WHERE created_at < now() - interval '90 days';` | 按条件删除；大批量分批删避免长事务。 |
| DELETE ... USING | `DELETE FROM t USING s WHERE t.id = s.id;` | 按关联条件删除。 |
| TRUNCATE | `TRUNCATE t;` | 清空表，比 DELETE 快；`RESTART IDENTITY` 重置序列，`CASCADE` 连带清空引用表。 |
| MERGE | `MERGE INTO t USING s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET v = s.v WHEN NOT MATCHED THEN INSERT ...;` | 合并插入与更新（PG 15 起）。 |

```sql
-- upsert：冲突时更新，并返回受影响行
INSERT INTO users (id, name, email)
VALUES (1, '张三', 'zhangsan@example.com')
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name, email = EXCLUDED.email
RETURNING id, name;

-- 用 staging 表批量更新
UPDATE users u
SET email = s.email
FROM staging s
WHERE u.id = s.id;
```

## DCL：角色与权限

| 命令 | 常用形态 | 说明 |
| --- | --- | --- |
| CREATE ROLE | `CREATE ROLE app LOGIN PASSWORD 'secret';` | 建角色；`LOGIN` 即用户，`NOLOGIN` 是纯权限组。 |
| CREATE USER | `CREATE USER app LOGIN;` | CREATE ROLE 的别名，语义相同。 |
| ALTER ROLE | `ALTER ROLE app SET search_path = app, public;` | 改角色属性：密码、连接数、search_path 等。 |
| DROP ROLE | `DROP ROLE IF EXISTS app;` | 删角色；需先转移其拥有的对象。 |
| GRANT | `GRANT SELECT, INSERT ON users TO app;` | 授权；`ALL PRIVILEGES` 授全部，`ON SCHEMA app TO app` 授 schema 级权限。 |
| GRANT 角色 | `GRANT app TO deploy;` | 把角色授给另一角色，实现权限组。 |
| REVOKE | `REVOKE INSERT ON users FROM app;` | 收回权限。 |
| ALTER DEFAULT PRIVILEGES | `ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO app;` | 对将来新建的对象自动授权。 |

```sql
-- 建角色并授权：应用账号只能读写自己的表
CREATE ROLE app LOGIN PASSWORD 'secret';
GRANT USAGE ON SCHEMA app TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA app
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
```

## TCL：事务控制

| 命令 | 常用形态 | 说明 |
| --- | --- | --- |
| BEGIN | `BEGIN;` 或 `START TRANSACTION;` | 开启事务；可带 `ISOLATION LEVEL`、`READ ONLY` 等修饰。 |
| COMMIT | `COMMIT;` 或 `END;` | 提交事务。 |
| ROLLBACK | `ROLLBACK;` | 回滚整个事务。 |
| SAVEPOINT | `SAVEPOINT sp1;` | 在事务内打检查点。 |
| ROLLBACK TO | `ROLLBACK TO SAVEPOINT sp1;` | 回滚到检查点，事务本身继续。 |
| RELEASE SAVEPOINT | `RELEASE SAVEPOINT sp1;` | 删除检查点。 |
| SET TRANSACTION | `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;` | 设置事务特性，须在 BEGIN 之后、第一条语句之前。 |

```sql
-- 事务内用保存点做部分回滚
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
SAVEPOINT before_second;
UPDATE accounts SET balance = balance + 100 WHERE id = 2;
-- 若第二步出错：ROLLBACK TO SAVEPOINT before_second;
COMMIT;
```

## 参考资料

- [PostgreSQL 官方文档 · MERGE](https://www.postgresql.org/docs/current/sql-merge.html)
- [PostgreSQL 官方文档 · SQL Commands](https://www.postgresql.org/docs/current/sql-commands.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [术语表](./glossary)
- [CRUD 与 ON CONFLICT](../basics/crud-and-on-conflict)
- [事务基础](../basics/transaction-basics)
- [角色与权限](../security/roles-and-permissions)
- [index](index.md)
- [references-and-docs](references-and-docs.md)
官方文档：[SQL 命令参考](https://www.postgresql.org/docs/current/sql-commands.html)、[MERGE（PG 15 起）](https://www.postgresql.org/docs/current/sql-merge.html)
