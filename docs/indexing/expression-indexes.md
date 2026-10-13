# 表达式索引

表达式索引（也叫函数索引）索引的不是列本身，而是列上某个表达式的计算结果：`CREATE INDEX ... ON t ((lower(email)))` 把 `lower(email)` 的值排进 B-tree。之后查询里写出**同一个表达式**时就能走索引，于是 `WHERE lower(email) = ...` 这类归一化查询不必再退化为全表扫描。

## 基本用法与命中条件

```sql
CREATE TABLE users_e (
    id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email  text NOT NULL,
    city   text
);

INSERT INTO users_e (email, city)
SELECT 'User' || g || '@Example.COM', 'city-' || (g % 100)
FROM generate_series(1, 100000) g;

-- 列上的普通索引
CREATE INDEX idx_users_e_email ON users_e (email);

-- 表达式索引：注意 email 外面有两层括号
CREATE INDEX idx_users_e_email_lower ON users_e ((lower(email)));
ANALYZE users_e;
```

语法上最外层括号是索引列清单的分隔符，内层括号把 `lower(email)` 标记为一个表达式，所以写成了 `((lower(email)))`。

查询里使用**同一个表达式**才能命中：

```sql
-- 命中表达式索引
EXPLAIN
SELECT id FROM users_e WHERE lower(email) = 'user50000@example.com';
-- Index Scan using idx_users_e_email_lower

-- 只命中普通索引：等值条件逐字相等才行
EXPLAIN
SELECT id FROM users_e WHERE email = 'User50000@Example.COM';
-- Index Scan using idx_users_e_email
```

两个索引各管一种写法。`lower(email) = 'user50000@example.com'` 不会走 `idx_users_e_email`（索引里存的是原文，不是小写形式）；反过来 `email = 'User...'` 也不会走表达式索引。开发时最容易踩的是 ORM 只生成 `WHERE email = ?`、而团队以为有 `lower` 索引兜底——计划一查便知。

## 归一化场景：大小写与去空白

用户输入不可控，入口层做归一化往往拦不住历史数据和各个写入方，索引层归一化更彻底：

```sql
-- 大小写 + 首尾空白一起归一
CREATE INDEX idx_users_e_email_norm
    ON users_e ((lower(btrim(email))));

-- 查询必须用一模一样的表达式
SELECT id FROM users_e WHERE lower(btrim(email)) = 'user1@example.com';
```

表达式相同指语义相同：函数名大小写（`LOWER` 与 `lower`）、空格、换行都不影响匹配，优化器比较的是解析后的表达式树；但 `lower(email)` 和 `lower(email::text)`、`btrim(x)` 与 `trim(x)` 这类措辞差异是否等价并没有保证，团队约定固定写法最省心。

表达式索引同样支持 `UNIQUE`，这是大小写不敏感唯一的常用实现：

```sql
CREATE UNIQUE INDEX uniq_users_e_email_lower
    ON users_e ((lower(email)));

INSERT INTO users_e (email) VALUES ('Alice@Example.com');  -- 成功
INSERT INTO users_e (email) VALUES ('ALICE@example.com');  -- 报错：duplicate key
```

## IMMUTABLE 要求

索引里的表达式必须是不可变的：同样的输入在任何时间、任何环境必须得到同样结果。这是索引能长期有序存储的前提，优化器据此匹配查询表达式：

```sql
-- 报错：now() 是 volatile 函数
CREATE INDEX idx_bad ON users_e (id) WHERE id > 1 AND now() > '2026-01-01';
-- ERROR: functions in index predicate must be marked IMMUTABLE

-- 报错：自定义函数没标 IMMUTABLE
CREATE FUNCTION slugify(t text) RETURNS text
    AS $$ SELECT lower(regexp_replace(t, '\s+', '-', 'g')) $$ LANGUAGE sql;

CREATE INDEX idx_bad2 ON users_e ((slugify(email)));
-- ERROR: functions in index expression must be marked IMMUTABLE
```

修正方法是给函数加上 `IMMUTABLE` 标记——前提是它真的只依赖输入参数。误标 `IMMUTABLE`（比如函数内部偷偷依赖时区设置或某张表）会产出自相矛盾的索引，这类错误很难事后排查。依赖 `TimeZone` 的表达式要显式固定时区，例如 `(created_at AT TIME ZONE 'Asia/Shanghai')::date` 是不可变的，`created_at::date`（timestamptz 列）不是。

## JSONB 字段表达式索引

从 jsonb 里取出的标量做等值/范围查找时，B-tree 表达式索引比 GIN 更合适：

