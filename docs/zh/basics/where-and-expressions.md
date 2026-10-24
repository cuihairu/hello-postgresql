# WHERE 与表达式

`WHERE` 决定哪些行参与查询：对每一行求值条件表达式，结果为 `true` 的行留下，`false` 和 `NULL` 都被丢弃。语法本身不难，真正的坑几乎都来自 NULL 的三值逻辑。这里按运算符分类记录，示例可直接在 psql 里执行。

## 示例表

```sql
CREATE TABLE products (
    id       bigserial PRIMARY KEY,
    name     text NOT NULL,
    price    numeric(10,2) NOT NULL,
    category text,
    active   boolean DEFAULT true,
    remark   text
);

INSERT INTO products (name, price, category, active, remark) VALUES
    ('键盘', 199.00, '外设', true, '红轴'),
    ('鼠标', 129.00, '外设', true, NULL),
    ('显示器', 1499.50, '大件', false, NULL),
    ('桌垫', 39.90, NULL, true, '大号'),
    ('键帽', 89.00, '外设', NULL, '透明');
```

## 比较运算符

`=、<>（或 !=）、<、>、<=、>=` 适用于数字、字符串、时间等可比较类型。字符串比较遵循排序规则（collation），中文排序依赖数据库的 locale 设置。另外记住一个 null 安全的比较符：`IS DISTINCT FROM`，它把 NULL 当成一个普通值参与比较，永远返回 true 或 false：

```sql
SELECT 1 <> 2, 'a' < 'b';                    -- t, t
SELECT NULL = NULL, NULL IS NULL;            -- NULL, t
SELECT NULL IS DISTINCT FROM NULL;           -- f（等价于“两者都为 NULL 则相等”）
```

## AND / OR / NOT 与优先级

优先级从高到低是 `NOT` > `AND` > `OR`。这意味着 `a OR b AND c` 实际是 `a OR (b AND c)`。写混合条件时显式加括号，读代码的人（包括三个月后的你）不需要回忆优先级：

```sql
SELECT name FROM products
WHERE category = '外设' OR category = '大件' AND price > 1000;
-- 等价于 category = '外设' OR (category = '大件' AND price > 1000)

SELECT name FROM products
WHERE (category = '外设' OR category = '大件') AND price > 1000;
-- 几乎总是你想要的写法
```

## BETWEEN 与 IN

`BETWEEN a AND b` 两端都包含（闭区间）；`IN` 判断值是否在列表或子查询结果里。

```sql
SELECT name FROM products WHERE price BETWEEN 100 AND 500;      -- 199 与 129

SELECT name FROM products WHERE category IN ('外设', '大件');

SELECT name FROM products
WHERE category IN (SELECT category FROM products GROUP BY category HAVING count(*) >= 2);
```

`NOT IN` 有一个必须记住的坑：只要列表（或子查询结果）里出现一个 NULL，`NOT IN` 对任何行都返回 NULL，整个查询空结果。见下文 NULL 一节。

## LIKE / ILIKE 与通配符

`LIKE` 做模式匹配：`%` 匹配任意长度（含零长度）字符，`_` 匹配单个字符；`ILIKE` 忽略大小写。转义通配符用 `ESCAPE`。

```sql
SELECT name FROM products WHERE name LIKE '键%';       -- 键盘、键帽
SELECT name FROM products WHERE name LIKE '%盘%';
SELECT name FROM products WHERE remark ILIKE '%pg%';
SELECT '50%' LIKE '50\%' ESCAPE '\';                   -- t
```

注意两点：模式以 `%` 开头时 B-tree 索引用不上，大表上会变成全表扫描；`LIKE` 适合简单前缀/包含匹配，复杂的检索需求走全文检索或 pg_trgm，见 [模式匹配](/zh/advanced-sql/pattern-matching) 与 [全文检索](/zh/advanced-sql/full-text-search)。

## NULL：IS NULL / IS NOT NULL，以及 `= NULL` 为什么永远不成立

