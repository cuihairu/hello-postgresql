# CRUD 与 ON CONFLICT

INSERT / UPDATE / DELETE 是后端开发写得最多的三类语句。PostgreSQL 在 SQL 标准之上提供了 `RETURNING`、`ON CONFLICT`、`UPDATE ... FROM`、`DELETE ... USING` 等扩展，可以把「先查一次再写一次」的两次往返合并成一条语句。本文用一个统一的示例表演示这些写法。

## 示例表

```sql
CREATE TABLE users (
    id          bigserial PRIMARY KEY,
    email       text NOT NULL UNIQUE,
    nickname    text NOT NULL,
    login_count int NOT NULL DEFAULT 0,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO users (email, nickname) VALUES
    ('a@example.com', '小明'),
    ('b@example.com', '小红');
```

## INSERT：写明列清单与多值插入

显式写出列清单是值得保持的习惯：表加列、列换顺序时语句不会悄悄改变语义。一次插入多行用多组 `VALUES`，比逐行插入少一个网络往返；从其他表导入则用 `INSERT ... SELECT`。

```sql
-- 多值插入
INSERT INTO users (email, nickname) VALUES
    ('c@example.com', '小刚'),
    ('d@example.com', '小丽');

-- 从查询结果插入：归档一年未活跃的用户
CREATE TABLE users_archive (
    id          bigint PRIMARY KEY,
    email       text NOT NULL,
    nickname    text NOT NULL,
    archived_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO users_archive (id, email, nickname)
SELECT id, email, nickname FROM users WHERE updated_at < now() - interval '1 year';
```

## UPDATE ... FROM：用其他表的数据更新

PostgreSQL 扩展允许 UPDATE 关联额外的表，把别表的值拿来 SET：

```sql
CREATE TABLE user_stats (email text PRIMARY KEY, logins int NOT NULL);
INSERT INTO user_stats VALUES ('a@example.com', 10), ('b@example.com', 3);

UPDATE users u
SET login_count = s.logins,
    updated_at  = now()
FROM user_stats s
WHERE u.email = s.email;
```

注意：如果 `FROM` 里的表按关联条件能匹配出多行，更新结果取其中不确定的一行，PostgreSQL 不会报错。所以上面示例把 `user_stats.email` 建成主键不是多余动作。

## DELETE ... USING：按其他表删除

删除语句对应地用 `USING` 关联别表：

```sql
DELETE FROM users u
USING user_stats s
WHERE u.email = s.email
  AND s.logins = 0;
```

## TRUNCATE

清空整张表用 `TRUNCATE users;`：不走逐行删除，速度与表大小无关，可选择 `RESTART IDENTITY` 重置序列。它在 PostgreSQL 里是事务性的，可以 `ROLLBACK`，但会持有表级排他锁。

## ON CONFLICT：UPSERT

「不存在就插入，存在就更新」是最常见的写入模式。`ON CONFLICT` 一条语句完成，前提是冲突判定列上必须有唯一约束或唯一索引——数据库靠唯一索引发现冲突，业务上「逻辑唯一」但没建唯一约束的列，写 `ON CONFLICT (col)` 会直接报错：`there is no unique or exclusion constraint matching the ON CONFLICT specification`。

```sql
-- 冲突时忽略
INSERT INTO users (email, nickname) VALUES ('a@example.com', '小明')
ON CONFLICT (email) DO NOTHING;

-- 冲突时更新（UPSERT），EXCLUDED 指本次想插入但被拦下的那行
INSERT INTO users (email, nickname) VALUES ('a@example.com', '明仔')
ON CONFLICT (email) DO UPDATE
SET nickname   = EXCLUDED.nickname,
    updated_at = now();
```

要点：

- `EXCLUDED` 是一个特殊表别名，引用「试图插入」的新值；原行数据直接用表名引用（如 `users.login_count`）。
- 省略冲突目标写成 `ON CONFLICT DO NOTHING` 时，任何唯一约束冲突都忽略；但 `DO UPDATE` 必须写明冲突目标。
- 唯一约束可以不只是单列，`ON CONFLICT (tenant_id, email)` 这类组合唯一键同样适用。

## RETURNING：拿回写入后的行

`INSERT` / `UPDATE` / `DELETE` 都可以带 `RETURNING`，像 SELECT 一样返回受影响的行。最常见的用途是取回自增主键，省掉一次 `SELECT currval` 或「插入后按唯一键查一遍」：

```sql
INSERT INTO users (email, nickname) VALUES ('e@example.com', '小王')
RETURNING id, nickname;          -- 直接拿到新 id

UPDATE users SET login_count = login_count + 1
WHERE email = 'a@example.com'
RETURNING login_count;           -- 拿到更新后的值

DELETE FROM users WHERE email = 'e@example.com'
RETURNING id;
```

配合 UPSERT 时：`DO UPDATE ... RETURNING` 返回更新后的行；被 `DO NOTHING` 跳过的行不会出现在结果里，需要区分「新建还是已存在」时不要用 `DO NOTHING`。

## 注意事项与常见坑

- **UPDATE / DELETE 漏写 WHERE** 会作用于全表。先在事务里用 `BEGIN;` 包住执行，确认影响行数再 `COMMIT;`，是低成本的保护习惯。
- **同一语句内的多值插入互相冲突**：`VALUES` 里两行有相同的唯一键时，`ON CONFLICT` 不会在语句内部去重，会报 `ON CONFLICT DO UPDATE command cannot affect row a second time`。批量导入前先按唯一键去重。
- **并发 UPSERT**：两个事务同时 upsert 同一个键时，后到者会等待前者提交再走更新分支，语义安全；但大批量按不同顺序 upsert 多行可能互相等待造成死锁，批量写入时先把行按唯一键排序，见 [批量写入](../advanced-sql/batch-and-write)。
- **`ON CONFLICT` 判定的是唯一约束，不是业务语义**。换了另一个唯一约束（比如表上还有手机号唯一键），同一条插入也可能在没写的约束上冲突而走不进你预期的分支。
- TRUNCATE 与 `DELETE` 的取舍涉及锁和死元组回收，见 [VACUUM 与 HOT](../internals/vacuum-and-hot)。

## 参考资料

- [PostgreSQL 官方文档 · Part I. Tutorial](https://www.postgresql.org/docs/current/tutorial.html)
- [PostgreSQL 官方文档 · The SQL Language](https://www.postgresql.org/docs/current/sql.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [WHERE 与表达式](./where-and-expressions)
- [事务基础](./transaction-basics)
- [批量写入](../advanced-sql/batch-and-write)
- [常见错误与排查](../appendix/common-errors-and-troubleshooting)
- [batch-and-write](/advanced-sql/batch-and-write.md)
- [sql-command-reference](/appendix/sql-command-reference.md)
- [index](index.md)
- [primary-key-design](/database-design/primary-key-design.md)
- [transactions-and-isolation](/internals/transactions-and-isolation.md)
- [real-world-cases](/tools/real-world-cases.md)
官方文档：[INSERT](https://www.postgresql.org/docs/current/sql-insert.html)、[UPDATE](https://www.postgresql.org/docs/current/sql-update.html)、[DELETE](https://www.postgresql.org/docs/current/sql-delete.html)。
