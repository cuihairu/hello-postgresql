# Three Patterns of Pattern Matching

PostgreSQL provides three layers of string pattern matching: the wildcard matching of `LIKE`/`ILIKE`, the regex subset of `SIMILAR TO`, and full regular expressions via the `~`/`~*` operator family. Their capabilities increase, and so do their performance characteristics — `LIKE` prefix matching can use a btree index, while infix `LIKE '%xx%'` only gets index acceleration with the `pg_trgm` extension installed. This page sorts out the syntax, escape rules, and selection criteria for all three.

## Sample Table

```sql
CREATE TABLE articles (
    id   bigserial PRIMARY KEY,
    title text NOT NULL,
    tag  text
);

INSERT INTO articles (title, tag) VALUES
    ('PostgreSQL Beginner Guide',   'pg'),
    ('postgresql Performance Tuning', 'pg'),
    ('MySQL vs PostgreSQL',  'sql'),
    ('  Title With Leading Spaces',  'x'),
    ('Title With Trailing Space ', 'x');
```

## LIKE and ILIKE

`LIKE` supports two wildcards: `%` matches any sequence of characters of any length (including zero), and `_` matches a single character. It is case-sensitive; `ILIKE` is not.

```sql
SELECT id, title FROM articles WHERE title LIKE 'PostgreSQL%';      -- hits row 1 only
SELECT id, title FROM articles WHERE title ILIKE 'postgresql%';     -- hits rows 1 and 2
SELECT id, title FROM articles WHERE title LIKE '%_Guide';           -- hits row 1
```

Two easy semantic traps:

