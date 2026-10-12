# 对象授权层级

给一张表 `GRANT SELECT` 之后查询仍报权限错误，多半是上游某层没通：PostgreSQL 的对象权限沿**数据库 → schema → 对象（表/序列/函数/列）**三层生效，`CONNECT`、`USAGE` 缺任何一层，下层权限再多也用不上。排查时自上而下逐层确认，比只盯表上的 GRANT 快得多。角色本身怎么建、怎么组队见 [角色与权限模型](./roles-and-permissions)。

## 数据库层：CONNECT

新建的数据库默认允许所有人连接（`CONNECT` 授给了 `PUBLIC`）。实例上跑多个业务时，先把这个默认授权收掉：

```sql
REVOKE CONNECT ON DATABASE app FROM PUBLIC;
GRANT CONNECT ON DATABASE app TO app_rw, app_ro;
```

`CREATE`（在库内建 schema）与 `TEMP`（建临时表）也是数据库级权限，业务角色一般无需额外授予。

## schema 层：USAGE

schema 上的 `USAGE` 决定能否"看到并使用"其中的对象；没有它，即使表上有 `SELECT`，访问也会报 `permission denied for schema`。注意 `USAGE` 不等于 `CREATE`：后者决定能否在 schema 里**新建**对象。PG 15 起默认收紧了一步——`public` schema 的 `CREATE` 不再授予 `PUBLIC`（历史上任何人都能在 public 里建对象，是一块默认的漏洞面），但 `USAGE` 仍对所有人开放，跨版本升级时留意这个行为差异。

```sql
GRANT USAGE ON SCHEMA app TO app_rw;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;   -- PG 15 之前的版本需要手动收
```

## 表与序列

表层权限共七种：`SELECT`、`INSERT`、`UPDATE`、`DELETE`、`TRUNCATE`、`REFERENCES`、`TRIGGER`，可一次授多个：

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA app TO app_ro;
```

序列是独立对象：往带 `serial` / `IDENTITY` 列的表里 `INSERT`，还需要该序列的 `USAGE`（取 nextval 的权限），漏掉会报 `permission denied for sequence`。这是对象授权里最常被遗漏的一层：

```sql
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO app_rw;
```

## 列级授权

只需要开放部分列时，把 GRANT 收窄到列：

```sql
REVOKE SELECT ON users FROM app_ro;
GRANT SELECT (id, email, created_at) ON users TO app_ro;
-- app_ro 查询 password_hash 会报 permission denied for column
```

列级权限的语义是"只授了这些列"：表级 `SELECT` 不存在时，`SELECT *` 会因包含无权限的列而失败——应用里显式写列名比 `SELECT *` 更安全。列级 `INSERT` / `UPDATE` 同理，只允许写入指定列。

## 函数的 EXECUTE 默认给了 PUBLIC

所有函数创建后自动对 `PUBLIC` 开放 `EXECUTE`，任何人都能调用库里的任意函数。用 `SECURITY DEFINER` 函数提权封装敏感操作时，这一点尤其要留意，否则提权入口对全员敞开：

```sql
REVOKE EXECUTE ON FUNCTION purge_expired_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_expired_sessions() TO maintenance;
```

## DEFAULT PRIVILEGES：新建表为什么没权限

`GRANT ... ON ALL TABLES` 只作用于**当下已存在**的对象。迁移再跑一次、`app_owner` 又建了新表，权限立刻断了——除非提前声明默认权限，让"该属主未来建的表"自动带上授权：

```sql
ALTER DEFAULT PRIVILEGES
  FOR ROLE app_owner            -- 只对 app_owner 将来创建的对象生效
  IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;

ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA app
  GRANT SELECT ON TABLES TO app_ro;
```

三个易错点：默认权限绑定的是**属主角色 + schema**，换个人建表就不生效，声明时必须写对 `FOR ROLE`；模板本身可随时用 `ALTER DEFAULT PRIVILEGES ... REVOKE` 修改；它对已有表不做任何事，补权限仍要跑一次显式 `GRANT ... ON ALL TABLES`。这也是"为什么新建的表要显式配权限"的答案：PostgreSQL 的授权不随对象创建自动扩散，默认权限机制就是官方提供的扩散通道。

## 信息藏匿要靠 schema，不是表

系统目录（`pg_catalog`、`information_schema`）对所有用户开放，无法通过撤表权限让别人"看不见"表名——权限不足的查询会明确报出对象名。真正的信息隔离在 schema 层：把敏感表放进独立 schema，收回 `USAGE`，对象清单与数据一起消失：

```sql
CREATE SCHEMA hr;
REVOKE ALL ON SCHEMA hr FROM PUBLIC;
GRANT USAGE ON SCHEMA hr TO hr_rw;
```

## 排查：谁到底有什么权限

```sql
-- psql 里 \dp（等价 \z）直接看对象 ACL；SQL 侧先确认属主
SELECT schemaname, tablename, tableowner FROM pg_tables WHERE schemaname = 'app';

-- PUBLIC 伪角色还能读哪些表（发现意外暴露面）
SELECT schemaname, tablename
FROM pg_tables
WHERE has_table_privilege('public', schemaname || '.' || tablename, 'SELECT');

-- 精确核对某个角色
SELECT has_table_privilege('app_ro', 'app.orders', 'SELECT');   -- t / f

SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'app' AND table_name = 'orders';
```

`has_table_privilege` 传 `'public'` 即代表 PUBLIC 伪角色，可直接扫出所有"默认可读"的表。`\dp` 输出的 ACL 列里 `arwdDxt` 这类字母缩写对应增、删、改、查等权限。

## 注意事项与常见坑

- 报错信息能定位层级：`permission denied for database`、`for schema`、`for table`、`for sequence` 各指一层，别一律去改表的 GRANT。
- 序列权限是最常被遗漏的一层，`serial` 主键一插入就暴露。
- 列级授权后 `SELECT *` 失败常被误判为"权限没生效"，先确认表级权限是否撤干净。
- `information_schema` 的授权视图只列显式 GRANT，不反映属主自带的隐式权限——属主对自己创建的对象永远全权。
- 授权挂在组角色上、配合 `ALTER DEFAULT PRIVILEGES`，比零散的按人授权可维护得多。

## 相关页面

- [角色与权限模型](./roles-and-permissions)
- [行级安全 RLS](./row-level-security)
- [数据库与 schema 对象](../basics/database-and-schema-objects)
- [加固清单](./hardening-checklist)

官方文档：[GRANT](https://www.postgresql.org/docs/current/sql-grant.html)、[权限体系](https://www.postgresql.org/docs/current/ddl-priv.html)、[ALTER DEFAULT PRIVILEGES](https://www.postgresql.org/docs/current/sql-alterdefaultprivileges.html)。
