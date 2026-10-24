# 约束与数据质量

数据质量的分层防线从内到外是：NOT NULL → 主键/唯一 → 外键 → CHECK/EXCLUDE → 触发器兜底。原则是**声明式约束优先**：它们对 psql、脚本、ORM、人工修数的一切写入路径生效，应用层校验只是提示。这里整理大表加 NOT NULL 的迁移路径、EXCLUDE 约束防时段重叠、CHECK 与触发器的分工、延迟校验，以及约束对写性能与查询裁剪的影响。

## NOT NULL 策略

小表直接加，一条语句完成（PG 11 起不重写表）：

```sql
ALTER TABLE orders ALTER COLUMN remark SET NOT NULL;
```

大表直接加会触发一次全表扫描校验，持锁时间长。PG 12 起 `SET NOT NULL` 可以复用已有的 `CHECK (col IS NOT NULL)` 约束结论跳过扫描，标准迁移路径是四步：

```sql
-- 1) 先加 NOT VALID 的 CHECK：对新写入立即生效，旧数据暂不校验
ALTER TABLE orders
  ADD CONSTRAINT orders_remark_nn CHECK (remark IS NOT NULL) NOT VALID;

-- 2) 低峰期校验存量数据，只扫一次
ALTER TABLE orders VALIDATE CONSTRAINT orders_remark_nn;

-- 3) SET NOT NULL 复用 CHECK 结论，不再扫描
ALTER TABLE orders ALTER COLUMN remark SET NOT NULL;

-- 4) 清理临时约束
ALTER TABLE orders DROP CONSTRAINT orders_remark_nn;
```

第一步之后所有新写入都会被拦截，中间窗口期的数据质量已经受控。给列加 `DEFAULT` 的操作在 PG 11 起也只改元数据（fast default），不重写表。

## NOT VALID + VALIDATE 迁移路径

`NOT VALID` + `VALIDATE CONSTRAINT` 是给存量表补约束的通用套路，适用于 CHECK 和外键：

```sql
ALTER TABLE order_items ADD CONSTRAINT order_items_order_fk
  FOREIGN KEY (order_id) REFERENCES orders (id) NOT VALID;

ALTER TABLE order_items VALIDATE CONSTRAINT order_items_order_fk;
```

- `ADD CONSTRAINT ... NOT VALID` 只需短暂元数据锁，秒级完成，从此新写入受约束。
- `VALIDATE CONSTRAINT` 扫描存量行，但只持 `SHARE UPDATE EXCLUSIVE` 锁，**不阻塞并发读写**（CHECK 自 PG 9.4 起、外键自 PG 12 起都是该锁级），只与部分 DDL 和 autovacuum 排队互斥。
- 校验前若存量数据确实有脏行，先修数再 VALIDATE，否则校验失败、约束停在"部分生效"状态。

