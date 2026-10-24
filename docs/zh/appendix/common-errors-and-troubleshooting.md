# 常见错误与排查对照表

错误信息以 PostgreSQL 实际报错原文给出（错误串前带 `ERROR: ` / `FATAL: ` 前缀），右侧给常见原因与处置。下文三个高频错误附完整排查路径。

## 错误信息对照表

| 错误信息（原文） | 常见原因 | 处置 |
| --- | --- | --- |
| `ERROR:  duplicate key value violates unique constraint "users_pkey"` + `DETAIL:  Key (id)=(1) already exists.` | 重复提交、序列与 max(id) 不同步、并发写没有 ON CONFLICT | 查重数据；`ON CONFLICT` 幂等写；`setval` 同步序列 |
| `ERROR:  relation "users" does not exist` | 表名拼错、schema 不在 search_path、连错库、大小写未加引号 | `\dt`、`SET search_path TO app, public;`、核对连接串 |
| `ERROR:  permission denied for table users` | 当前角色没有该表的相应权限 | `\dp users` 看授权，用 GRANT 补权限 |
| `ERROR:  permission denied for schema public` | PG 15 起 public schema 默认不再允许普通用户 CREATE | `GRANT CREATE ON SCHEMA public TO app;` 或改用独立 schema |
| `ERROR:  syntax error at or near "SELEC"` | 保留字当标识符、方言差异、拼写错误 | 按 `LINE` 定位问题 token；关键字换名或加引号 |
| `ERROR:  column "nosuchcol" of relation "users" does not exist` | 列名拼错、列已改名、模型与库结构不同步 | `\d users` 对照真实列名 |
| `ERROR:  deadlock detected` + `DETAIL:  Process 313 waits for ShareLock on transaction 760; blocked by process 306.` | 两事务以相反顺序锁多张表 | 统一加锁顺序、缩小事务、捕获错误后重试 |
| `ERROR:  canceling statement due to statement timeout` | `statement_timeout` 到期，慢查询被取消 | 优化 SQL 或索引；区分长短查询、分开设超时 |
| `FATAL:  sorry, too many clients already` | 连接数达到 `max_connections` | 查泄漏连接、上连接池、必要时调大上限 |
| `ERROR:  out of shared memory` + `HINT:  You might need to increase max_locks_per_transaction.` | 单事务持有的对象锁（分区表、大批量 DDL）超过共享锁表 | 拆分事务减少单事务对象数；调大 `max_locks_per_transaction`（重启生效） |
| `ERROR:  could not serialize access due to concurrent update` | 可重复读/可串行化下读写冲突 | 应用层捕获并重试整个事务 |
| `ERROR:  operator does not exist: text + integer` | 操作数类型不匹配且无隐式转换 | 显式 `::` 转型，或修正列类型 |
| `ERROR:  invalid input syntax for type integer: "abc"` | 字符串转数值/时间失败 | 清洗数据；`NULLIF`、正则校验后再转 |
| `FATAL:  password authentication failed for user "postgres"` | 密码错误或未设置、pg_hba 认证方式不匹配 | 用 `ALTER ROLE ... PASSWORD` 重设；核对 pg_hba.conf |
| `ERROR:  tuple concurrently updated` | 并发修改同一系统目录行（同一函数被同时 CREATE OR REPLACE、同对象并发 DDL） | 错开执行或重试 |
| `ERROR:  invalid byte sequence for encoding "UTF8": 0x80` | 客户端送入的字节流不是合法 UTF-8 | 检查客户端编码设置与数据源编码 |
| `psql: error: connection to server at "localhost", port 5432 failed: Connection refused` | 服务未启动、端口不对、防火墙拦截 | `pg_isready -h host -p port` 验证；检查服务状态与监听地址 |

## 排查一：permission denied

先确认"我是谁、东西是谁的"：

```sql
SELECT current_user, session_user;          -- 当前生效角色与登录角色
SELECT current_database(), current_schema();
```

再看对象上现有的授权：

```sql
-- 命令行：\dp users
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_name = 'users';
```

若授权记录缺失，检查当前角色是否通过角色继承间接获得权限：

```sql
SELECT rolname
FROM pg_roles
WHERE pg_has_role(current_user, oid, 'member');
```

确认后补授权。PG 15 起应用账号默认不能在 `public` 建表，需要显式授权：

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO app;
GRANT USAGE ON SCHEMA public TO app;
GRANT CREATE ON SCHEMA public TO app;        -- 仅当确实需要在该 schema 建表时
```

## 排查二：duplicate key value violates unique constraint

按 `DETAIL:  Key (id)=(1) already exists.` 的键值直接查重复行：

```sql
SELECT * FROM users WHERE id = 1;
```

确认约束来源（主键还是业务唯一索引）：

```text
postgres=> \d users
```

最常见诱因是"显式插入过 id、序列没跟上"，用 `setval` 对齐：

```sql
SELECT setval(pg_get_serial_sequence('users', 'id'), (SELECT max(id) FROM users));
```

并发或重试场景改成幂等写法：

```sql
INSERT INTO users (id, name) VALUES (1, '张三')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
```

## 排查三：sorry, too many clients already

先按状态统计连接分布：

```sql
SELECT state, count(*) FROM pg_stat_activity GROUP BY state ORDER BY count(*) DESC;
```

定位长时间空闲或事务内空闲的连接及其来源：

```sql
SELECT pid, usename, application_name, client_addr, state,
       now() - xact_start AS xact_age, left(query, 60) AS query
FROM pg_stat_activity
WHERE state LIKE 'idle%'
ORDER BY xact_age NULLS FIRST;
```

处置分三层：

1. 立即干预：`SELECT pg_terminate_backend(pid);` 断开确认泄漏的连接；
2. 短期防御：设 `idle_in_transaction_session_timeout` 与 `statement_timeout`，让空闲连接自动退出；
3. 治本：接入连接池（如 PgBouncer）、检查 ORM 连接池参数，再评估是否调大 `max_connections`（重启生效，注意共享内存开销，并留足 `superuser_reserved_connections`）。

## 参考资料

- [PostgreSQL 官方文档 · 27.2. The Cumulative Statistics System](https://www.postgresql.org/docs/current/monitoring-stats.html)
- [PostgreSQL 官方文档 · SQL Commands](https://www.postgresql.org/docs/current/sql-commands.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [锁冲突排查](/zh/internals/lock-conflict-troubleshooting)
- [连接与 ORM 优化](/zh/performance/connection-and-orm-optimization)
- [排障工具箱](/zh/tools/troubleshooting-toolbox)
- [常见错误](/zh/basics/common-beginner-mistakes)
- [index](/zh/appendix/index)
- [psql-meta-command-reference](/zh/appendix/psql-meta-command-reference)
- [references-and-docs](/zh/appendix/references-and-docs)
- [common-beginner-mistakes](/zh/basics/common-beginner-mistakes)
- [crud-and-on-conflict](/zh/basics/crud-and-on-conflict)
- [parameter-tuning](/zh/performance/parameter-tuning)
- [pg-hba-and-authentication](/zh/security/pg-hba-and-authentication)
官方文档：[错误码附录](https://www.postgresql.org/docs/current/errcodes-appendix.html)、[pg_stat_activity 视图](https://www.postgresql.org/docs/current/monitoring-stats.html)