- **Escaping**: to match a literal `%` or `_` in a pattern, specify the escape character with `ESCAPE` (default `\`): `title LIKE '%\_Guide' ESCAPE '\'`.
- **Trailing spaces**: LIKE compares strictly character by character; every character outside `%` (including spaces) must match exactly. So `LIKE 'Guide'` does **not** match a row whose value is `'Guide '`, while `LIKE 'Guide%'` does. Conversely, `LIKE 'PostgreSQL%'` also matches `'PostgreSQL '` — prefix matching cannot rule out rows whose only difference is trailing whitespace, so use `trim()` first when you need exact semantics.

Prefix matching (`LIKE 'abc%'`) is one of the few LIKE cases a btree index can serve, because `'abc%'` is equivalent to a range. No pattern that begins with `%` can use an ordinary btree index.

## SIMILAR TO

`SIMILAR TO` is a legacy SQL:1999 interface, and its wildcard semantics are a middle ground between `LIKE` and regex: it keeps `%`/`_` and additionally supports `[...]` character classes, `|`, `()`, `+`, `*`, `?`, and `{m,n}` quantifiers, but `.` is not a metacharacter and the `^`/`$` anchors are not available; and like LIKE it requires matching the **entire string**. Whenever a case can be expressed with `LIKE` or a regular expression, do not use `SIMILAR TO` — it has neither LIKE's simplicity nor regex's expressiveness.

## Regular Expression Matching

Four operators: `~` case-sensitive, `~*` case-insensitive, `!~` / `!~*` the negations. The syntax is POSIX-style regex (an ECMAScript superset); the common metacharacters:

| Metacharacter | Meaning |
| --- | --- |
| `.` | Any single character (except a newline) |
| `^` `$` | Start of line / end of line |
| `[a-z]` | Character class |
| `\d` `\w` `\s` | Digit / word character / whitespace |
| `(...)` | Capturing group |
| `(?:...)` | Non-capturing group |
| `(?i)` `(?-i)` | Toggle case sensitivity |

```sql
SELECT title FROM articles WHERE title ~ '^PostgreSQL';       -- starts with PostgreSQL
SELECT title FROM articles WHERE title ~* 'mysql|postgresql'; -- hits three rows
SELECT title FROM articles WHERE title !~ 'MySQL';             -- excludes row 3
```

**Capturing groups and extracting with substring**: `substring(string FROM pattern)` returns a capturing group's contents, and `substring(string FROM pattern FOR m)` returns group m. This is the main way to pull fields out of unstructured text without external parsing.

```sql
SELECT substring(title FROM '(.*) Guide');        -- PostgreSQL Beginner
SELECT substring(title FROM 'PostgreSQL (.*)'); -- Beginner Guide
SELECT substring('user-42-log.txt' FROM 'user-(\d+)');  -- 42
```

Note that a regular expression scans character by character for every row, with no prefix-acceleration equivalent; `~ '^abc'` is semantically equivalent to `LIKE 'abc%'`, but the execution path differs (unless you use an expression index) — use `LIKE` when you can.

## The pg_trgm Extension

`pg_trgm` breaks strings into trigrams, which on one hand gives index acceleration for `LIKE`/`ILIKE` infix searches and on the other provides similarity-based fuzzy matching. This is the prerequisite for a `LIKE '%xx%'` query like "title contains pg" to be able to use an index.

```sql
CREATE EXTENSION pg_trgm;

CREATE INDEX idx_articles_title_trgm ON articles USING gin (title gin_trgm_ops);

-- Infix LIKE: a GIN trgm index accelerates this directly (its most common use case)
SELECT id, title FROM articles WHERE title LIKE '%PostgreSQL%';
SELECT id, title FROM articles WHERE title ILIKE '%postgres%';

-- Similarity matching: the % operator returns rows whose similarity to the pattern exceeds pg_trgm.similarity_threshold (default 0.3)
SELECT title, similarity(title, 'PostgreSQL Performance') AS sim
FROM articles
WHERE title % 'PostgreSQL Performance'
ORDER BY sim DESC;
```

Compare with `EXPLAIN` before and after adding the index: the Seq Scan for `LIKE '%xx%'` becomes a Bitmap Index Scan. The cost is that a trgm index is usually several times the size of the table itself and must be maintained on every write, so it suits read-heavy, write-light fuzzy search (search boxes, duplicate detection) but not fact tables with frequent writes. When you need "sort by similarity and take the top N," a GiST index with the `<->` distance operator supports KNN ordering:

```sql
CREATE INDEX idx_articles_title_gist ON articles USING gist (title gist_trgm_ops);
SELECT title FROM articles ORDER BY title <-> 'PostgreSQL Performance' LIMIT 5;
```

The trade-off: GIN queries are usually faster but build and update more slowly, while GiST updates are faster and support distance ordering — the same general difference as between GIN and GiST. See [GIN indexes](../indexing/gin).

## Choosing Among the Three

| Scenario | Recommendation |
| --- | --- |
| Exact prefix / suffix, known fixed characters | `LIKE`, using a btree or expression index |
| Case-insensitive prefix matching | `ILIKE`, with a `lower(col)` expression index |
| Substring at any position, or fuzzy similarity needed | `pg_trgm` + a GIN index |
| Structured patterns (starts with a digit, contains letters from some alphabet) | regex `~` |
| Multi-column fuzzy combined search across fields | GIN composite columns + `pg_trgm` |

## Caveats and Common Traps

- `LIKE 'abc'` does not match `'abc '`; when doing "fuzzy matching," confirm whether the requirement really means ignoring trailing whitespace, and use `trim()` explicitly if so.
- `ILIKE` under the `C` locale can behave differently than expected on non-ASCII characters; multilingual projects should use the `citext` type or `pg_trgm` instead.
- `pg_trgm`'s `%` operator is a similarity test, not a "contains" test; for "contains" semantics use `LIKE '%xx%'`. Both query forms can use a GIN trgm index.
- Capabilities like `.*`/`^`/`$` in regex have no `LIKE` equivalent; do not try to simulate them with `LIKE`.
- An expression index `CREATE INDEX ON t ((lower(title)))` requires the expression in the query to match the index exactly (`WHERE lower(title) LIKE 'abc%'`); even though function-name casing is legal, a different expression tree will not match, so decide the index shape before writing queries.

## References

- [PostgreSQL official documentation · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL official documentation · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Functions and Operators](../basics/functions-and-operators)
- [Expression indexes](../indexing/expression-indexes)
- [GIN indexes](../indexing/gin)
- [Full-Text Search](./full-text-search)
- [full-text-search](full-text-search.md)
- [index](index.md)
- [where-and-expressions](/basics/where-and-expressions.md)
- [gin](/indexing/gin.md)
- [index-failure-and-misuse](/indexing/index-failure-and-misuse.md)
- [spgist-and-hash](/indexing/spgist-and-hash.md)
- [toast](/internals/toast.md)
Official documentation: [String pattern matching](https://www.postgresql.org/docs/current/functions-matching.html), [pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html), [Regular expression operators](https://www.postgresql.org/docs/current/functions-matching.html#FUNCTIONS-MATCH-POSIX).
