# 索引失效与误用

「建了索引却不走」很少是 PostgreSQL 出了故障，绝大多数情况是查询写法让优化器**无法把条件换算成索引范围**，或者**统计信息让它认定全表扫描更便宜**。这里把常见的失效形态摆在一起：每类给一个能复现的例子和修法。排查口诀是先看 `EXPLAIN` 的实际计划，再对照本页逐项检查。

## 函数包裹列

对索引列施加函数或运算后，索引里存的「原始值」帮不上忙：

```sql
CREATE TABLE users_f (
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_f_email ON users_f (email);
CREATE INDEX idx_users_f_created ON users_f (created_at);
INSERT INTO users_f (email)
SELECT 'user' || g || '@example.com' FROM generate_series(1, 100000) g;
ANALYZE users_f;

-- 失效：函数包裹列，普通索引不认识 lower(email)
EXPLAIN SELECT id FROM users_f WHERE lower(email) = 'user1@example.com';
-- Seq Scan

-- 失效：同理，列被 cast / 截断
EXPLAIN SELECT count(*) FROM users_f WHERE created_at::date = '2026-01-01';
-- Seq Scan（timestamptz 转 date 依赖时区，且不再是索引里的原值）
```

修法有两条路，都保留「列在左边裸着」：

```sql
-- 路 A：把范围条件改写成对列的比较
SELECT count(*) FROM users_f
WHERE created_at >= '2026-01-01' AND created_at < '2026-01-02';

-- 路 B：为固定写法建表达式索引
CREATE INDEX idx_users_f_email_lower ON users_f ((lower(email)));
```

`created_at::date = ...` 改写成左开右闭范围后直接命中 `idx_users_f_created`，语义还避免了时区歧义（`::date` 的结果随会话时区变化）。

## 隐式类型转换

PostgreSQL 是强类型系统，这一点与 MySQL 不同：`varchar 列 = 数字` 不会悄悄把列 cast 成数字再比，而是直接报错：

```sql
-- users 表 email 是 text；订单号列若为 varchar：
CREATE TABLE tickets_t (code varchar(20) NOT NULL);
INSERT INTO tickets_t SELECT g::text FROM generate_series(1, 10000) g;
CREATE INDEX idx_tickets_t_code ON tickets_t (code);

EXPLAIN SELECT * FROM tickets_t WHERE code = 12345;
-- ERROR: operator does not exist: character varying = integer
```

真正的隐患在两种「不报错但出问题」的形态：

- **参数化查询的类型由驱动决定**。JDBC/ORM 把主键参数发成 text（`setString`），服务端要做 `bigint = text` 的类型裁决，轻则报错，重则让计划改道。修法：驱动层按列的真实类型设参，或查询里显式写 `$1::bigint`。
- **字面量类型合法但换了比较路径**。`code = 12345` 报错，`code = '12345'` 才是对的（unknown 字面量按列类型解析）；反过来数字列写字符串字面量没问题。检查 ORM 日志里实际发出的 SQL，别靠猜。

规则一句话：**让列保持原类型参与比较，转换只发生在常量/参数一侧**——常量侧的转换在计划期完成，不影响索引。

## OR 条件的退化

B-tree 单个索引只能给出一个范围，`OR` 连接的条件如果落在不同列上，优化器要靠 BitmapOr 把多个索引的结果合并；只要有一个分支没有可用索引，整体就退化为顺序扫描：

```sql
CREATE TABLE contacts_c (
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    phone text,
    email text
);
CREATE INDEX idx_contacts_c_phone ON contacts_c (phone);
-- 注意：email 上没有索引
EXPLAIN SELECT * FROM contacts_c WHERE phone = '13800000000' OR email = 'a@b.com';
-- Seq Scan on contacts_c
--   Filter: ((phone = ...) OR (email = ...))
```

给 `email` 也建上索引后，计划变成 `Bitmap Heap Scan` 下的 `BitmapOr`（两个 Bitmap Index Scan 取并集）。若两个分支选择性差距悬殊（一个命中 1 行、一个命中 10 万行），更稳的写法是 `UNION ALL` 拆开，让每支各自用最优计划：

```sql
SELECT * FROM contacts_c WHERE phone = '13800000000'
UNION ALL
SELECT * FROM contacts_c
WHERE email = 'a@b.com'
  AND phone IS DISTINCT FROM '13800000000';   -- 去掉两支交集；phone 为 NULL 的行也不能漏
```

IN 列表可以看作同列 OR 的简写，B-tree 能把 `col IN (1,2,3)` 处理成多次索引查找，不受此坑影响；跨列 OR 才是风险区。

## 前导通配 LIKE

B-tree 是有序结构，`LIKE 'abc%'` 这类前缀确定的匹配在特定排序下可以换算成 `>= 'abc' AND < 'abd'` 的范围查找；`LIKE '%abc'` 的前缀未知，任何排序都帮不上忙：

```sql
EXPLAIN SELECT * FROM users_f WHERE email LIKE 'user1%';
-- 常见非 C locale（如 zh_CN.UTF-8）下：Seq Scan
-- 库或列用 C collation、或建了 text_pattern_ops 索引时才走索引

EXPLAIN SELECT * FROM users_f WHERE email LIKE '%example.com';
-- Seq Scan，任何 B-tree 都帮不上
```

两处细节：

- **collation 影响**：非 C collation 的 text 列，普通 B-tree 的排序与 `LIKE` 需要的逐字节序不一致，`LIKE 'abc%'` 也可能走不上。修法是建索引时指定 `text_pattern_ops`（或列用 C collation）：`CREATE INDEX ON users_f (email text_pattern_ops);`
- **两端通配（`%kw%`）**：只能靠 trigram 的 GIN 索引，见 [GIN 索引](/zh/indexing/gin) 与 [模式匹配](/zh/advanced-sql/pattern-matching)。

