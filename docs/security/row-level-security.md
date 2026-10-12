# 行级安全 RLS

行级安全（Row Level Security, RLS）把"哪些行可见、可改"的策略下沉到内核：无论 SQL 怎么写、应用层漏没漏 WHERE 条件，PostgreSQL 都会在每次访问该表时强制追加过滤。它是多租户隔离的兜底手段，也常用于给只读角色限定数据范围。定位要想清楚：RLS 适合兜底防御，不适合替代应用层的权限逻辑。

## 打开 RLS：ENABLE 与 FORCE

RLS 按表开启，配合策略生效：

```sql
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
```

开启后有两类角色**不受策略约束**：超级用户和带 `BYPASSRLS` 属性的角色永远绕过；表的属主默认也绕过（方便迁移和备份工具工作）。要让属主同样被管住，加 `FORCE`：

```sql
ALTER TABLE orders FORCE ROW LEVEL SECURITY;   -- 属主也走策略
```

还有一条容易踩的规则：**开了 RLS 但没写任何策略的表，非属主读不到任何行**（默认全拒绝）。这个特性可以直接当"开关式封禁"用，但也意味着先开 RLS 再补策略的窗口期内，应用会突然查空——上线顺序上先建策略、再开 ENABLE 更稳。

## CREATE POLICY：USING 与 WITH CHECK

```sql
CREATE POLICY tenant_isolation ON orders
  FOR ALL                      -- 作用于 SELECT / INSERT / UPDATE / DELETE
  TO app_rw                    -- 只约束这个角色
  USING (tenant_id = current_setting('app.tenant_id')::int)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::int);
```

两个子句的分工：

| 子句 | 何时评估 | 作用 |
| --- | --- | --- |
| `USING` | 读旧行：SELECT、UPDATE/DELETE 匹配行时 | 行不可见即等于不存在 |
| `WITH CHECK` | 写新行：INSERT、UPDATE 的新值 | 写入别的租户的数据直接报错 |

`FOR` 可细化为 `SELECT` / `INSERT` / `UPDATE` / `DELETE` / `ALL`；不写 `TO` 默认约束所有角色（含 `PUBLIC`）；两个子句都不写时默认 `true`。多个策略的合并规则：同为 PERMISSIVE（默认）的策略之间取 **OR**，`AS RESTRICTIVE` 声明的策略与它们取 **AND**——常用来叠一条"必须满足"的硬约束（如"已删除的行永远不可见"）。

## 上下文方式一：一租户一个数据库角色

最直接的方式是把租户（或用户等级）映射成角色，策略引用 `current_user`：

```sql
CREATE POLICY p ON orders FOR SELECT TO tenant_42
  USING (tenant_id = 42);
```

角色数量可控时可用；几千个租户各建一个角色会让角色目录膨胀、管理成本陡增，多数场景改用下面的会话变量方式。

## 上下文方式二：会话变量 current_setting

应用在连接（或事务）开始时把租户 ID 写进自定义 GUC，策略里读取：

```sql
-- 应用侧：每条事务开头执行
SELECT set_config('app.tenant_id', '42', true);   -- true = 仅当前事务有效

-- 策略侧
USING (tenant_id = current_setting('app.tenant_id')::int)
```

两个工程细节决定这套方案的可靠性：

- `current_setting('app.tenant_id', true)` 的第二个参数 `missing_ok` 表示未设置时返回 NULL 而不是报错——NULL 比较永假，忘记注入上下文时整表返回空，失败方向是安全的；更稳的写法是 `NULLIF(current_setting('app.tenant_id', true), '')::int`。
- 用 `SET LOCAL` / `set_config(..., true)`（事务级）而不是 `SET`（会话级）：连接归还连接池时上下文自动清空。若用了会话级，务必在归还前 `RESET ALL`，否则下一个借走连接的租户会看到上一个租户的数据。

## 完整多租户示例

```sql
CREATE TABLE orders (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  int NOT NULL,
  amount     numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON orders (tenant_id, created_at);   -- 策略过滤靠它走索引

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_rw ON orders
  FOR ALL TO app_rw
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int);
```

## 性能与计划影响

- 策略条件会追加到每一次对这张表的扫描上，行数大的表重点确认 `tenant_id` 过滤能走索引（上面的复合索引就是为它建的）。
- 一个已知的计划限制：基于 `current_setting()` 的策略条件对规划器是"不透明"的，**无法匹配谓词写死常量的部分索引**（如 `CREATE INDEX ... WHERE tenant_id = 42`），规划器无法证明策略条件蕴含该索引谓词。需要这类索引收益时，改用普通复合索引，或把租户谓词显式写进业务查询配合索引。
- 策略条件按 `security_barrier` 处理，会阻止规划器把查询条件下推合并；复杂视图叠加 RLS 后计划可能变差，上线前用 EXPLAIN 对比开启前后的计划。
- `SECURITY DEFINER` 函数以属主身份执行，未 `FORCE` 的表在函数内部会绕过 RLS——既是做"后台全量处理"的手段，也可能是意外的提权漏洞面，用之前想清楚。

## 应用中间件如何注入上下文

集成的关键是"每个事务都注入、注入在业务 SQL 之前"，利用框架的统一入口实现：

```plaintext
请求进入 → 开启事务
  → set_config('app.tenant_id', <当前租户>, true)
  → 执行业务 SQL（无需手写租户过滤，RLS 兜底）
  → 提交/回滚（事务级 GUC 随事务结束失效，连接干净归还池）
```

各框架都有挂载点：Django 在中间件里对每个 connection 执行 `cursor.execute("SELECT set_config('app.tenant_id', %s, true)", ...)`；Go 的 `database/sql` 在每个事务的首条语句前执行；Node 的 pg 用 connect 钩子配合事务包装。连接池用 transaction 模式（如 PgBouncer）时，`SET LOCAL` 方案天然兼容；session 模式要自己保证 RESET。绕过中间件直连库的入口（psql、BI 工具、定时脚本）不走注入通道，这类入口要靠 [pg_hba 与认证](./pg-hba-and-authentication)收敛来源、单独授权。

## 注意事项与常见坑

- 只开 `ENABLE` 不加策略，非属主立刻查空——先补策略再上流量。
- 唯一约束与主键不受 RLS 约束：冲突报错可探测"别的租户是否存在这个 ID"，超高敏感场景要意识到这类侧信道。
- `TRUNCATE` 没有行级概念，任何策略都拦不住，别把 `TRUNCATE` 授给业务角色。
- `COPY FROM` 受 `WITH CHECK` 约束、`COPY TO` 受 `USING` 约束（超级用户与属主除外）。
- `UPDATE ... WHERE`、`ON CONFLICT`、`RETURNING` 都可能隐式要求对应行的 `SELECT` 策略，漏配时表现在的报错不会直接指向 RLS。
- SQL 注入可以 `set_config` 伪造租户上下文——RLS 是纵深防御的一层，不是注入漏洞的替代品。

## 相关页面

- [角色与权限模型](./roles-and-permissions)
- [对象授权层级](./object-grant-hierarchy)
- [多租户建模](../database-design/multi-tenant-modeling)
- [加固清单](./hardening-checklist)

官方文档：[行级安全](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)、[CREATE POLICY](https://www.postgresql.org/docs/current/sql-createpolicy.html)。
