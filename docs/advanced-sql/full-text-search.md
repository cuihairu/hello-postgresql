# Full-Text Search

PostgreSQL's built-in full-text search normalizes text into a set of lexemes for matching and ranking. The core is two types: tsvector (the lexeme representation of a document) and tsquery (the lexeme representation of a query), which are matched with `@@`. Compared with `LIKE '%keyword%'`, it handles inflection, lets you weight fields, sorts by relevance, and after adding a GIN index it scans efficiently. This page walks through the whole chain, from building the column to ranking.

## tsvector and tsquery

`to_tsvector` parses and normalizes text (removing stopwords, stemming) and outputs lexemes with positions; `to_tsquery` turns a query string into the same representation:

```sql
SELECT to_tsvector('english', 'The Fat Rats');
-- 'fat':2 'rat':3      (the is a stopword and dropped; rats is stemmed to rat)

SELECT to_tsquery('english', 'fat & rat');
-- 'fat' & 'rat'

SELECT to_tsvector('english', 'The Fat Rats') @@ to_tsquery('english', 'fat & rat');  -- t
```

The first argument is the text search configuration, which decides which parser and dictionary to use; when omitted, `default_text_search_config` applies. Common configurations are `simple` (lowercasing only, no stemming) and the per-language ones (english, german, and so on).

## Sample Table: Storing the Vector as a Column

The search column is usually maintained automatically with a generated column (PG 12+), avoiding hand-written triggers:

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

Note that a generated column must use the two-argument `to_tsvector('simple', ...)`: the single-argument version depends on the session configuration and is STABLE rather than IMMUTABLE, so neither generated columns nor expression indexes accept it.

## Building a tsquery from User Input

Three constructors correspond to three input shapes:

```sql
-- plainto: all terms are ANDed together; good for log investigation
SELECT plainto_tsquery('simple', 'GIN 索引');
-- 'gin' & '索引'

-- websearch: aimed at end users, supports quoted phrases, or, and -exclusion; invalid syntax does not error (PG 11+)
SELECT websearch_to_tsquery('simple', '"GIN 索引" or 慢查询 -redis');
-- 'gin' <-> '索引' | '慢查询' & !'redis'

-- to_tsquery: full boolean expressions; invalid syntax is an immediate error, so never splice raw user input into it
SELECT to_tsquery('simple', 'gin & (索引 | 缓存) & !redis');
```

There is also `phraseto_tsquery`, which turns a phrase into `<->` (adjacency) matching. Prefix matching adds `:*` after a lexeme, so `to_tsquery('simple', 'gin:*')` matches gin, ginindex.

## Weights and setweight

Every lexeme carries a default weight of D. `setweight` marks different sources with one of the four levels A/B/C/D, and `||` concatenates several vectors (re-numbering the positions):

```sql
SELECT setweight(to_tsvector('simple', 'PostgreSQL GIN 索引指南'), 'A');
-- 'gin':2A 'postgresql':1A '索引指南':3A
```

The sample table above already uses the "title A, body B" combination: the same word appearing in the title contributes more at ranking time. The concrete weight scores are set by `ts_rank`'s weight parameter (default `{0.1, 0.2, 0.4, 1.0}`, corresponding to D/C/B/A).

## GIN Indexes and ts_rank Ranking

`@@` is responsible for "hitting," and `ts_rank` for "ordering":

```sql
SELECT id, title, ts_rank(search, q) AS score
FROM posts, websearch_to_tsquery('simple', 'GIN or EXPLAIN') q
WHERE search @@ q
ORDER BY score DESC;
-- 1 | PostgreSQL GIN 索引指南 | 0.06... (gin hits both the A and B weight levels, so it ranks first)
-- 2 | 慢查询优化实战          | 0.06...
```

`ts_rank` computes a combined score of term frequency and weight; `ts_rank_cd` additionally considers how close terms are (cover density), which is the more sensible choice for phrase-style queries. Remember this: the score is only meaningful for relative ranking within a single query — comparing scores across queries is meaningless. For how GIN's update mechanism (fastupdate, pending list) affects the write side, see [GIN indexes](../indexing/gin).

## The Reality of Chinese Tokenization

The default parser treats a run of Chinese characters as a single lexeme: `to_tsvector('simple', '索引指南')` yields only `'索引指南':1`, so searching for `索引` does not match `索引指南` — it neither splits by word nor by character. Production Chinese search relies on external tokenization extensions: zhparser (based on SCWS) and pg_jieba (based on the jieba segmenter) are the common choices. Once installed, create a custom text search configuration that swaps in the new parser, and the search chain itself (tsvector/tsquery/GIN/ts_rank) stays unchanged. Alternatively, pgroonga, built on RoaringBitmap, takes the full-text-engine route and is likewise a viable option.

## Dictionaries and Synonyms

The lexemes a configuration emits pass through a dictionary chain, whose common templates are synonym (synonym substitution), unaccent (diacritic removal), and thesaurus (phrase synonyms). In a synonym dictionary definition file, the first word of each line is the headword and every other word is normalized to it. Keep in mind that dictionary handling of headword case was revised around PG 13 (for example, from PG 13 unaccent preserves the original case when matching a headword, so `É` normalizes to `E` rather than `e`); verify dictionary behavior against the version you actually deploy before going live.

## ts_stat: Observing Lexemes

`ts_stat` inventories a table's vector column, returning how many documents each lexeme appears in and how many times it occurs in total. Use it to pick stopwords, gauge index size, and find abnormally frequent terms:

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

The argument is a query returning a tsvector (or text) column, and you can add a WHERE to count only a subset.

## Caveats and Common Traps

- The configuration used for queries must match the one used when building the vector column; if they differ, the lexemes differ and the index silently finds nothing.
- User input should only go through `websearch_to_tsquery` / `plainto_tsquery`; splicing it directly into `to_tsquery` raises an error on invalid syntax.
- The single-argument `to_tsvector` is STABLE; generated columns and expression indexes must use the two-argument version with a configuration.
- ts_rank scores have no absolute meaning; do not reuse them as a threshold constant across environments (such as `score > 0.05`).
- Under heavy writes GIN's pending list slows queries down; in write-heavy scenarios pay attention to how fastupdate and autovacuum interact.
- In Chinese scenarios, validate tokenization quality before fixing the index column structure; falling back to LIKE usually means the tokenization approach was the wrong choice.

## References

- [PostgreSQL official documentation · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL official documentation · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [GIN indexes](../indexing/gin)
- [Pattern Matching](./pattern-matching)
- [Index Selection Decision Tree](../indexing/index-selection-decision-tree)
- [index](index.md)
- [pattern-matching](pattern-matching.md)
- [where-and-expressions](/basics/where-and-expressions.md)
- [extension-management](/ecosystem/extension-management.md)
- [gin](/indexing/gin.md)
- [gist](/indexing/gist.md)
- [index-selection-decision-tree](/indexing/index-selection-decision-tree.md)
Official documentation: [Introduction to full text search](https://www.postgresql.org/docs/current/textsearch-intro.html), [Full text search controls](https://www.postgresql.org/docs/current/textsearch-controls.html), [ts_stat statistics](https://www.postgresql.org/docs/current/textsearch-features.html).