## 统计过期导致优化器放弃

索引可用，但优化器按统计信息估算：这条条件要回 80% 的行，回表不如顺序扫。问题在于估算基于 `ANALYZE` 时刻的样本——大批量导入、大范围删除之后不重新分析，估算可能差出几个量级，计划随之抽风：

```sql
INSERT INTO users_f (email)
SELECT 'new' || g || '@example.com' FROM generate_series(1, 500000) g;

-- 不 ANALYZE 直接查，估算行数可能是几千，实际几十万
EXPLAIN ANALYZE SELECT * FROM users_f WHERE email LIKE 'new%';

ANALYZE users_f;   -- 之后计划恢复正常
```

排查时对比 `EXPLAIN` 输出里的估算行数（`rows=...`）与实际行数（`actual ... rows=...`），差一个数量级以上就先怀疑统计。批量写入后的 `ANALYZE`、autovacuum 的 analyze 阈值调整，见 [统计信息与 ANALYZE](/zh/performance/statistics-and-analyze)。

## 强制开关调试法

怀疑「优化器不该选全表扫」时，可以临时压制顺序扫描逼出索引计划：

```sql
SET enable_seqscan = off;

EXPLAIN ANALYZE SELECT * FROM users_f WHERE email LIKE '%example.com';
-- 即使逼出了 Bitmap/Index Scan，耗时通常仍远高于 Seq Scan

RESET enable_seqscan;
```

注意这个开关的用途边界：

- 它只是把顺序扫描的成本乘上 `disable_cost`（一个天文数字），**不是禁止**——真的没有可用索引时计划还是 Seq Scan，这正好能反证「索引不可用」而非「优化器嫌弃」。
- 仅限会话内诊断，**绝不能当生产修复手段**写进应用配置；全局关掉会让真正适合全表扫的大查询集体变慢。
- 与其关开关，不如读 `EXPLAIN (ANALYZE, BUFFERS)` 的成本与行数估算，找出优化器「嫌弃索引」的真实理由（见 [EXPLAIN ANALYZE 与 BUFFERS](/zh/performance/explain-analyze-buffers)）。

## NOT、<> 与 IS NULL 的索引行为

B-tree 能做索引定位的条件是 `=`、`<`、`<=`、`>`、`>=`（以及可换算成范围的形式）。`<>` 和 `NOT IN` 是「除这个范围以外的一切」，本身无法构成一个连续的索引范围：

```sql
EXPLAIN SELECT count(*) FROM users_f WHERE email <> 'user1@example.com';
-- Seq Scan：命中的行太多，且条件不是范围

EXPLAIN SELECT count(*) FROM users_f WHERE email IS NOT NULL;
-- 可能走 Bitmap Index Scan / Index Only Scan：
-- NULL 值集中存放在 B-tree 的一端，IS NOT NULL 可以换算成对非空端的范围扫描
```

实践结论：

- `col <> 'x'` 慢时，先确认是不是真的要取走绝大多数行——那样顺序扫描本就是对的；若反例只占极少数，考虑**部分索引**（见[部分索引](/zh/indexing/partial-indexes)）：`CREATE INDEX ... WHERE status <> 'done'` 把「剩下的少数行」单独收起来。
- `NOT IN (子查询)` 还有 NULL 三值逻辑的语义坑，能用 `NOT EXISTS` 就用 `NOT EXISTS`。
- `col IS NULL` 与 `col IS NOT NULL` 都可以利用 B-tree（NULL 值在 B-tree 中集中在索引一端），可空列上这两个条件的选择性又高时索引照常工作。

## 注意事项与常见坑

- 判断「失效」前先看清 `EXPLAIN` 用的计划类型和估算行数：小表上优化器选择顺序扫描是正确行为，不是失效。
- 隐式转换类问题在测试环境用字面量复现不出来（手写 `'12345'` 类型正确），往往只在生产参数化路径上发作，复现要看驱动的实际 SQL。
- 一条查询同时踩多个坑（函数包裹 + 前导通配）很常见，逐项剥离后再看计划。
- 本页所有「不命中」都是针对 B-tree；同样的条件在 GIN/GiST 上有各自的可用算子，判断依据是算子类，不是直觉。

## 参考资料

- [PostgreSQL 官方文档 · Chapter 11. Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL 官方文档 · 11.2. Index Types](https://www.postgresql.org/docs/current/indexes-types.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [where-and-expressions](/zh/basics/where-and-expressions)
- [postgis](/zh/ecosystem/postgis)
- [btree-structure](/zh/indexing/btree-structure)
- [composite-index-design](/zh/indexing/composite-index-design)
- [expression-indexes](/zh/indexing/expression-indexes)
- [index](/zh/indexing/index)
- [partial-indexes](/zh/indexing/partial-indexes)
- [join-implementations](/zh/internals/join-implementations)
- [knowledge](/zh/knowledge)
- [common-bad-plans](/zh/performance/common-bad-plans)- [表达式索引](/zh/indexing/expression-indexes) —— 函数包裹列的标准修法。
- [部分索引](/zh/indexing/partial-indexes) —— `<>` 类条件的另一条出路。
- [统计信息与 ANALYZE](/zh/performance/statistics-and-analyze) —— 估算偏差的系统性治理。
- [EXPLAIN 基础](/zh/performance/explain-basics) —— 看懂本页所有计划输出的前提。

官方文档：[优化器开关](https://www.postgresql.org/docs/current/runtime-config-query.html)、[模式匹配](https://www.postgresql.org/docs/current/functions-matching.html)、[索引与排序规则](https://www.postgresql.org/docs/current/indexes-collations.html)。
