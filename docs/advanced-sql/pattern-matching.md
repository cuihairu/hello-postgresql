# 三种模式匹配

PostgreSQL 提供三层字符串模式匹配：`LIKE`/`ILIKE` 的通配匹配、`SIMILAR TO` 的正则子集、以及 `~`/`~*` 系列操作符给出的完整正则表达式。三者能力递增，性能特征也完全不同——`LIKE` 前缀匹配能走 btree 索引，而中缀 `LIKE '%xx%'` 只有装了 `pg_trgm` 扩展才谈得上索引加速。这一页把三者的语法、转义规则和选择标准讲清楚。

## 示例表

```sql
CREATE TABLE articles (
    id   bigserial PRIMARY KEY,
    title text NOT NULL,
    tag  text
);

INSERT INTO articles (title, tag) VALUES
    ('PostgreSQL 入门指南',       'pg'),
    ('postgresql 性能调优',       'pg'),
    ('MySQL 与 PostgreSQL 对比',  'sql'),
    ('  带前导空格的标题',        'x'),
    ('标题末尾有空格 ',           'x');
```

## LIKE 与 ILIKE

`LIKE` 支持两个通配符：`%` 匹配任意长度（含零个）的任意字符序列，`_` 匹配单个字符。它区分大小写，`ILIKE` 不区分。

```sql
SELECT id, title FROM articles WHERE title LIKE 'PostgreSQL%';      -- 只命中第 1 行
SELECT id, title FROM articles WHERE title ILIKE 'postgresql%';     -- 命中第 1、2 行
SELECT id, title FROM articles WHERE title LIKE '%_指南';           -- 命中第 1 行
```

两个容易踩的语义细节：

- **转义**：模式串里想匹配字面量的 `%` 或 `_`，用 `ESCAPE` 指定转义符（默认 `\`）：`title LIKE '%\_指南' ESCAPE '\'`。
- **尾随空格**：LIKE 是严格逐字符比较，`%` 之外的任何字符（包括空格）都要精确匹配。所以 `LIKE '指南'` 对值为 `'指南 '` 的行**不**匹配，而 `LIKE '指南%'` 会匹配。反过来，`LIKE 'PostgreSQL%'` 也匹配 `'PostgreSQL '`——前缀匹配排不掉尾部只有空格的行，需要精确语义时先 `trim()`。

前缀匹配（`LIKE 'abc%'`）是 btree 索引能覆盖的少数 LIKE 场景，因为 `'abc%'` 等价于一个区间。任何以 `%` 开头的模式都不能用普通 btree 索引。

## SIMILAR TO

`SIMILAR TO` 是 SQL:1999 的遗留接口，通配符语义是 `LIKE` 与正则的中间态：沿用 `%`/`_`，另支持 `[...]` 字符类、`|`、`()`、`+`、`*`、`?`、`{m,n}` 量词，但 `.` 不是元字符，`^`/`$` 锚点也不可用；且与 LIKE 一样要求匹配**整个字符串**。能用 `LIKE` 或正则表达的场景一律不要用 `SIMILAR TO`——它既没有 LIKE 的简洁性，也没有正则的表达能力。

## 正则匹配

四个操作符：`~` 区分大小写、`~*` 不区分、`!~` / `!~*` 取反。语法是 POSIX 风格正则（ECMAScript 超集），常用元字符：

| 元字符 | 含义 |
| --- | --- |
| `.` | 任意单个字符（不含换行） |
| `^` `$` | 行首 / 行尾 |
| `[a-z]` | 字符类 |
| `\d` `\w` `\s` | 数字 / 单词字符 / 空白 |
| `(...)` | 捕获组 |
| `(?:...)` | 非捕获组 |
| `(?i)` `(?-i)` | 开关大小写敏感 |

```sql
SELECT title FROM articles WHERE title ~ '^PostgreSQL';       -- 以 PostgreSQL 开头
SELECT title FROM articles WHERE title ~* 'mysql|postgresql'; -- 命中三行
SELECT title FROM articles WHERE title !~ '对比';              -- 未命中第 3 行
```

**捕获组与 substring 提取**：`substring(string FROM pattern)` 可取捕获组内容，`substring(string FROM pattern FOR m)` 取第 m 组。这是不做外部解析时从非结构化文本里抠字段的主要手段。