```sql
CREATE TABLE events_j (
    id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    payload  jsonb NOT NULL
);

INSERT INTO events_j (payload)
SELECT jsonb_build_object('order_no', 'A' || g, 'type', 'pay')
FROM generate_series(1, 100000) g;

CREATE INDEX idx_events_j_order_no
    ON events_j ((payload->>'order_no'));

EXPLAIN
SELECT id FROM events_j WHERE payload->>'order_no' = 'A50000';
-- Index Scan using idx_events_j_order_no
```

`->>'order_no'` 返回 text，走的是标准 B-tree 等值查找。如果需求是包含查询（`payload @> '{"order_no": "A50000"}'`、按任意键查询），那才轮到 GIN，见 [GIN 索引](./gin)。两条路不冲突：等值高频查询用表达式 B-tree，稀疏键的全能检索用 GIN。

## 与生成列的取舍

生成列（`GENERATED ALWAYS AS (...) STORED`，PG 12+）是另一个归一化方案，见[生成列与 CHECK](../advanced-sql/generated-columns-and-check)：

```sql
ALTER TABLE users_e ADD COLUMN email_norm text
    GENERATED ALWAYS AS (lower(btrim(email))) STORED;

CREATE INDEX idx_users_e_norm ON users_e (email_norm);

-- SELECT 可以直接引用，查询端不需要重复表达式
SELECT id, email_norm FROM users_e WHERE email_norm = 'user2@example.com';
```

两者的表达式同样要求 `IMMUTABLE`，检索性能同级，差别在工程面：

- **可发现性**：生成列是真实的列，`SELECT *`、EXPLAIN 输出、ORM 模型里都看得见；表达式索引藏在索引定义里，新成员容易不知道它的存在，随手写 `WHERE email = ...` 就绕开了它。
- **使用成本**：生成列让查询端写普通列名即可；表达式索引要求每个查询都重复表达式，写错一点就失效。
- **存储与写入**：生成列把归一化值存进堆元组，表变宽，任何写入都要维护它；表达式索引只占索引空间。`SELECT *` 频繁、归一化值并不总被查询的表，用表达式索引更克制。
- **约束与引用**：生成列可以加 NOT NULL、被 CHECK 引用；作为外键目标则到 PG 18 才支持（17 及更早版本不允许），设计跨表约束时不要把生成列当外键锚点。表达式索引只解决检索。

简单说：只为了某几条查询加速，用表达式索引；归一化值本身是业务要引用的数据（对外输出、跨表校验），用生成列。

## 注意事项与常见坑

- 表达式逐字不匹配就退化为顺序扫描，上线前用 `EXPLAIN` 确认；这是表达式索引最高频的翻车点。
- 表达式结果的选择性可能和原列差别很大（比如 `lower(city)` 把 `Beijing`/`BEIJING` 合并），优化器有针对表达式的统计，但新建索引后记得 `ANALYZE`。
- 写入路径上每次都要计算表达式，函数越重写放大越明显；高频写入表上避免堆叠复杂函数（如正则替换）做索引。
- 改了表达式定义（比如归一化规则从 `lower` 升级为 `lower(btrim(...))`）时，老索引不会自动跟进，要重建：`REINDEX` 不够，需删除后按新表达式重建。

## 参考资料

- [PostgreSQL 官方文档 · Chapter 11. Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL 官方文档 · 11.2. Index Types](https://www.postgresql.org/docs/current/indexes-types.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [generated-columns-and-check](/advanced-sql/generated-columns-and-check.md)
- [jsonb-operations](/advanced-sql/jsonb-operations.md)
- [pattern-matching](/advanced-sql/pattern-matching.md)
- [sql-functions-advanced](/advanced-sql/sql-functions-advanced.md)
- [where-and-expressions](/basics/where-and-expressions.md)
- [index-failure-and-misuse](index-failure-and-misuse.md)
- [index-only-scans](index-only-scans.md)
- [index](index.md)
- [partial-indexes](partial-indexes.md)- [部分索引](./partial-indexes) —— 表达式 + WHERE 谓词可组合出「归一化后的热点子集」索引。
- [索引失效与误用](./index-failure-and-misuse) —— `WHERE upper(col) = ...` 走不上普通索引，正是表达式索引的用武之地。
- [生成列与 CHECK](../advanced-sql/generated-columns-and-check) —— 生成列语法的完整说明。
- [GIN 索引](./gin) —— jsonb 包含查询的另一条路径。

官方文档：[表达式索引](https://www.postgresql.org/docs/current/indexes-expressional.html)、[函数易变性分类](https://www.postgresql.org/docs/current/xfunc-volatility.html)。
