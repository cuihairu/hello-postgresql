# CHECK 与域类型

CHECK 约束规定「满足布尔条件的行」才允许写入表；域类型（DOMAIN）则把类型、一组 CHECK 和默认值打包成可复用的自定义类型。这一页看 CHECK 的三类常见写法、NOT VALID 先加后验的操作方式、约束命名规范与拆分取舍，最后是 DOMAIN 的复用方法。

## CHECK 的三类常见写法

```sql
CREATE TABLE products (
    product_id int PRIMARY KEY,
    name       text NOT NULL,
    price      numeric(10,2) NOT NULL,
    status     text NOT NULL,
    sku        text NOT NULL
);

-- 1) 区间：价格必须为正
ALTER TABLE products ADD CONSTRAINT products_price_positive
    CHECK (price > 0);

-- 2) 枚举值：状态限定在固定集合内
ALTER TABLE products ADD CONSTRAINT products_status_valid
    CHECK (status IN ('active', 'draft', 'archived'));

-- 3) 正则：SKU 只允许大写字母、数字和连字符
ALTER TABLE products ADD CONSTRAINT products_sku_format
    CHECK (sku ~ '^[A-Z0-9-]+$');

INSERT INTO products VALUES (1, '笔记本', 4999.00, 'active', 'NB-2026');
INSERT INTO products VALUES (2, '鼠标', -10, 'active', 'MS-01');
-- ERROR: new row for relation "products" violates
-- check constraint "products_price_positive"

INSERT INTO products VALUES (3, '键盘', 299.00, 'on_sale', 'KB-1');
-- ERROR: new row for relation "products" violates
-- check constraint "products_status_valid"
```

固定状态集合除了 CHECK 还可以用 `CREATE TYPE … AS ENUM` 枚举类型，报错更明确、排序按声明顺序。取舍在于演进成本：枚举加值要 `ALTER TYPE … ADD VALUE`（PG 12 起可在事务里执行，但新值要等提交后才能用），而 CHECK 改集合只需删掉重建约束，门槛更低；业务状态会频繁扩充时 CHECK 更省事。

## NOT VALID：先加后验

大表上加 CHECK 约束会全表扫描，期间持有削弱写入的锁。标准做法是两步走：先 `NOT VALID` 挂上约束（只管新写入，不碰历史行），再找低峰期校验存量：

```sql
CREATE TABLE orders (
    order_id int PRIMARY KEY,
    amount   numeric(10,2) NOT NULL,
    status   text NOT NULL DEFAULT 'pending'
);

-- 第一步：快速挂上，不校验历史行（CHECK 的 NOT VALID 自 PG 9.2 起支持）
ALTER TABLE orders ADD CONSTRAINT orders_amount_positive
    CHECK (amount > 0) NOT VALID;

-- 第二步：后台校验存量数据，校验期间只拿共享锁，不阻塞读写
ALTER TABLE orders VALIDATE CONSTRAINT orders_amount_positive;

-- 约束状态可从系统目录确认
SELECT conname, convalidated
FROM pg_constraint
WHERE conrelid = 'orders'::regclass;
```

两点注意：`NOT VALID` 期间新写入仍逐行校验，历史行则不受约束，所以 VALIDATE 完成前表里可能存在不合法的旧数据；如果存量里真的有脏数据，`VALIDATE CONSTRAINT` 会报错终止，不会自动修数，需要先清洗。外键同样支持 `NOT VALID`（更早），用法一致。

## 约束命名规范

约束名会出现在每一条报错里，规范命名让定位快得多。常见约定是 `表名_列名_规则`，例如 `orders_amount_positive`：

```sql
-- 反例：不命名，PG 自动生成 orders_amount_check 这类名字尚可辨认，
-- 多个约束时会出现 orders_check1、orders_check2，读不出含义
ALTER TABLE orders ADD CHECK (amount > 0);

-- 正例：命名后报错能直接定位
ALTER TABLE orders ADD CONSTRAINT orders_amount_positive CHECK (amount > 0);
-- ERROR: new row for relation "orders" violates
-- check constraint "orders_amount_positive"
```

与全库对象命名一起统一，见 [命名与风格约定](../basics/naming-and-style-conventions)。

## 多条件约束 vs 拆开

把多个条件写进一个 CHECK 还是拆成多个约束，看的是排错精度和后续演进：

```sql
-- 合在一起：一次校验，但报错只说「orders_valid 失败」，
-- 得查约束定义才知道是金额还是状态出了问题
ALTER TABLE orders ADD CONSTRAINT orders_valid
    CHECK (amount > 0 AND status <> 'cancelled');

-- 拆开：报错精确到条件，后续可单独删除或改写其中一条
ALTER TABLE orders ADD CONSTRAINT orders_amount_positive CHECK (amount > 0);
ALTER TABLE orders ADD CONSTRAINT orders_status_open CHECK (status <> 'cancelled');
```

经验：条件彼此独立就拆开——错误信息更准，也便于单独 `NOT VALID` 或删除；条件是一个整体规则（如 `start_ts < end_ts`、数组长度与元素范围联动）就合并成一条。

## DOMAIN：打包复用 CHECK

把「基础类型 + 一组 CHECK + 默认值」封装成域类型，多处建表直接复用同一套规则：

```sql
CREATE DOMAIN positive_int AS integer
    CHECK (VALUE > 0);

CREATE DOMAIN email AS text
    CHECK (VALUE ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

CREATE TABLE products_v2 (
    product_id  int PRIMARY KEY,
    stock       positive_int NOT NULL DEFAULT 0,
    owner_email email
);

INSERT INTO products_v2 VALUES (1, 5, 'ops@example.com');

INSERT INTO products_v2 VALUES (2, -1, 'ops@example.com');
-- ERROR: value for domain positive_int violates check constraint "positive_int_check"

INSERT INTO products_v2 VALUES (3, 5, 'not-an-email');
-- ERROR: value for domain email violates check constraint "email_check"
```

使用注意：

- 域类型的演进不如表约束灵活：加 CHECK 用 `ALTER DOMAIN … ADD CONSTRAINT`，改已有规则要先 `DROP CONSTRAINT` 再加回，且改定义要扫描所有使用该域的列。
- 域适合「多处复用、规则稳定」的值（邮箱、手机号、正整数）；只在一处使用的规则，直接写 CHECK 更轻。
- 域上也能加 `NOT VALID` 后验，操作方式与表约束一致。

完整语法见官方文档 [CREATE DOMAIN](https://www.postgresql.org/docs/current/sql-createdomain.html) 与 [DDL 约束](https://www.postgresql.org/docs/current/ddl-constraints.html)。

## 相关页面

- [外键与引用动作](./foreign-keys-and-referential-actions)
- [约束与数据质量](./constraints-and-data-quality)
- [生成列与 CHECK](../advanced-sql/generated-columns-and-check)
- [命名与风格约定](../basics/naming-and-style-conventions)
