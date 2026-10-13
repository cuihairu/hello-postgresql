# 数据库与 schema 对象

PostgreSQL 的对象从大到小分成四层：**集群（cluster）→ 数据库（database）→ schema → 表/视图/索引等关系对象**。每一层都有自己的 owner，权限控制也是逐层授予的。理清这四层，`search_path`、跨 schema 引用、`\dt` 看不到表这类问题就有了统一解释。对应官方文档：[Schemas](https://www.postgresql.org/docs/current/ddl-schemas.html) 与 [Database 管理](https://www.postgresql.org/docs/current/managing-databases.html)。

## 四层层级与 owner

```text
cluster（一个 PGDATA 数据目录 + 一组进程）
└── database: appdb            ← owner: postgres
    └── schema: public         ← owner: pg_database_owner
        ├── table: users       ← owner: app
        ├── view: v_active
        └── index: users_pkey
```

- **集群**由 `initdb` 创建，是一个物理概念：一个数据目录、一组后台进程、一份 `postgresql.conf` / `pg_hba.conf`。一个集群里可以有多个数据库，**连接串里的数据库是强隔离的**——跨库查询要靠 FDW 或 `dblink`，不能直接 JOIN。
- **数据库**是权限与连接的边界，`CREATE DATABASE appdb OWNER app;` 指定 owner。
- **schema** 是库内的命名空间，把表、视图、函数、类型分组。同一个库内可以跨 schema 直接 JOIN。
- **表、视图、索引、序列、函数、类型**等对象归属于某个 schema，同时每个对象都有一个 owner（role）。

owner 是"谁创建谁拥有"：建表的人自动成为表 owner，owner 默认拥有该表的全部权限，还可以再 `GRANT` 给别人。删除对象、改结构这些 DDL 权限只跟 owner（或超级用户）走，与查询权限是两回事。

## 数据库与 schema 的常用操作

```sql
-- 数据库层（要在连接到某个库的状态下执行 CREATE DATABASE）
CREATE DATABASE shop OWNER app ENCODING 'UTF8';

-- schema 层
CREATE SCHEMA sales;                      -- 建命名空间
CREATE SCHEMA IF NOT EXISTS sales AUTHORIZATION app;  -- 指定 owner
CREATE TABLE sales.orders (               -- 在指定 schema 下建表
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    region      text NOT NULL,
    amount      numeric(10,2) NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO sales.orders (region, amount) VALUES
    ('north', 120.50), ('south', 88.00);

-- 删 schema（CASCADE 会连带删掉里面的对象，慎用）
-- DROP SCHEMA sales CASCADE;
```

## public schema 与 PG15+ 权限收紧

每个库默认自带一个 `public` schema。PG 14 及之前，它对所有用户开放 `CREATE` 和 `USAGE`——任何能连上库的用户都能在 public 里建表，多租户或多人协作时容易造成对象散落和命名冲突。

**PG 15 起**，初始化出来的 `public` schema 只允许 owner（`pg_database_owner` 这个伪角色，指向当前库的 owner）写入，普通用户只有 `USAGE`。想在 public 建表需要显式授权：

```sql
-- PG15+ 里普通用户默认无法在 public 建表
GRANT USAGE  ON SCHEMA public TO app;
GRANT CREATE ON SCHEMA public TO app;   -- 需要时才放开
```

升级老库到 PG 15+ 时注意：已有库里 public 的旧授权不会被自动改掉，新初始化的库才是收紧后的默认值。

## search_path：不带 schema 前缀的名字去哪找

写 `SELECT * FROM users` 时没有写 schema，PG 会按 `search_path` 里列出的顺序逐个 schema 查找。查看与修改（完整规则见官方 [Statement Behavior 中的 schema 搜索路径](https://www.postgresql.org/docs/current/runtime-config-client.html#GUC-SEARCH-PATH)）：

```sql
SHOW search_path;
--   search_path
-- ----------------
--  "$user", public

SET search_path TO sales, public;          -- 只影响当前会话，断开自动还原
SET LOCAL search_path TO sales;            -- 只影响当前事务
ALTER ROLE app SET search_path TO sales;   -- 对某角色持久生效
ALTER DATABASE shop SET search_path TO sales, public;  -- 对某库持久生效
```

解析规则有四条要点：

1. **按顺序匹配，先到先得**：`search_path` 里的第一个能放下该对象的 schema 是"默认 schema"，`CREATE TABLE users` 会建在这里；查找同名对象时也按这个顺序取第一个命中的。
2. **`"$user"` 是占位符**：展开为与当前角色同名的 schema（存在才生效），不存在就跳过。
3. **系统 schema `pg_catalog` 总是隐式排在最前**：即使没写它，内置函数、内置类型、系统表也优先被找到（这也是不要把自己的对象建在 `pg_catalog` 里的原因）。
4. **临时表 schema `pg_temp` 是特殊成员**：不在 `search_path` 里显式列出时，它对表名与类型名的查找仍排在最前；但对函数与运算符名，只有显式列出才会被搜索。

## 跨 schema 引用

不带前缀时按 `search_path` 找；带前缀则精确指定，不受 `search_path` 影响：

```sql
-- 跨 schema JOIN，前缀写法最稳妥
SELECT o.id, o.amount, r.name AS region_name
FROM sales.orders o
JOIN ref.regions r ON r.code = o.region;

-- 视图、函数、序列同理
SELECT sales.next_order_id();
CREATE VIEW report.monthly AS
SELECT date_trunc('month', created_at) AS m, sum(amount) AS total
FROM sales.orders GROUP BY 1;
```

生产代码（ORM、存储过程）建议始终写 `schema.table` 全名，不依赖 `search_path`：一是避免不同环境 `search_path` 配置不一致引发的"本地能跑线上报错"，二是防住 `search_path` 注入这类低级但真实的攻击面（见 [加固清单](../security/hardening-checklist)）。

## 注意事项与常见坑

- **`\dt` 看不到表**多半是 `search_path` 问题：`\dt sales.*` 或先 `SET search_path TO sales` 再看。
- **同名对象在不同 schema 里是两个对象**：`public.users` 与 `sales.users` 可以同时存在，改错了对象不报错但数据对不上。
- **`DROP SCHEMA` 默认拒绝删除非空 schema**，加 `CASCADE` 才连内部对象一起删——生产上先 `DROP SCHEMA ... RESTRICT` 试探是更安全的习惯。
- **database 之间不能直接查询**：连错库报 `relation "xxx" does not exist` 时，先 `\l` 确认连的是不是预期的库。
- **schema 不是"用户"**：PG 里 schema 与 role 是两个概念，只是默认 `"$user"` 占位符让两者名字常常相同。

## 参考资料

- [PostgreSQL 官方文档 · 5.10. Schemas](https://www.postgresql.org/docs/current/ddl-schemas.html)
- [PostgreSQL 官方文档 · Part I. Tutorial](https://www.postgresql.org/docs/current/tutorial.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [psql 入门](./psql-getting-started)
- [数据类型总览](./data-types-overview)
- [多租户建模](../database-design/multi-tenant-modeling)
- [角色与权限](../security/roles-and-permissions)
- [data-types-overview](data-types-overview.md)
- [index](index.md)
- [naming-and-style-conventions](naming-and-style-conventions.md)
- [psql-getting-started](psql-getting-started.md)
- [system-catalogs-and-metadata](system-catalogs-and-metadata.md)
- [what-is-postgresql](what-is-postgresql.md)
- [object-grant-hierarchy](/security/object-grant-hierarchy.md)