```sql
SELECT substring(title FROM '(.*)指南');        -- PostgreSQL 入门
SELECT substring(title FROM 'PostgreSQL (.*)'); -- 入门指南
SELECT substring('user-42-log.txt' FROM 'user-(\d+)');  -- 42
```

注意正则对每行都做逐字符扫描，没有前缀加速的等价物；`~ '^abc'` 在语义上等价于 `LIKE 'abc%'`，但执行路径不同（除非用表达式索引），能用 `LIKE` 就用 `LIKE`。

## pg_trgm 扩展

`pg_trgm` 把字符串切成三元组（trigram），一方面给 `LIKE`/`ILIKE` 的中缀搜索提供索引加速，另一方面提供基于相似度的模糊匹配。这是「标题里包含 pg」这类 `LIKE '%xx%'` 查询能走索引的前提。

```sql
CREATE EXTENSION pg_trgm;

CREATE INDEX idx_articles_title_trgm ON articles USING gin (title gin_trgm_ops);

-- 中缀 LIKE：GIN trgm 索引可直接加速（这是它最常用的场景）
SELECT id, title FROM articles WHERE title LIKE '%PostgreSQL%';
SELECT id, title FROM articles WHERE title ILIKE '%postgres%';

-- 相似度匹配：% 操作符返回两串相似度超过 pg_trgm.similarity_threshold（默认 0.3）的行
SELECT title, similarity(title, 'PostgreSQL 性能') AS sim
FROM articles
WHERE title % 'PostgreSQL 性能'
ORDER BY sim DESC;
```

装索引前后用 `EXPLAIN` 对比，`LIKE '%xx%'` 的 Seq Scan 会变成 Bitmap Index Scan。代价在于 trgm 索引体积通常达到表本体的数倍、每次写入都要维护索引条目，适合读多写少的模糊搜索场景（搜索框、去重匹配），不适合高频写入的事实表。需要「按相似度排序取 Top N」时，GiST 索引配合 `<->` 距离运算符支持 KNN 排序：

```sql
CREATE INDEX idx_articles_title_gist ON articles USING gist (title gist_trgm_ops);
SELECT title FROM articles ORDER BY title <-> 'PostgreSQL 性能' LIMIT 5;
```

两者取舍：GIN 查询通常更快但构建与更新更慢，GiST 更新快且支持距离排序，与 GIN/GiST 的通用差异一致，见 [GIN 索引](../indexing/gin)。

## 三种方式的选择建议

| 场景 | 推荐 |
| --- | --- |
| 精确前缀 / 后缀、已知固定字符 | `LIKE`，走 btree 或 expression index |
| 大小写不敏感前缀匹配 | `ILIKE`，配合 `lower(col)` 表达式索引 |
| 任意位置子串、需要模糊相似度 | `pg_trgm` + GIN 索引 |
| 结构化模式（开头某数字、含某字母表字母） | 正则 `~` |
| 多列模糊联合搜索、跨字段 | GIN 复合列 + `pg_trgm` |

## 注意事项与常见坑

- `LIKE 'abc'` 对 `'abc '` 不匹配；做「模糊匹配」时确认需求是否要求忽略尾部空白，必要时显式 `trim()`。
- `ILIKE` 在 `C` locale 下对非 ASCII 字符的行为可能与预期不同，多语言项目建议用 `citext` 类型或 `pg_trgm` 替代。
- `pg_trgm` 的 `%` 操作符是相似度判断而非「包含」判断；要「包含」语义就用 `LIKE '%xx%'`，两种查询都能走 GIN trgm 索引。
- 正则里 `.*`/`^`/`$` 等能力 `LIKE` 没有等价形式，别试图用 `LIKE` 模拟。
- 表达式索引 `CREATE INDEX ON t ((lower(title)))` 要求查询里的表达式与建索引时完全一致（`WHERE lower(title) LIKE 'abc%'`），大小写函数名虽然合法但表达式树不同就匹配不上，写查询前先想好索引形态。

## 相关页面

- [函数与操作符](../basics/functions-and-operators)
- [表达式索引](../indexing/expression-indexes)
- [GIN 索引](../indexing/gin)
- [全文搜索](./full-text-search)

官方文档：[字符串模式匹配](https://www.postgresql.org/docs/current/functions-matching.html)、[pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html)、[正则表达式操作符](https://www.postgresql.org/docs/current/functions-matching.html#FUNCTIONS-MATCH-POSIX)。
