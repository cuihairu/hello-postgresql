# 生成列与 CHECK 表达式

生成列（generated column）让数据库根据同一行的其他列自动计算并持久化一个派生值，写入方永远不用手动维护；CHECK 约束则是对已有列取值的校验规则，违反即拒绝写入。两者经常被混为一谈，但分工其实很清晰：**CHECK 负责校验「数据对不对」，生成列负责推导「数据应该是什么」**。这一页用同一个「邮箱全小写」例子贯穿两种手段。

## 示例表

```sql
CREATE TABLE users (
    id          bigserial PRIMARY KEY,
    email_raw   text NOT NULL,
    email       text GENERATED ALWAYS AS (lower(email_raw)) STORED,
    email_ok    boolean CHECK (email_raw = lower(email_raw)),
    age         int CHECK (age IS NULL OR age BETWEEN 0 AND 150)
);

INSERT INTO users (email_raw) VALUES ('Alice@Example.COM');
SELECT id, email_raw, email, email_ok FROM users;
--  1 | Alice@Example.COM | alice@example.com | f
```

`email` 列由数据库自动算出，`INSERT`/`UPDATE` 语句里**不允许**直接给它赋值，写了会报错 `GENERATED ALWAYS` 相关错误（除非用 `OVERRIDING SYSTEM VALUE`，而生成列连这个逃生门都没有——它只能由数据库写）。

## GENERATED ALWAYS AS (...) STORED

语法在 PG 12 引入，`STORED` 关键字必写：值在写入时计算并占用磁盘空间。核心语义：

```sql
ALTER TABLE users ADD COLUMN name_len int
    GENERATED ALWAYS AS (char_length(email_raw)) STORED;

ALTER TABLE users DROP COLUMN email;   -- 删生成列本身是允许的
-- 但不能删除被生成列引用的 email_raw，会报依赖错误
```

两条硬性限制：

- **不能引用其他生成列**：表达式里只能引用同一行的普通列（基列），引用另一个生成列会在建表时报错。
- **不能用易变函数**：表达式必须是不可变（IMMUTABLE）的。`lower()`、`char_length()`、四则运算都可以；`now()`、`random()`、`nextval()` 都不行。这条限制是语义必然——生成列的值必须在任意时刻重算都得到同样结果，否则 STORED 值会与表达式脱节。

另外注意：生成列参与逻辑复制和 `pg_dump` 时行为正常，但跨大版本升级用 `pg_upgrade` 时，早期版本对含生成列表的支持有过修补，升级前查看对应版本的 release notes。

## 生成列 vs 触发器维护冗余列

在 PG 12 之前，派生冗余列只能靠触发器维护。两者对比：

| 维度 | 生成列 | 触发器维护 |
| --- | --- | --- |
| 表达式限制 | 必须 IMMUTABLE、只能引用基列 | 任意 PL/pgSQL 逻辑，可读其他表 |
| 一致性 | 数据库保证，不可能脱节 | 逻辑写错就脱节，需要自己测 |
| 可见性 | `psql \d` 直接看到表达式 | 要翻触发器函数源码 |
| 更新开销 | 每次写入重算 | 同样每次写入触发 |
| 跨表/跨行 | 不支持 | 支持（如维护汇总表） |

能用生成列就不要用触发器：约束更硬、审计更直观。需要跨行聚合（订单头的 `total_amount` 汇总订单项）或读其他表时，才退回触发器或应用层维护，参见 [反范式与冗余设计](../database-design/normalization-and-denormalization)。

## 生成列上建索引

生成列是普通列，可以建索引、加唯一约束、参与外键：

```sql
CREATE UNIQUE INDEX idx_users_email ON users (email);

-- 查询直接命中生成列上的索引
SELECT id FROM users WHERE email = 'alice@example.com';
```

这是「生成列 + 索引」相对「表达式索引」的实质优势之一：表达式索引要求查询里写出完全相同的表达式，而生成列上的索引只需要查询引用列名。另一个优势是生成列可以声明 `NOT NULL` 并做 `UNIQUE`，表达式索引做唯一性也可以但语义上绕一层。

## 虚拟生成列（PG 18）

PG 18 起 `VIRTUAL` 生成列进入标准：值不落盘，读取时才计算，节省存储与写放大，代价是每次读取都付计算成本，且暂时不能在其上建索引。已有系统的 PG 12~17 用户继续用 `STORED` 即可，虚拟列适合「计算贵但不常读」的派生字段。

## CHECK 与生成列的分工

回到开头的例子：`email`（生成列）回答「规范化的邮箱是什么」，`email_ok`（CHECK）回答「原始输入是否已符合规范」。如果你希望**拒绝**`'Alice@Example.COM'` 这种未规范化的输入，直接用 CHECK 而不是「存进去再生成」：

```sql
ALTER TABLE users ADD CONSTRAINT email_lowercase_chk
    CHECK (email_raw = lower(email_raw));
-- 插入 'Alice@...' 现在会直接报错
```

判断用哪种的标准：值**唯一确定**且你愿意让数据库替你算 → 生成列；值需要**人工保证**、违反时宁可报错也不要自动改写 → CHECK。也可以两者并用：CHECK 保证输入规范，生成列做派生（比如从 `email_raw` 切出 `email_domain`）。

## 注意事项与常见坑

- 生成列表达式里不能用子查询、不能引用其他表的列，只能看「本行的基列」。
- `STORED` 生成列增加每行体积和写放大；宽表上为偶尔才读的派生值建生成列前，先用 `EXPLAIN ANALYZE` 评估读取侧收益。
- 修改生成列表达式没有 `ALTER COLUMN ... SET EXPRESSION` 之外的捷径（PG 17 才加入该语法），早期版本只能删列重建，注意删列会连带删掉依赖索引。
- CHECK 约束对 NULL 恒放行（结果为 NULL 视为通过），所以 `CHECK (age BETWEEN 0 AND 150)` 对 `age IS NULL` 的行不报错；要拒绝 NULL 另加 `NOT NULL`。
- 大表上 `ADD CONSTRAINT ... CHECK` 默认全表扫描锁表，生产环境用 `NOT VALID` + `VALIDATE CONSTRAINT` 两段式，见 [约束与数据质量](../database-design/constraints-and-data-quality)。

## 参考资料

- [PostgreSQL 官方文档 · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL 官方文档 · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [CHECK 约束与域](../database-design/check-and-domains)
- [约束与数据质量](../database-design/constraints-and-data-quality)
- [表达式索引](../indexing/expression-indexes)
- [建模反模式](../database-design/anti-patterns)
- [index](index.md)
- [jsonb-design-patterns](jsonb-design-patterns.md)
- [jsonb-operations](jsonb-operations.md)
- [check-and-domains](/database-design/check-and-domains.md)
- [expression-indexes](/indexing/expression-indexes.md)
官方文档：[生成列](https://www.postgresql.org/docs/current/ddl-generated-columns.html)、[CHECK 约束](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-CHECK-CONSTRAINTS)。
