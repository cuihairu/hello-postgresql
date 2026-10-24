# 角色与权限模型

PostgreSQL 里没有独立的"用户"体系，一切主体都是角色（role）：带 `LOGIN` 属性的角色就是我们通常说的用户，不带 `LOGIN` 的角色则作为组角色（group role）承接权限。推荐的用法不是把权限直接授给一个个登录账号，而是把权限挂在职责明确的组角色上，人与服务通过加入组角色获得能力。权限最终落在哪些对象上、怎么授，见 [对象授权层级](/zh/security/object-grant-hierarchy)；这里先记录角色本身。

## CREATE ROLE 与角色属性

`CREATE USER` 只是 `CREATE ROLE ... LOGIN` 的别名。一个角色能做什么，由属性决定：

| 属性 | 含义 |
| --- | --- |
| `LOGIN` | 允许登录；组角色通常不设 |
| `SUPERUSER` | 绕过一切权限检查，只留给 DBA 运维账号 |
| `CREATEDB` | 可创建数据库 |
| `CREATEROLE` | 可创建、修改、删除（除超级用户外的）角色 |
| `REPLICATION` | 可用于流复制连接 |
| `BYPASSRLS` | 绕过行级安全，见 [行级安全 RLS](/zh/security/row-level-security) |
| `CONNECTION LIMIT n` | 该角色最多同时持有 n 个连接 |

```sql
CREATE ROLE app_rw NOLOGIN;                                 -- 组角色：不能登录
CREATE ROLE alice LOGIN PASSWORD 'S3cret!' IN ROLE app_rw;  -- 建用户并直接入组
CREATE ROLE repl_user LOGIN REPLICATION PASSWORD '...';     -- 流复制专用
ALTER ROLE alice NOLOGIN;                                   -- 离职冻结：先禁登录再决定删不删
```

属性随时可用 `ALTER ROLE` 调整；`pg_roles` 视图能直接查看所有角色属性，不必去翻含密码哈希的 `pg_authid`（后者仅超级用户可读）。

## GRANT 与 REVOKE 常用形态

两类最常用的形态：把组角色授给人（成员关系），把对象权限授给角色（对象授权的完整规则见下一页）。

```sql
-- 成员关系：alice 获得 app_rw 的全部能力
GRANT app_rw TO alice;
GRANT app_rw TO alice WITH ADMIN OPTION;   -- alice 还能把这个角色转授给别人
REVOKE app_rw FROM alice;

-- 对象权限：授给组角色而不是个人
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_rw;
REVOKE DELETE ON orders FROM app_rw;       -- 按单表收紧
```

`WITH ADMIN OPTION` 只管"能否转授这个角色的成员关系"，与对象权限的转授（`WITH GRANT OPTION`）是两回事，不要混用。PG 16 起收紧了 `CREATEROLE`：拥有它的角色只能转授自己持有 ADMIN OPTION 的角色（自己创建的角色默认有），不能再任意给其他角色加成员——共享实例或多工具链环境升级前，先确认现有脚本不依赖旧行为。

## 继承：IN ROLE、INHERIT 与 SET ROLE

角色成员关系默认是**自动继承**的：`alice` 是 `app_rw` 的成员，`app_rw` 有 `SELECT`，`alice` 直接就能 `SELECT`，无需任何额外动作。这由角色的 `INHERIT` 属性控制，默认开启：

```sql
CREATE ROLE alice LOGIN NOINHERIT;   -- 不自动继承，需要手动切身份
SET ROLE app_rw;                     -- alice 切换成 app_rw 身份执行
RESET ROLE;                          -- 切回 alice 自己
```

`IN ROLE` 只是方向的简写：`CREATE ROLE alice LOGIN IN ROLE app_rw` 等价于先建 alice 再 `GRANT app_rw TO alice`。`NOINHERIT` 适合"可切换身份"的场景：管理员平时只是普通角色，需要时 `SET ROLE app_owner` 干活，避免高权限常驻；默认权限检查的是当前有效身份，`SET ROLE` 之后策略与审计看到的都是新身份。PG 16 起还能按单条 GRANT 控制：`GRANT app_rw TO alice WITH INHERIT TRUE, SET FALSE;`——继承权限但不允许切换成该角色，粒度更细。

## PUBLIC：删不掉的隐含角色

`PUBLIC` 是一个永远存在、不能删除的伪角色，所有人（含未来新建的角色）都是它的成员。它默认持有几类权限，是很多"默认就能访问"问题的根源：

```sql
-- 默认情况：所有人可连接任何数据库、可执行所有函数、可使用 public schema
REVOKE CONNECT ON DATABASE app FROM PUBLIC;              -- 收回连接权，按需授给具体角色
REVOKE EXECUTE ON FUNCTION gen_token(text) FROM PUBLIC;  -- 敏感函数不再对所有人开放
GRANT EXECUTE ON FUNCTION gen_token(text) TO app_rw;
```

默认权限的完整盘点与逐层收紧见 [对象授权层级](/zh/security/object-grant-hierarchy)。

## 密码管理

密码哈希算法由 `password_encryption` 决定，**在设置密码那一刻生效**：PG 10 引入 `scram-sha-256`，PG 14 起它成为默认值（此前默认 `md5`）。