各子句的锁级别与限制详见官方 [ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html) 与[约束](https://www.postgresql.org/docs/current/ddl-constraints.html)文档。

## EXCLUDE 约束：防重叠的声明式武器

唯一约束只能防"相等"，EXCLUDE 约束能防"任意 GiST 操作类定义的冲突"，最典型的是**同一房间同一时段不可双订**：

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- 让 GiST 支持 text/数值等值

CREATE TABLE room_bookings (
  id      bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_no text          NOT NULL,
  during  tstzrange     NOT NULL,
  CONSTRAINT room_bookings_no_overlap
    EXCLUDE USING gist (room_no WITH =, during WITH &&)
);

INSERT INTO room_bookings (room_no, during)
VALUES ('301', tstzrange('2026-03-01 14:00+08', '2026-03-01 16:00+08'));   -- OK

INSERT INTO room_bookings (room_no, during)
VALUES ('301', tstzrange('2026-03-01 15:00+08', '2026-03-01 17:00+08'));
-- ERROR: conflicting key value violates exclusion constraint "room_bookings_no_overlap"
```

`room_no WITH =, during WITH &&` 的含义：两行只要房间相等**且**时段相交即冲突。它内部是一棵 GiST 索引，因此这个约束同时可以当查询索引用（如 `WHERE room_no = '301' AND during && ...`）。区间类型的边界约定见 [时间建模](/zh/database-design/time-modeling)，操作符细节见 [范围类型与 EXCLUDE](/zh/advanced-sql/range-types-and-exclude)。

## CHECK 与触发器的分工

| | CHECK / EXCLUDE | 触发器 |
| --- | --- | --- |
| 校验范围 | 当前行；EXCLUDE 借助索引防跨行冲突 | 任意：可查其他表、其他行 |
| 可延迟 | 否 | 约束触发器可 DEFERRED |
| 维护成本 | 声明即完成 | 需要写函数、测试、防递归 |
| 适用 | 范围、格式、不变式 | 跨表不变式、审计、级联动作 |

分工原则：**能用声明式就用声明式，触发器只兜跨表不变式**。例如"账户余额不得为负"单行可判，用 CHECK；"余额必须等于流水合计"要跨表查，才用触发器或对账任务。两个限制：CHECK 表达式里不能写子查询；不要在 CHECK 里调用非 `IMMUTABLE` 的函数（如 `now()`）——优化器与迁移工具会假设同一行的判定结果恒定。正则、域类型的复用写法见 [CHECK 与域类型](/zh/database-design/check-and-domains)。

## 延迟校验

默认情况下约束逐语句校验；声明 `DEFERRABLE` 后可推迟到事务提交时统一校验，解决"中间态必然冲突"的写入：

```sql
CREATE TABLE steps (
  id  int PRIMARY KEY,
  pos int NOT NULL,
  CONSTRAINT steps_pos_key UNIQUE (pos) DEFERRABLE INITIALLY DEFERRED
);

BEGIN;
UPDATE steps SET pos = 2 WHERE id = 1;   -- 此刻与 id=2 的 pos=2 冲突，但被允许
UPDATE steps SET pos = 3 WHERE id = 2;
COMMIT;                                   -- 提交时统一校验，交换成功
```

- 可声明 `DEFERRABLE` 的约束：UNIQUE、主键、外键；**CHECK 不可延迟**。
- 外键常用 `DEFERRABLE INITIALLY DEFERRED` 解决"先插子表再插父表"的批量导入顺序问题。
- 事务内可用 `SET CONSTRAINTS ... IMMEDIATE` 把校验提前到指定语句之后，避免坏数据拖到提交才报错。
- 相关的外键引用动作（CASCADE/SET NULL）见 [外键与引用动作](/zh/database-design/foreign-keys-and-referential-actions)。

## 约束对性能的影响

- **写放大**：每个唯一/EXCLUDE 约束都是一棵要维护的索引；每个外键让子表写入多一次父表查找。批量导入时常见做法是先卸约束灌数，再用 `NOT VALID + VALIDATE` 补上，通常比带着约束逐行校验快。
- **EXCLUDE 的索引代价高于 btree 唯一索引**：GiST 查询性能与缓存友好度都不如 btree，只在确实需要"防重叠/防冲突"语义的表上用。
- **约束参与查询裁剪**：继承表上的 CHECK 约束配合 `constraint_exclusion = on` 可让优化器跳过不相关的子表；分区表的对应机制是分区裁剪，见 [分区裁剪](/zh/performance/partition-pruning)。
- **VALIDATE 与 autovacuum 排队**：大表 VALIDATE 是长事务形态的扫描，安排在低峰期，避免与 autovacuum 互相等待，背景见 [autovacuum 调优](/zh/internals/autovacuum-tuning)。

## 参考资料

- [PostgreSQL 官方文档 · ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html)
- [PostgreSQL 官方文档 · 5.5. Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [CHECK 与域类型](/zh/database-design/check-and-domains)
- [外键与引用动作](/zh/database-design/foreign-keys-and-referential-actions)
- [范围类型与 EXCLUDE](/zh/advanced-sql/range-types-and-exclude)
- [分区裁剪](/zh/performance/partition-pruning)
- [generated-columns-and-check](/zh/advanced-sql/generated-columns-and-check)
- [check-and-domains](/zh/database-design/check-and-domains)
- [foreign-keys-and-referential-actions](/zh/database-design/foreign-keys-and-referential-actions)
- [index](/zh/database-design/index)
- [money-and-numeric](/zh/database-design/money-and-numeric)
- [time-modeling](/zh/database-design/time-modeling)
- [gist](/zh/indexing/gist)