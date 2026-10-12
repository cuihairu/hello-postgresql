# 软删除与墓碑

软删除指不执行 `DELETE`，而是写入删除标记（通常是 `deleted_at` 时间戳），被标记的行称为墓碑（tombstone）。它的动机是误删可恢复、数据可审计、外键历史不断裂，但代价是所有查询都要带过滤条件、唯一约束会出现 NULL 陷阱、表会持续膨胀。本篇给出软删的标准写法，以及它和外键、级联、清理策略的配合方式。

## deleted_at 基本模式

```sql
CREATE TABLE accounts (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email      text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz              -- NULL 表示存活
);

-- 软删
UPDATE accounts SET deleted_at = now() WHERE id = 42;

-- 活跃数据查询
SELECT * FROM accounts WHERE deleted_at IS NULL;
```

用 `timestamptz` 而不是 `is_deleted boolean` 的理由：删除时间可用于审计追责、按保留期清理、以及"误删恢复到某时刻"的判断。字段惯例（与 `created_at`/`updated_at` 并列）见 [逻辑建模到物理落地](./logical-to-physical-modeling)。

## 唯一约束的 NULL 陷阱

软删之后最常见的翻车点是唯一约束。假设需求是"同一 email 只能有一条存活记录"，直觉写法：

```sql
CREATE TABLE accounts (
  email      text NOT NULL,
  deleted_at timestamptz,
  UNIQUE (email, deleted_at)      -- 想法：组合唯一
);

INSERT INTO accounts (email) VALUES ('a@example.com');
INSERT INTO accounts (email) VALUES ('a@example.com');   -- 居然成功了！
```

第二行没被拒绝。原因是唯一约束中 **NULL 与任何值（包括另一个 NULL）都不相等**（官方文档[唯一约束](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-UNIQUE-CONSTRAINTS)一节有说明），`('a@example.com', NULL)` 和 `('a@example.com', NULL)` 被视为不同的组合值，存活行因此可以无限重复。两种修法：

```sql
-- 修法一（推荐）：部分唯一索引，只约束存活行
CREATE UNIQUE INDEX accounts_email_live_uidx
  ON accounts (email) WHERE deleted_at IS NULL;

-- 修法二（PG 15 起）：NULLS NOT DISTINCT 让 NULL 视为相等
ALTER TABLE accounts ADD CONSTRAINT accounts_email_del_key
  UNIQUE NULLS NOT DISTINCT (email, deleted_at);
```

优先用修法一。修法二有一个副作用：它把**所有列组合**里的 NULL 都视为相等，于是两条 `email` 相同、`deleted_at` 时间戳也完全相同的墓碑行也会冲突——批量软删（同一事务里 `now()` 值相同）刚合并的重复账号时可能被误伤。部分唯一索引的更多用法见 [部分索引](../indexing/partial-indexes)。

## 所有查询都要带过滤

软删引入了一条隐式规则：**业务查询一律带 `deleted_at IS NULL`**，漏一处就是事故。几个降低漏写概率的手段：

- ORM 配置默认作用域（SQLAlchemy 的 `query.filter` 封装、Django 的 default manager），让默认查询自动过滤。
- 用视图给统计和报表一个固定口径：

  ```sql
  CREATE VIEW accounts_live AS
  SELECT * FROM accounts WHERE deleted_at IS NULL;
  ```

- `count(*)`、不带过滤的导出脚本、跨库同步工具都会把墓碑算进去，统计口径要在文档里写明用哪个视图。

## 数据膨胀与定期清理

墓碑行不会被 autovacuum 回收——它们是活行，只是被过滤。随着时间推移：表和索引变大、顺序扫描变慢、autovacuum 要维护的死元组变多（后台机制见 [VACUUM 与 HOT](../internals/vacuum-and-hot)）。必须有归档策略：

```sql
-- 到期墓碑搬进归档表再删除（归档表可按月分区或导对象存储）
CREATE TABLE accounts_tombstones (LIKE accounts INCLUDING ALL);

WITH moved AS (
  DELETE FROM accounts
  WHERE deleted_at < now() - interval '180 days'
  RETURNING *
)
INSERT INTO accounts_tombstones SELECT * FROM moved;
```

大批量删除时避免一条语句删几百万行——长事务、锁与 WAL 压力都会出问题，用 `LIMIT` 分批循环执行，批量写入的做法见 [批量写入](../advanced-sql/batch-and-write)。

## 与外键、级联、审计的兼容问题

- **外键照常成立**：软删的父行对数据库来说仍然存在，子表还能继续插入指向它的外键。业务上如果"已删用户不能再下单"，这条约束数据库帮不上忙，要靠应用层或触发器检查。
- **级联不会发生**：`ON DELETE CASCADE` 只对真 `DELETE` 生效。软删父表不会级联软删子表，需要级联时要么应用层显式逐表 `UPDATE`，要么用触发器补齐。
- **被软删的资源仍占坑**：部分唯一索引解决了"存活行唯一"，但如果业务要求邮箱释放后可被新用户注册，就得允许"墓碑与新行共存"——这正是部分唯一索引只索引存活行的效果。
- **审计视角**：软删本质是 UPDATE，普通审计触发器能记录到；但要意识到墓碑仍可被"恢复"（把 `deleted_at` 改回 NULL），对不可变性要求高的场景要配合审计与权限控制。

## 硬删还是软删

- **合规要求真删除时，软删等于没删**：用户注销、个人信息删除权这类场景，必须硬删或彻底匿名化（并把墓碑一并清掉），否则数据仍在库里。
- **不要拿软删当备份**：误删恢复的正解是备份与时间点恢复（PITR），见 [备份策略](../operations/backup-strategy)。
- **常见折中**：软删 + 有限保留期（如 30/90 天）+ 到期归档硬删，兼顾误删恢复与合规。

## 相关页面

- [逻辑建模到物理落地](./logical-to-physical-modeling)
- [反模式清单](./anti-patterns)
- [部分索引](../indexing/partial-indexes)
- [VACUUM 与 HOT](../internals/vacuum-and-hot)
