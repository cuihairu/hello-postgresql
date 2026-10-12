# 逻辑建模到物理落地

逻辑建模回答"有哪些实体、实体之间是什么关系"，物理落地回答"这些关系用什么 DDL 表达、列上放哪些默认值与约束"。这一步做得糙，后续的迁移脚本、ORM 映射、数据质量都会持续还债。本篇按 E-R 图的三种关系给出对应建表法，再落到主键生成、时间戳列、软删字段与 schema/search_path 这些落地惯例，最后用一个完整的订单库脚本串起来。

## 三种关系的建表法

E-R 图上的关系落到表结构只有三种做法：

- **1:N（一对多）**：外键列放在"多"的一端。`orders.user_id` 引用 `users.id`，不要反向在 `users` 表里存 `order_ids` 数组。
- **1:1（一对一）**：外键列加 UNIQUE，或者让子表主键同时就是外键——主键天然唯一，等于免费送了一个约束。
- **N:N（多对多）**：建中间表，两端外键组成**复合主键**，从数据库层面杜绝重复关联。

```sql
-- 1:N：外键在"多"的一端
CREATE TABLE users (
  id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE orders (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users (id)
);

-- 1:1：主键即外键，保证与 users 一一对应
CREATE TABLE user_auth (
  user_id       bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  password_hash text NOT NULL
);

-- N:N：中间表 + 复合主键
CREATE TABLE articles (
  id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL
);

CREATE TABLE tags (
  id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE article_tags (
  article_id bigint NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  tag_id     bigint NOT NULL REFERENCES tags (id)     ON DELETE CASCADE,
  PRIMARY KEY (article_id, tag_id)   -- 同一篇文章不可能重复打同一标签
);
```

中间表如果带业务属性（打标签时间、操作人），可以改成 `id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY` 加 `UNIQUE (article_id, tag_id)`，约束效果等价。复合主键本身就是查询索引，"按文章找标签"无需另建索引，复合列的顺序原则见 [复合索引设计](../indexing/composite-index-design)。

## 主键生成：identity 与 DEFAULT

