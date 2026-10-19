# 视图与可更新视图

视图（View）是「存起来的查询」：不保存数据，只保存 SELECT 定义，每次查询视图都实时执行底层 SQL。这里整理简单视图为什么能直接 INSERT/UPDATE/DELETE、自动更新的规则清单、WITH CHECK OPTION 如何阻止写入越界，以及视图与 CTE、子查询的取舍。

## 视图是存起来的查询

```sql
CREATE TABLE users (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username   text NOT NULL,
    level      int NOT NULL DEFAULT 0,
    deleted_at timestamptz
);

INSERT INTO users (username, level) VALUES ('alice', 5), ('bob', 2), ('carol', 7);

CREATE VIEW active_users AS
SELECT id, username, level
FROM users
WHERE deleted_at IS NULL;

-- 查视图和查普通表一样，看到的永远是最新数据
SELECT * FROM active_users ORDER BY level DESC;

-- 定义存在系统目录里，随时可查
SELECT pg_get_viewdef('active_users', true);
```

视图的典型用途：给复杂查询一个稳定名字，应用层不必重复拼 JOIN；暴露表的子集做权限隔离（`GRANT SELECT ON 视图 TO 角色`，不授权底层表）；屏蔽底层表结构变更（视图定义跟着改，对外接口不变）。它不缓存任何数据——想存快照要用 [物化视图](./materialized-views)。

## 简单视图可以自动更新

满足全部下列条件的视图可以被直接写入，PG 会把操作改写到底层表：

- 视图只有一个数据源：`FROM` 里恰好一张表（或另一个可更新视图）；
- 顶层不含 `WITH`、`DISTINCT`、`GROUP BY`、`HAVING`、`LIMIT`、`OFFSET`、`UNION/INTERSECT/EXCEPT`；
- 输出列里没有聚合函数、窗口函数、集合返回函数。

```sql
-- 可更新：单表、无聚合、无 DISTINCT/GROUP BY/LIMIT
CREATE VIEW vip_users AS
SELECT id, username, level
FROM users
WHERE level >= 5;

-- 直接写，等价于操作 users 表里对应的行
UPDATE vip_users SET level = 6 WHERE id = 2;
INSERT INTO vip_users (username, level) VALUES ('dave', 5);
DELETE FROM vip_users WHERE id = 3;
```

带聚合、JOIN、DISTINCT 的视图默认不可更新；确实需要写入这类视图时，用 `INSTEAD OF` 触发器把写入逻辑接管过来，或改为直接写底层表。自动更新的完整规则清单见官方文档 [CREATE VIEW](https://www.postgresql.org/docs/current/sql-createview.html)。

## WITH CHECK OPTION 阻止写入越界

对带筛选条件的视图，默认的写入可能把行写到「视图看不见」的地方——行在底层表里存在，但通过视图查不到，等于数据从视图的视角蒸发了：

```sql
CREATE VIEW vip_users AS
SELECT id, username, level
FROM users
WHERE level >= 5
WITH CHECK OPTION;

-- 把 level 改到 5 以下，行会脱离视图范围，被拒绝
UPDATE vip_users SET level = 3 WHERE id = 1;
-- ERROR: new row violates check option for view "vip_users"
```

`WITH CHECK OPTION` 要求每次通过视图的 INSERT 新行、UPDATE 后的行都必须仍然满足视图的 WHERE 条件（`CASCADED`/`LOCAL` 控制是否沿视图链向下检查）。它解决的是数据一致性问题而不是安全问题——按角色限制能看哪些行，应该用 RLS（见 [行级安全](../security/row-level-security)）。

## security_barrier 一句话

带 `WITH (security_barrier)` 的视图会阻止外部查询的谓词被推进视图内部、越过视图自身的过滤条件先执行——防止用户自定义函数在「本不该看见的行」上被调用而泄露数据。配合 RLS 暴露受限数据时建议加上；代价是这类视图失去自动更新能力，规划器能做的下推优化也变少。

## 视图 vs CTE / 子查询

三者都在「封装一段 SQL」，差别在生命周期和复用边界：

| 维度 | 视图 | CTE（WITH） | 子查询 |
|---|---|---|---|
| 定义位置 | 数据库里，跨会话存在 | 单条语句内 | 单条语句内 |
| 复用范围 | 任意查询、可单独授权 | 仅本条语句 | 仅本条语句 |
| 物化 | 永不物化，每次实时执行 | PG 12+ 默认内联，可 `MATERIALIZED` 强制物化 | 由规划器决定 |
| 典型用途 | 稳定接口、权限隔离 | 递归查询、分段拆解复杂查询 | 一次性嵌套 |

选择原则：只在一条语句里用一次的，写子查询或 CTE 就够；要被多处复用、或要做权限隔离的，才建成视图。CTE 的写法与内联行为见 [CTE 与非递归 WITH](../advanced-sql/cte-and-non-recursive-with)。

## 参考资料

- [PostgreSQL 官方文档 · 5.5. Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
- [PostgreSQL 官方文档 · 5.12. Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [物化视图](./materialized-views)
- [CTE 与非递归 WITH](../advanced-sql/cte-and-non-recursive-with)
- [行级安全](../security/row-level-security)
- [系统目录与元数据](../basics/system-catalogs-and-metadata)
- [index](index.md)
- [materialized-views](materialized-views.md)