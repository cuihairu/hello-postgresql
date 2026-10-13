# 全文检索

PostgreSQL 内置的全文检索把文本归一成词位（lexeme）集合来匹配与排序，核心是两个类型：tsvector（文档的词位表示）和 tsquery（查询的词位表示），两者用 `@@` 匹配。相比 `LIKE '%关键词%'`，它能处理词形变化、给字段加权、按相关度排序，且配 GIN 索引后可以高效扫描。这一页覆盖从建列到排序的完整链路。

## tsvector 与 tsquery

`to_tsvector` 把文本解析、归一（去停用词、词干还原），输出带位置的词位；`to_tsquery` 把查询串变成同一种表示：

```sql
SELECT to_tsvector('english', 'The Fat Rats');
-- 'fat':2 'rat':3      （the 是停用词被去掉，rats 还原成 rat）

SELECT to_tsquery('english', 'fat & rat');
-- 'fat' & 'rat'

SELECT to_tsvector('english', 'The Fat Rats') @@ to_tsquery('english', 'fat & rat');  -- t
```

第一个参数是文本搜索配置（configuration），决定用哪个解析器和词典；省略时用 `default_text_search_config`。常用配置有 `simple`（只小写化、不还原词干）与各语言配置（english、german 等）。

## 示例表：把向量落成列

搜索列通常用生成列（PG 12 起）自动维护，避免手写触发器：

```sql
CREATE TABLE posts (
    id    int PRIMARY KEY,
    title text NOT NULL,
    body  text NOT NULL
);

INSERT INTO posts VALUES
    (1, 'PostgreSQL GIN 索引指南', 'GIN 索引的原理与适用场景，配合 jsonb 与数组'),
    (2, '慢查询优化实战', '用 EXPLAIN ANALYZE 定位慢查询，配合 pg_stat_statements 分析'),
    (3, 'Redis 缓存模式', '缓存穿透与雪崩的应对，回源策略与 TTL 设计');

ALTER TABLE posts ADD COLUMN search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', title), 'A') ||
    setweight(to_tsvector('simple', body),  'B')
) STORED;

CREATE INDEX posts_search_idx ON posts USING gin (search);
```

注意生成列里必须写两参数的 `to_tsvector('simple', ...)`：单参数版本依赖会话配置，是 STABLE 而非 IMMUTABLE，生成列和表达式索引都不收。

## 从用户输入构造 tsquery

三种构造函数对应三种输入形态：

```sql
-- plainto：所有词 AND 连接，适合日志排查
SELECT plainto_tsquery('simple', 'GIN 索引');
-- 'gin' & '索引'

-- websearch：面向终端用户，支持引号短语、or、-排除，非法语法不报错（PG 11 起）
SELECT websearch_to_tsquery('simple', '"GIN 索引" or 慢查询 -redis');
-- 'gin' <-> '索引' | '慢查询' & !'redis'

-- to_tsquery：完整的布尔表达式，语法非法直接报错，别直接拼用户输入
SELECT to_tsquery('simple', 'gin & (索引 | 缓存) & !redis');
```

还有 `phraseto_tsquery` 把短语转成 `<->`（相邻）匹配。前缀匹配在词位后加 `:*`，如 `to_tsquery('simple', 'gin:*')` 能匹配 gin、ginindex。

## 权重与 setweight

每个词位默认带 D 权重，`setweight` 可以给不同来源标记 A/B/C/D 四级，`||` 把多段向量拼接（位置重新编号）：

```sql
SELECT setweight(to_tsvector('simple', 'PostgreSQL GIN 索引指南'), 'A');
-- 'gin':2A 'postgresql':1A '索引指南':3A
```

上面示例表已经用了「标题 A、正文 B」的组合：同一个词出现在标题里，排序时贡献更高。权重的具体分值由 `ts_rank` 的权重参数（默认 `{0.1, 0.2, 0.4, 1.0}` 对应 D/C/B/A）决定。

## GIN 索引与 ts_rank 排序

`@@` 负责「命中」，`ts_rank` 负责「排序」：