SQL 里 `NULL` 表示「未知」，任何值与 NULL 用 `=`、`<>` 比较的结果都是 NULL 而不是 true。而 `WHERE` 只保留结果为 `true` 的行，所以：

```sql
SELECT count(*) FROM products WHERE remark = NULL;      -- 0，永不匹配
SELECT count(*) FROM products WHERE remark IS NULL;     -- 2，正确写法
SELECT count(*) FROM products WHERE remark IS NOT NULL; -- 3
```

三值逻辑还会放大到组合条件上：`NULL AND false` 是 `false`，`NULL AND true` 是 `NULL`，`NULL OR true` 是 `true`。由此得出本文开头 `NOT IN` 的结论：`category NOT IN ('外设', NULL)` 中，`'桌垫' NOT IN (...)` 的求值结果是 NULL 而非 true，该行被丢弃——哪怕它明明不在列表里。排查 NULL 值问题用 `IS NULL`，null 安全等值比较用 `IS DISTINCT FROM`。

## 布尔列直接做条件

布尔列可以不写比较直接作为条件，`NOT` 取反也成立：

```sql
SELECT name FROM products WHERE active;          -- 等价于 active = true
SELECT name FROM products WHERE NOT active;
```

但要注意列是否可空：示例表里 `active` 是可空的，`WHERE active` 会同时排除 `false` 和 NULL 两类行。语义上想表达「未停用」时，要么把列设为 `NOT NULL DEFAULT true`，要么显式写 `WHERE active IS NOT FALSE`。布尔列带 `NOT NULL` 约束时，直接写 `WHERE active` 的意图最清晰。

## 表达式索引一瞥

`WHERE` 里的条件如果能匹配索引，扫描就快；但优化器只会匹配「形状一致」的索引。常按 `lower(email)` 查询时，`email` 列上的普通索引帮不上忙，需要建表达式索引：

```sql
CREATE TABLE accounts (id bigserial PRIMARY KEY, email text NOT NULL);
CREATE INDEX accounts_email_lower_idx ON accounts (lower(email));

SELECT * FROM accounts WHERE lower(email) = 'a@example.com';  -- 能走上面的索引
```

表达式索引的完整用法（包括与唯一约束结合做大小写不敏感的唯一性）见 [表达式索引](/zh/indexing/expression-indexes)；哪些写法会让索引失效，见 [索引失效与误用](/zh/indexing/index-failure-and-misuse)。

## 注意事项与常见坑

- `col = NULL` 不报错但永远不成立，这是静默的逻辑 bug，要靠 code review 和测试兜底。
- 日期比较写字面量时加引号并写全：`WHERE created_at >= '2026-01-01'`；与 `timestamptz` 比较时按会话时区解释。
- 浮点/`real` 列不要用 `=` 做相等判断，用范围或 `numeric`。
- 空字符串 `''` 与 NULL 是两回事，`WHERE remark = ''` 不会匹配 NULL 行。

## 参考资料

- [PostgreSQL 官方文档 · Part I. Tutorial](https://www.postgresql.org/docs/current/tutorial.html)
- [PostgreSQL 官方文档 · The SQL Language](https://www.postgresql.org/docs/current/sql.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [函数与操作符](/zh/basics/functions-and-operators)
- [模式匹配](/zh/advanced-sql/pattern-matching)
- [表达式索引](/zh/indexing/expression-indexes)
- [索引失效与误用](/zh/indexing/index-failure-and-misuse)
- [conditional-expressions](/zh/advanced-sql/conditional-expressions)
- [aggregate-and-group-by](/zh/basics/aggregate-and-group-by)
- [crud-and-on-conflict](/zh/basics/crud-and-on-conflict)
- [functions-and-operators](/zh/basics/functions-and-operators)
- [index](/zh/basics/index)
官方文档：[比较函数与操作符](https://www.postgresql.org/docs/current/functions-comparison.html)、[模式匹配](https://www.postgresql.org/docs/current/functions-matching.html)。
