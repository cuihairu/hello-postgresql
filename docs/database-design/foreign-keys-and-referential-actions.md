# 外键与引用动作

外键（Foreign Key）在两张表之间强制引用完整性：子表（引用方）的值必须在父表（被引用方）里存在。父表的行被删除或更新时，子表对应行如何处理，由 `ON DELETE` / `ON UPDATE` 引用动作决定。这一页过一遍五种动作、延迟约束、外键的索引缺口，以及层级删除与软删的两个坑。

## 引用动作速查

```sql
CREATE TABLE customers (
    customer_id int PRIMARY KEY,
    name        text NOT NULL,
    email       text NOT NULL UNIQUE,
    deleted_at  timestamptz
);

CREATE TABLE orders (
    order_id    int PRIMARY KEY,
    customer_id int REFERENCES customers(customer_id)
        ON DELETE SET NULL      -- 删客户时，订单挂空而不是报错
        ON UPDATE CASCADE       -- 客户主键值变了，订单跟着改
);
```

五种引用动作（`ON DELETE` / `ON UPDATE` 通用）：

| 动作 | 行为 |
|---|---|
| `CASCADE` | 父行删除/更新时，子表匹配行一并删除/更新 |
| `SET NULL` | 子表外键列置 NULL |
| `SET DEFAULT` | 子表外键列恢复为建表时声明的默认值 |
| `RESTRICT` | 存在子行则立即拒绝父行的删除/更新 |
| `NO ACTION` | 同为拒绝，但检查时机可被推迟到事务结束（默认值） |

两个细节：

- 想配 `SET NULL` / `SET DEFAULT`，外键列必须可空（或有默认值），否则父行删除会直接违反非空约束。
- `RESTRICT` 与 `NO ACTION` 都是「有子行就不许删」，区别在时机：`RESTRICT` 立即检查且不可延迟；`NO ACTION` 默认也是语句结束时检查，但约束声明为 `DEFERRABLE` 后可以推迟到提交时。

## DEFERRABLE INITIALLY DEFERRED

批量导入、循环依赖场景下，插入顺序可能暂时「不合法」：子行先进来，父行还在后面。把外键声明为可延迟，校验就推到事务提交时统一做：

```sql
CREATE TABLE users (
    user_id int PRIMARY KEY,
    email   text NOT NULL UNIQUE
);

CREATE TABLE shipments (
    shipment_id int PRIMARY KEY,
    user_id     int NOT NULL REFERENCES users(user_id)
        DEFERRABLE INITIALLY DEFERRED
);

BEGIN;
-- 此刻 users 里还没有 42，但校验被推迟
INSERT INTO shipments VALUES (9001, 42);
INSERT INTO users VALUES (42, 'alice@example.com');
COMMIT;   -- 提交时统一校验，全部合法则成功
```

不改表结构也可以在会话里临时推迟——但只对声明为 `DEFERRABLE` 的约束生效：

```sql
BEGIN;
SET CONSTRAINTS ALL DEFERRED;
-- 乱序写入 …
COMMIT;
```

注意：`CHECK` 约束和 `NOT NULL` 不支持延迟；可延迟的是外键、唯一、排他约束。把外键默认改成 `INITIALLY DEFERRED` 属于特意的架构选择，会让错误暴露点从「语句执行」挪到「事务提交」，排错时要习惯往 COMMIT 上找。

## 引用列常缺索引

外键只在被引用列（父表）上有唯一索引，**子表的引用列不会自动建索引**。后果有两面：

- 删除或更新父表行时，PG 要在子表里找匹配行，没有索引就是全表扫描；
- 应用里 `WHERE customer_id = ?` 这类查询也没有索引可用。

```sql
-- 手动补上引用列索引
CREATE INDEX idx_orders_customer_id ON orders (customer_id);
```

「给外键列建索引」因此成为一条通用经验，除非子表很小、或你确定永远不会删改父表且从不按引用列查询。

## 层级删除与孤儿行

自引用外键（组织架构、评论树）配 `CASCADE` 可以整树删除；不配动作（默认 `NO ACTION`）时删父行会被子行挡住，只能一层层处理：

```sql
CREATE TABLE staff (
    staff_id   int PRIMARY KEY,
    name       text NOT NULL,
    manager_id int REFERENCES staff(staff_id)   -- 默认 NO ACTION
);

INSERT INTO staff VALUES (1, '张总', NULL), (2, '小李', 1), (3, '小王', 2);

DELETE FROM staff WHERE staff_id = 1;
-- ERROR: update or delete on table "staff" violates foreign key
-- constraint "staff_manager_id_fkey" on table "staff"

-- 手动自底向上删，或先把下属改派
DELETE FROM staff WHERE staff_id = 3;
DELETE FROM staff WHERE staff_id = 2;
DELETE FROM staff WHERE staff_id = 1;
```

两个风险值得记住：`CASCADE` 在深层树上放大删除范围，删一个节点可能清空整个子树，上线前要确认这正是想要的语义；而 A 引用 B、B 又引用 A 的循环依赖，通常说明建模该拆中间表，实在需要时用 `DEFERRABLE INITIALLY DEFERRED` 在一条事务里完成双向插入。

孤儿行（子表行在父表里找不到对应）在正常外键路径下不会出现——它只会来自历史数据加 `NOT VALID` 跳过校验、或会话里关掉触发器（`ALTER TABLE … DISABLE TRIGGER ALL`）写入之后。怀疑有孤儿时可以用 `LEFT JOIN ... WHERE 父表.键 IS NULL` 反查。

## 软删与外键不兼容

软删（把 `deleted_at` 置为当前时间代替物理删除）与外键有一个根本矛盾：**外键要求被引用行必须存在，而软删的行在业务上已经「没了」**。

```sql
-- 物理清理软删客户时，被订单挡住
DELETE FROM customers WHERE customer_id = 42;
-- ERROR: update or delete on table "customers" violates foreign key
-- constraint "orders_customer_id_fkey" on table "customers"
```

常见困境有两个：想清理软删用户，必须先处理它名下所有订单（或解除引用）；用户软删后用同一邮箱重新注册，`UNIQUE (email)` 报错。后者用部分唯一索引解决——只对「未删除」的行保证唯一：

```sql
CREATE UNIQUE INDEX customers_email_active
    ON customers (email) WHERE deleted_at IS NULL;
```

软删的完整设计（墓碑、唯一索引、查询过滤）见 [软删与墓碑](./soft-delete-and-tombstone)。

约束体系的整体介绍见官方文档 [DDL 约束](https://www.postgresql.org/docs/current/ddl-constraints.html)。

## 相关页面

- [主键设计](./primary-key-design)
- [软删与墓碑](./soft-delete-and-tombstone)
- [约束与数据质量](./constraints-and-data-quality)
- [CHECK 与域类型](./check-and-domains)