```sql
SHOW password_encryption;                    -- 确认当前算法
SET password_encryption = 'scram-sha-256';
ALTER ROLE app_svc PASSWORD '新密码';        -- 用当前算法重新哈希
ALTER ROLE alice VALID UNTIL '2027-01-01';   -- 登录有效期

SELECT rolname, left(rolpassword, 12) AS hash_head
FROM pg_authid
WHERE rolcanlogin;                           -- SCRAM-SHA-256$ 开头即 scram，md5 开头即旧哈希
```

注意两点：升级到 PG 14+ 后，**存量密码不会自动重新哈希**，仍是 md5 的账号需要逐个 `ALTER ROLE ... PASSWORD` 重设；`VALID UNTIL` 只在登录认证时校验，不踢掉已建立的连接。md5 在 pg_hba 里仍可用但已不推荐，认证方法的选择见 [pg_hba 与认证](/zh/security/pg-hba-and-authentication)。

## 最小权限角色设计示例

一套常见的应用角色拆分：属主不登录、读写与只读分离、DDL 变更单独走。

```sql
-- 1. 组角色：均 NOLOGIN，纯承接权限
CREATE ROLE app_owner  NOLOGIN;   -- 表、序列等对象的属主
CREATE ROLE app_rw     NOLOGIN;   -- 应用读写
CREATE ROLE app_ro     NOLOGIN;   -- 报表 / 只读

-- 2. 对象授权（表由 app_owner 创建）
GRANT USAGE ON SCHEMA public TO app_rw, app_ro;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_ro;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;

-- 3. 属主未来新建的对象自动带上授权，避免每次迁移手动补
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO app_ro;

-- 4. 登录账号：人与服务各一个，加入组角色
CREATE ROLE app_svc LOGIN PASSWORD '...' IN ROLE app_rw;
CREATE ROLE alice  LOGIN PASSWORD '...' IN ROLE app_ro;

-- 5. DDL 变更：migration 登录账号加入 owner 组，通过继承获得改结构的能力
CREATE ROLE app_owner_login LOGIN PASSWORD '...' IN ROLE app_owner;
```

要点：应用连接串永远配 `app_svc`，绝不直接用 owner；迁移工具用 `app_owner_login` 登录执行 DDL；报表与 BI 一律走 `app_ro`。需要按行限制可见范围时，在表上叠加 [行级安全 RLS](/zh/security/row-level-security)。

## 注意事项与常见坑

- 用超级用户或 owner 连接跑业务是权限问题的最大来源：误删误改无从限制，[加固清单](/zh/security/hardening-checklist)把它列为第一项。
- `SUPERUSER` 会绕过 RLS、授权检查甚至 `FORCE ROW LEVEL SECURITY`，除运维账号外不要授予任何角色。
- 忘了 `ALTER DEFAULT PRIVILEGES` 是"新表查不了"的最常见原因：GRANT 只作用于已存在的对象。
- 删角色前先处理依赖：`DROP ROLE` 会因"仍被依赖"失败，先 `REASSIGN OWNED BY alice TO app_owner;` 和 `DROP OWNED BY alice;` 再删。
- 角色是**实例级**的：一个实例上的所有数据库共享同一套角色，多业务共实例时用命名前缀区分，避免权限串库。

## 参考资料

- [PostgreSQL 官方文档 · 5.9. Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [PostgreSQL 官方文档 · 20.3. Authentication Methods](https://www.postgresql.org/docs/current/auth-methods.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- 子树总纲：[安全](/zh/security/index)

- [对象授权层级](/zh/security/object-grant-hierarchy)
- [行级安全 RLS](/zh/security/row-level-security)
- [pg_hba 与认证](/zh/security/pg-hba-and-authentication)
- [加固清单](/zh/security/hardening-checklist)
- [sql-functions-advanced](/zh/advanced-sql/sql-functions-advanced)
- [sql-command-reference](/zh/appendix/sql-command-reference)
- [database-and-schema-objects](/zh/basics/database-and-schema-objects)
- [functions-and-operators](/zh/basics/functions-and-operators)
- [extension-management](/zh/ecosystem/extension-management)
- [fdw-and-foreign-data](/zh/ecosystem/fdw-and-foreign-data)
- [postgresql-16-features](/zh/ecosystem/postgresql-16-features)
- [knowledge](/zh/knowledge)
- [disaster-recovery-drills](/zh/operations/disaster-recovery-drills)
- [hardening-checklist](/zh/security/hardening-checklist)
- [index](/zh/security/index)
- [object-grant-hierarchy](/zh/security/object-grant-hierarchy)
- [pg-hba-and-authentication](/zh/security/pg-hba-and-authentication)
- [row-level-security](/zh/security/row-level-security)
- [dbeaver-and-vscode](/zh/tools/dbeaver-and-vscode)
- [pgadmin-4](/zh/tools/pgadmin-4)
官方文档：[CREATE ROLE](https://www.postgresql.org/docs/current/sql-createrole.html)、[角色成员关系](https://www.postgresql.org/docs/current/role-membership.html)、[数据库角色](https://www.postgresql.org/docs/current/database-roles.html)。
