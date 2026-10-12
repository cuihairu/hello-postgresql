# 命名与书写规范

命名规范的核心不是审美，而是**避免与 PostgreSQL 的标识符解析规则打架**。PostgreSQL 会把未加引号的标识符折叠为小写，这条规则决定了"驼峰 + 双引号"建出来的表为什么后续写裸名会报错。本篇讲清这条折叠规则及其陷阱，再给出表/列/约束/索引的命名约定与一套统一的 SQL 书写风格，让团队产出的 schema 与迁移脚本能长期维护。

## 未加引号的标识符会折叠为小写

SQL 标准规定未加引号的标识符按实现方式规范化，PostgreSQL 的实现是**一律折叠为小写**。也就是说：

```sql
CREATE TABLE Orders (Id int, UserName text);   -- 实际创建 orders / id / username
SELECT Id FROM Orders WHERE UserName = 'a';    -- 等价 SELECT id FROM orders WHERE username = 'a'
```

无论你写 `Orders`、`ORDERS` 还是 `orders`，落到目录里都是 `orders`。规则只作用于**标识符**（表名、列名、索引名、别名），不作用于**字符串字面量**——`WHERE name = 'ABC'` 里的 `'ABC'` 原样保留大小写。这一点与 MySQL 不同：MySQL 在 Linux 上表名默认大小写敏感，在 Windows 上又不敏感，跨平台行为不一致；PostgreSQL 在所有平台上行为一致（折叠为小写）。细节见官方[标识符与关键字](https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS)。

## 双引号保留大小写的陷阱

加了双引号的标识符**完全按字面保留**，不再折叠。这是新手最容易踩的坑：

```sql
CREATE TABLE "Users" ("Id" int, "Name" text);   -- 目录里就是 Users / Id / Name

SELECT id FROM users;          -- ERROR: relation "users" does not exist
SELECT * FROM Users;           -- ERROR: relation "users" does not exist（仍折叠为小写）
SELECT * FROM "Users";         -- OK，必须处处带引号
SELECT "Id" FROM "Users";      -- OK，列名同样要带引号
```

后果是**引号债务**：一旦用双引号建出 `"Users"`，之后所有 ORM、迁移脚本、`psql` 命令、日志排查都必须精确带上引号，漏一处就报 `does not exist`。ORM（如 SQLAlchemy、Hibernate）生成 SQL 时若检测到大小写不一致会自动加引号，进一步放大混乱。结论只有一条：**标识符一律小写 snake_case，从不使用双引号**。已经踩坑的修复方式见 [常见新手错误](./common-beginner-mistakes)。

## snake_case 与表名单复数

- **全小写 snake_case**：`order_items`、`user_profiles`。避免 `PascalCase`（会折叠）、避免中文/特殊字符、避免 SQL 保留字（`user`、`order`、`group`、`check` 都是保留字，用作表名必须加引号）。需要表达"用户表"时用 `users` 或 `app_user`，不要用裸的 `user`。
- **表名单复数**：两种主流风格都可，关键在于团队统一。推荐**复数**（`users`、`orders`），理由是 SQL 读起来自然（`FROM users` 表示"从用户集合中取"），且与 Rails/Django 等框架的默认约定一致。单数风格（`user_account`）则便于 ORM 按类名映射。选定后写进迁移规范即可。
- **避免缩写歧义**：`usr`、`ord` 这类缩写不如 `users`、`orders` 清晰；`create_time` 与 `created_at` 二选一，推荐后者（时态语义更明确，见 [时间建模](../database-design/time-modeling)）。

## 主键与外键列命名

- **主键统一叫 `id`**：单列代理主键时无争议。`bigint GENERATED ALWAYS AS IDENTITY`（PG 10 起，替代 `serial`）或 UUIDv7，类型选型见 [主键设计](../database-design/primary-key-design)。复合主键的列名则按业务语义命名。
- **外键列 = 被引用表的单数形 + `_id`**：`orders.user_id` 引用 `users.id`，`order_items.order_id` 引用 `orders.id`。这样看列名就能猜出 JOIN 条件，也让自动生成 JOIN 的工具有据可依。
- **同名对应**：`products.id` 对应 `orders.product_id`，不要一边叫 `prod_id` 一边叫 `pid`。

```sql
CREATE TABLE users (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email      text NOT NULL UNIQUE
);

CREATE TABLE orders (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users (id),   -- 外键列 = 表单数 + _id
  created_at timestamptz NOT NULL DEFAULT now()
);
```

## 索引与约束显式命名