```sql
SELECT id, title, ts_rank(search, q) AS score
FROM posts, websearch_to_tsquery('simple', 'GIN or EXPLAIN') q
WHERE search @@ q
ORDER BY score DESC;
-- 1 | PostgreSQL GIN 索引指南 | 0.06...（gin 同时命中 A、B 两级权重，排前）
-- 2 | 慢查询优化实战          | 0.06...
```

`ts_rank` 计算词频与权重的综合分，`ts_rank_cd` 额外考虑词的接近程度（cover density），短语类查询用后者更合理。记住一点：分数只用于同一查询内的相对排序，跨查询比较没有意义。GIN 索引的更新机制（fastupdate、pending list）对写入侧的影响见 [GIN 索引](../indexing/gin)。

## 中文分词的现实

默认解析器把连续汉字当成一个整体词位：`to_tsvector('simple', '索引指南')` 只产出 `'索引指南':1`，于是查 `索引` 匹配不上 `索引指南`，既不按词切也不按字切。生产环境的中文搜索要靠外部分词扩展：zhparser（基于 SCWS）、pg_jieba（基于结巴分词）是常见选择，装好后建自定义文本搜索配置替换默认解析器即可，检索链路（tsvector/tsquery/GIN/ts_rank）不变。另有 RoaringBitmap 的 pgroonga 走全文索引引擎路线，同样可作备选。

## 词典与同义词

配置的词位输出要经过词典链处理，常用模板有 synonym（同义词替换）、unaccent（去音调）、thesaurus（词组同义）。同义词词典的定义文件里每行第一个词是词头（headword），其余词会归一到它；需要注意 PG 13 前后词典对词头大小写的处理有过修订（如 PG 13 起 unaccent 匹配词头时保留原大小写，`É` 归一为 `E` 而非 `e`），上线前用你实际部署的版本验证词典行为。

## ts_stat：观察词项

`ts_stat` 对一张表的向量列做全文盘点，返回每个词位出现在多少文档、共出现多少次，用来挑选停用词、评估索引体积、找异常高频词：

```sql
SELECT word, ndoc, nentry
FROM ts_stat('SELECT search FROM posts')
ORDER BY ndoc DESC, word
LIMIT 10;
--  word   | ndoc | nentry
-- --------+------+--------
--  索引   |    1 |      1
--  与     |    3 |      3
--  ...
```

参数是一条返回 tsvector（或 text）列的查询，可以带 WHERE 只统计子集。

## 注意事项与常见坑

- 查询用的 configuration 必须与建向量列时一致，配置不同则词位不同，索引静默扫不到东西。
- 用户输入只走 `websearch_to_tsquery` / `plainto_tsquery`，直接拼 `to_tsquery` 会因非法语法抛错。
- 单参数 `to_tsvector` 是 STABLE，生成列、表达式索引必须用带配置的两参数版本。
- ts_rank 分数没有绝对含义，不要拿它做阈值过滤的常量（如 `score > 0.05`）跨环境复用。
- 大量写入时 GIN 的 pending list 会拖慢查询，高写入场景关注 fastupdate 与 autovacuum 的配合。
- 中文场景先验证分词效果再定索引列结构，「先 LIKE 兜底」通常说明分词方案没选对。

## 参考资料

- [PostgreSQL 官方文档 · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL 官方文档 · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [GIN 索引](../indexing/gin)
- [模式匹配](./pattern-matching)
- [索引选型决策树](../indexing/index-selection-decision-tree)
- [index](index.md)
- [pattern-matching](pattern-matching.md)
- [where-and-expressions](/basics/where-and-expressions.md)
- [extension-management](/ecosystem/extension-management.md)
- [gin](/indexing/gin.md)
- [gist](/indexing/gist.md)
- [index-selection-decision-tree](/indexing/index-selection-decision-tree.md)
官方文档：[全文检索简介](https://www.postgresql.org/docs/current/textsearch-intro.html)、[全文检索控制](https://www.postgresql.org/docs/current/textsearch-controls.html)、[ts_stat 统计](https://www.postgresql.org/docs/current/textsearch-features.html)。
