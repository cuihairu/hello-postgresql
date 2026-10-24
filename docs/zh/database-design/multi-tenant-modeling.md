# 多租户建模

SaaS 应用要在一套数据库里服务多个租户，核心矛盾是**隔离强度与运维成本的权衡**：隔离越彻底，批量变更、跨租户统计、连接管理越费劲。PostgreSQL 提供三个层级的方案——单表 `tenant_id`、行级安全（RLS）、schema-per-tenant——本篇逐个分析它们的失败模式，以及各自对备份恢复、容量规划、跨租户统计的影响，最后给出推荐路径。

## 三方案对比

| 维度 | 单表 tenant_id | 单表 + RLS | schema-per-tenant |
| --- | --- | --- | --- |
| 隔离强度 | 依赖代码自觉 | 数据库策略强制 | 独立命名空间 |
| DDL/迁移成本 | 跑一次 | 跑一次 | N 个 schema 各跑一遍 |
| 跨租户统计 | 直接 GROUP BY | 直接 GROUP BY | 需要 UNION 或逐 schema 聚合 |
| 单租户备份/恢复 | 按行导出，繁琐 | 同左 | `pg_dump -n` 直接支持 |
| 对象规模 | 表数量固定 | 表数量固定 | 表数量 = 租户数 × 表数 |
| 典型事故 | 漏写 WHERE 串租户 | 策略漏配、表主被绕过 | 目录膨胀、慢租户拖累全局 |

## 方案一：单表加 tenant_id

最简单也最常用：每张业务表加 `tenant_id bigint NOT NULL`，所有查询显式过滤。

```sql
CREATE TABLE orders (
  id         bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  bigint        NOT NULL,
  amount     numeric(12,2) NOT NULL,
  created_at timestamptz   NOT NULL DEFAULT now()
);

-- 业务索引一律以 tenant_id 打头
CREATE INDEX orders_tenant_id_created_at_idx
  ON orders (tenant_id, created_at DESC);

-- 所有业务查询必须带：
SELECT * FROM orders
WHERE tenant_id = 42
  AND created_at >= now() - interval '7 days';
```

优点是建模、迁移、统计都简单。致命弱点是**过滤完全靠人**：一行漏写 `WHERE tenant_id = ...` 的查询，就是一次跨租户数据泄露，而这类事故在代码 review 里极难穷尽排查。缓解手段：ORM 层强制注入过滤条件、code review 检查表、再叠一层 RLS 兜底（见下文）。

## 方案二：行级安全 RLS

在单表方案之上启用 RLS，把租户过滤下沉为数据库策略，即使 SQL 漏写条件也看不到别家数据：

```sql
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;   -- 表主也受策略约束

CREATE POLICY tenant_isolation ON orders
  USING (tenant_id = current_setting('app.tenant_id', true)::bigint);

-- 应用在事务里注入租户上下文
BEGIN;
SET LOCAL app.tenant_id = '42';
SELECT count(*) FROM orders;    -- 只能看到租户 42 的行
COMMIT;
```

两个细节：`current_setting(..., true)` 在变量未设置时返回 NULL 而不是报错，`tenant_id = NULL` 恒为假，实现**未注入就看不到任何行**的 fail-closed 行为；`SET LOCAL` 随事务结束自动失效，避免连接池串号。策略如何被绕过（`BYPASSRLS`、`SECURITY DEFINER` 函数、表主归属）以及性能代价，见 [行级安全](/zh/security/row-level-security)。

RLS 的代价：每条查询多一层过滤求值、策略与索引必须配套（租户列没有索引时全表扫）、排障时 EXPLAIN 会多一层计划节点。官方机制说明见[行安全策略](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)。

## 方案三：schema-per-tenant

每个租户一个 schema，表结构相同、数据完全隔离：

```sql
CREATE SCHEMA tenant_42;
CREATE TABLE tenant_42.orders (LIKE public.orders INCLUDING ALL);

-- 应用连接时指定 schema，业务 SQL 不用改
-- 连接串加：options=-c search_path=tenant_42
```

优点：隔离直观，单租户备份恢复就是 `pg_dump -n tenant_42`，容量也按 schema 一目了然。缺点随租户数线性放大：一次加列要循环跑 N 个 schema（迁移时长与失败重试都要设计）；表总数 = 租户数 × 表数，目录对象膨胀后 psql 元命令、监控、autovacuum 的维护面都变大；共享连接池难以按租户配额隔离，一个大租户的慢查询照样拖累全局。

## 对备份恢复、容量规划、跨租户统计的影响

- **备份恢复**：单表方案恢复单个租户需要按 `tenant_id` 导出再导入，且要注意不要污染其他租户的序列与外键；schema 方案天然按命名空间切分，恢复粒度干净。整库物理备份（PITR）三者无差别，差异只在**单租户粒度**的恢复，见 [备份策略](/zh/operations/backup-strategy)。
- **容量规划**：单表方案用 `pg_total_relation_size` 配合按 `tenant_id` 的行数/字节数统计估算各租户占比；schema 方案直接按 schema 汇总即可。大租户需要物理隔离时，两条路：单独实例，或对大表按 `tenant_id` 做 HASH 分区，见 [表继承与分区表设计](/zh/database-design/table-inheritance-and-partitioning-design) 与 [分区裁剪](/zh/performance/partition-pruning)。
- **跨租户统计**：单表/RLS 方案 `GROUP BY tenant_id` 一条 SQL 搞定；schema 方案要么 UNION ALL 拼接、要么逐 schema 查询后应用层聚合，报表类需求会持续付出复杂度。

## 推荐路径与检查清单

多数 SaaS 的落点：**单表 `tenant_id` 为基础，关键表叠加 RLS 做纵深防御**；租户数量少、单租户数据量大或有强合规隔离要求时才考虑 schema-per-tenant 或独立库。给每个租户建独立数据库通常不划算——连接池与运维成本随租户数线性增长。

上线前逐项核对：

- 每张业务表都有 `tenant_id bigint NOT NULL`，无例外。
- 所有二级索引以 `tenant_id` 打头（或包含在索引前缀里）。
- 关键业务表启用 RLS 并 FORCE，作为漏写过滤时的最后防线。
- 租户上下文用 `SET LOCAL` 在事务内注入，不拼接进 SQL 字符串。
- 为运维/统计建独立角色访问全量数据，并纳入审计。
- 迁移模板固定包含 `tenant_id` 列与配套索引，避免新表漏配。

## 参考资料

- [PostgreSQL 官方文档 · 5.5. Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
- [PostgreSQL 官方文档 · 5.12. Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [行级安全](/zh/security/row-level-security)
- [逻辑建模到物理落地](/zh/database-design/logical-to-physical-modeling)
- [表继承与分区表设计](/zh/database-design/table-inheritance-and-partitioning-design)
- [备份策略](/zh/operations/backup-strategy)
- [database-and-schema-objects](/zh/basics/database-and-schema-objects)
- [index](/zh/database-design/index)
- [table-inheritance-and-partitioning-design](/zh/database-design/table-inheritance-and-partitioning-design)
- [knowledge](/zh/knowledge)
- [row-level-security](/zh/security/row-level-security)