代理主键推荐 `bigint GENERATED ALWAYS AS IDENTITY`（PG 10 起），相比旧的 `serial` 更规范：序列与列的归属关系在目录里更清晰，且 `ALWAYS` 模式下应用侧显式插入 id 会被拒绝，防止绕过序列制造重复值（确需插入时用 `OVERRIDING SYSTEM VALUE`）。语法见官方 [CREATE TABLE](https://www.postgresql.org/docs/current/sql-createtable.html) 文档，类型选型（bigint / UUIDv7）与游标分页的影响见 [主键设计](./primary-key-design)。

`DEFAULT` 子句负责"不传就给值"：主键由 identity 生成，时间戳由 `DEFAULT now()` 填，状态用 `DEFAULT 'pending'` 定初始态。原则是**默认值交给数据库**，让 psql、脚本、ORM、人工修数走任何路径写入都不会出现"忘了填"的 NULL。

## 时间戳列惯例

```sql
created_at timestamptz NOT NULL DEFAULT now(),
updated_at timestamptz NOT NULL DEFAULT now()
```

- 两列都用 `timestamptz NOT NULL DEFAULT now()`，时区原则见 [时间建模](./time-modeling)。
- `created_at` 一次写入后不再变更；`updated_at` 需要**每次 UPDATE 自动刷新**，两种维护方式：
  - **触发器**（推荐）：contrib 扩展 `moddatetime` 一行搞定，覆盖所有写入路径：

    ```sql
    CREATE EXTENSION IF NOT EXISTS moddatetime;
    CREATE TRIGGER users_set_updated_at
      BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION moddatetime (updated_at);
    ```

  - **ORM 层**：SQLAlchemy 的 `onupdate`、Rails 的 `touch` 也可行，前提是保证所有写入都经过 ORM；裸 SQL、存储过程、人工修数都会漏。

## 软删字段惯例

逻辑删除的统一写法是加一列 `deleted_at timestamptz`（NULL 表示存活），不要用 `is_deleted boolean`——布尔值丢了删除时间，审计与按期清理都没依据。软删会连带影响唯一索引、外键与统计口径，完整方案见 [软删除与墓碑](./soft-delete-and-tombstone)。

## 命名与 search_path 落库

业务对象放进**显式 schema**（如 `sales`、`billing`），而不是全堆在 `public` 里。两件事在落库时定死：

```sql
CREATE SCHEMA IF NOT EXISTS sales;

-- 为角色固化 search_path，而非依赖每次会话手动 SET
CREATE ROLE app_rw LOGIN PASSWORD '...';
ALTER ROLE app_rw IN DATABASE shop SET search_path = sales, public;
```

- 迁移脚本里**写全限定名**（`sales.orders`），避免部署工具连接参数不同导致对象建错 schema。
- `pg_catalog` 永远排在解析链最前，不用写进 `search_path`。
- 命名本身（snake_case、外键列 `_id` 后缀、约束命名模式）遵循一套成文规范，见 [命名与书写规范](../basics/naming-and-style-conventions)。

## 完整示例：订单库建表脚本

```sql
BEGIN;

CREATE SCHEMA IF NOT EXISTS sales;

CREATE TABLE sales.users (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       text        NOT NULL,
  nickname    text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CONSTRAINT users_email_key UNIQUE (email)   -- 软删后需改部分唯一索引，见软删除篇
);

CREATE TABLE sales.products (
  id          bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title       text          NOT NULL,
  price_cny   numeric(10,2) NOT NULL CHECK (price_cny >= 0),
  stock       int           NOT NULL DEFAULT 0 CHECK (stock >= 0),
  created_at  timestamptz   NOT NULL DEFAULT now(),
  updated_at  timestamptz   NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE TABLE sales.orders (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint        NOT NULL,
  status     text          NOT NULL DEFAULT 'pending',
  total_cny  numeric(12,2) NOT NULL DEFAULT 0 CHECK (total_cny >= 0),
  created_at timestamptz   NOT NULL DEFAULT now(),
  updated_at timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT orders_user_id_fkey  FOREIGN KEY (user_id) REFERENCES sales.users (id),
  CONSTRAINT orders_status_check
    CHECK (status IN ('pending', 'paid', 'shipped', 'done', 'cancelled'))
);

-- N:N 的典型产物：订单与商品通过中间表关联，并携带快照字段
CREATE TABLE sales.order_items (
  order_id   bigint        NOT NULL,
  product_id bigint        NOT NULL,
  qty        int           NOT NULL CHECK (qty > 0),
  unit_price numeric(10,2) NOT NULL,          -- 成交价快照，不随商品改价漂移
  PRIMARY KEY (order_id, product_id),
  CONSTRAINT order_items_order_fk
    FOREIGN KEY (order_id)   REFERENCES sales.orders (id)   ON DELETE CASCADE,
  CONSTRAINT order_items_product_fk
    FOREIGN KEY (product_id) REFERENCES sales.products (id)
);

CREATE INDEX orders_user_id_created_at_idx ON sales.orders (user_id, created_at DESC);
CREATE INDEX order_items_product_id_idx    ON sales.order_items (product_id);

-- updated_at 自动维护
CREATE EXTENSION IF NOT EXISTS moddatetime;
CREATE TRIGGER users_set_updated_at    BEFORE UPDATE ON sales.users
  FOR EACH ROW EXECUTE FUNCTION moddatetime (updated_at);
CREATE TRIGGER products_set_updated_at BEFORE UPDATE ON sales.products
  FOR EACH ROW EXECUTE FUNCTION moddatetime (updated_at);
CREATE TRIGGER orders_set_updated_at   BEFORE UPDATE ON sales.orders
  FOR EACH ROW EXECUTE FUNCTION moddatetime (updated_at);

COMMIT;
```

脚本在 psql 里可直接整段执行。三个实体加一张中间表，覆盖了上文全部惯例：identity 主键、timestamptz 双时间戳、软删字段、外键 + CHECK、复合主键中间表、外键列索引。

## 注意事项与常见坑

- **ON DELETE 动作想清楚再写**：默认 `NO ACTION`（有引用则拒绝删）、`CASCADE`（级联删）、`SET NULL`（置空）。中间表和附属表常用 CASCADE，主业务表慎用，详见 [外键与引用动作](./foreign-keys-and-referential-actions)。
- **手工导数据后对齐序列**：绕过 identity 显式插入 id 后，要用 `setval` 把序列拨到最大值，否则后续插入报唯一冲突；`pg_dump`/`pg_restore` 会自动处理。
- **`CREATE TABLE ... LIKE` 不复制外键**：`INCLUDING ALL` 会复制默认值、CHECK、索引，但外键引用始终不复制，克隆表后要手工补。
- **1:1 拆表有代价**：读时总是多一次 JOIN，只为低频大字段（如用户协议文本）拆表才值得；高频小字段留在主表。
- **中间表别省复合主键**：靠应用去重，早晚出现重复行。

## 相关页面

- [主键设计](./primary-key-design)
- [时间建模](./time-modeling)
- [软删除与墓碑](./soft-delete-and-tombstone)
- [命名与书写规范](../basics/naming-and-style-conventions)