PostgreSQL 会给未命名的约束和索引生成默认名，如 `orders_user_id_fkey`、`orders_pkey`、`orders_user_id_idx`。默认名能用，但有两类问题：多列索引/复合约束的默认名又长又乱（如 `orders_user_id_created_at_idx`），改名/删除时难拼写；跨环境迁移时默认名可能因建表顺序差异而不同。建议**显式命名**并遵循固定模式：

| 对象 | 模式 | 示例 |
| --- | --- | --- |
| 主键约束 | `<表>_pkey` | `orders_pkey` |
| 唯一约束 | `<表>_<列>_key` | `orders_order_no_key` |
| 外键约束 | `<表>_<列>_fkey` | `orders_user_id_fkey` |
| CHECK 约束 | `<表>_<列>_check` 或 `<表>_<语义>_check` | `orders_amount_positive_check` |
| 普通索引 | `<表>_<列...>_idx` | `orders_user_id_created_at_idx` |
| 唯一索引 | `<表>_<列...>_uidx` | `orders_order_no_uidx` |
| 排他约束 | `<表>_<语义>_excl` | `rooms_no_overlap_excl` |

```sql
CREATE TABLE order_items (
  id        bigint GENERATED ALWAYS AS IDENTITY,
  order_id  bigint    NOT NULL,
  sku       text      NOT NULL,
  qty       int       NOT NULL CHECK (qty > 0),
  CONSTRAINT order_items_pkey PRIMARY KEY (id),
  CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT order_items_sku_unique UNIQUE (order_id, sku)
);

CREATE INDEX order_items_order_id_idx ON order_items (order_id);
```

显式命名的另一个好处是：`DROP CONSTRAINT`、`ALTER INDEX RENAME` 等运维脚本可以直接写死名字，不必先查目录再拼接。

## SQL 书写风格

风格本身不影响执行，但**一致的风格让 code review、迁移脚本 diff、慢查询日志比对都更容易**。推荐约定：

- **关键字大写**或全小写统一，禁止混用。`SELECT ... FROM ... WHERE` 与 `select ... from ... where` 都可以，团队选一种（本站示例用大写关键字）。
- **函数名小写**：`count(*)`、`now()`，避免 `COUNT(*)` 与关键字混在一起难以区分。
- **JOIN 与过滤分行写**，`ON` 条件跟在 `JOIN` 同行，`WHERE` 条件每行一个谓词并用 `AND` 开头，便于 diff。

```sql
SELECT u.id,
       u.email,
       count(o.id)            AS order_cnt,
       max(o.created_at)      AS last_order_at
FROM   users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE  u.email IS NOT NULL
  AND  u.created_at >= '2026-01-01'
GROUP  BY u.id, u.email
HAVING count(o.id) >= 3
ORDER  BY order_cnt DESC
LIMIT  50;
```

- **逗号前置或后置统一**：本示例用尾逗号（`u.email,`），注释掉最后一行不会产生语法错误。
- **别名短但可读**：`u`、`o`、`oi` 对应 `users`、`orders`、`order_items`；避免 `t1`、`tmp`。
- **不写 `SELECT *` 进生产代码**：列变更时容易让依赖该结果集的代码崩溃，也丧失覆盖索引的机会（见 [仅索引扫描](../indexing/index-only-scans)）。
- **schema 显式**：跨 schema 的对象写全 `public.users`，避免依赖 `search_path` 的隐式解析。

## 注意事项与常见坑

- **保留字黑名单**：`user`、`order`、`group`、`check`、`primary`、`references` 都是保留字。新建表/列前用 `SELECT * FROM pg_get_keywords() WHERE catcode = 'R';` 查一遍。
- **`__` 双下划线与前后下划线**：`pg_` 前缀保留给系统对象，自定义对象不要用 `pg_` 开头，避免与 `pg_catalog` 冲突。
- **引号债务难还**：发现带引号的 `"Users"` 表后，正确清理是新建小写表 → 拷数据 → 改名，直接 `ALTER TABLE "Users" RENAME TO users;` 虽然可行，但所有依赖 `"Users"` 的视图、外键、代码仍需同步排查。
- **约束名是 schema 级唯一**：同一 schema 下两张表不能有同名 CHECK 约束，显式命名时务必带表名前缀。
- **风格工具**：`pg_format`（`psql` 附带的 `sql_formatter` 生态）或 sqlfluff 能自动统一缩进与大小写，把风格约束交给工具而非 review。

## 相关页面

- [常见新手错误](./common-beginner-mistakes)
- [数据库与模式对象](./database-and-schema-objects)
- [主键设计](../database-design/primary-key-design)
- [系统表与元数据](./system-catalogs-and-metadata)
