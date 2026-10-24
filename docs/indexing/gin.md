# GIN Indexes

GIN (Generalized Inverted Index) is designed for data where "one value contains multiple components": arrays, jsonb, tsvector, trigram strings. It builds a separate entry for each component (element, key, lexeme), and queries fetch the list of "rows that contain that component" directly. The cost is a complex structure and slower updates. This page covers the inverted structure, the operator-class pairings per type, the performance impact of the pending list, and choosing between jsonb's two operator classes. See the official documentation on [GIN Indexes](https://www.postgresql.org/docs/current/gin.html).

## Inverted Structure: From Component to Rows

A B-tree entry is "one per row"; a GIN entry is "**one posting list per component**" — recording the TIDs of all rows that contain that component. When postings grow too numerous to fit in a single chain, they are promoted to a posting tree (B-tree shape).

```sql
CREATE TABLE articles (
    id   int GENERATED ALWAYS AS IDENTITY,
    tags text[],
    body jsonb
);

INSERT INTO articles (tags, body)
SELECT CASE WHEN g % 100 = 0 THEN ARRAY['common','rare_tag'] ELSE ARRAY['common'] END,
       jsonb_build_object('title', 't' || g,
                          'kind', CASE WHEN g % 50 = 0 THEN 'vip' ELSE 'normal' END)
FROM generate_series(1, 300000) g;

CREATE INDEX articles_tags_idx ON articles USING gin (tags);
ANALYZE articles;
```

At query time GIN pulls the matching TID list from the index and forms a bitmap. This is also a hard property of GIN: **it supports only Bitmap Index Scan** — no plain Index Scan and no Index Only Scan:

```sql
EXPLAIN (COSTS OFF) SELECT id FROM articles WHERE tags @> ARRAY['rare_tag'];
-- Bitmap Heap Scan on articles
--   Recheck Cond: (tags @> '{rare_tag}'::text[])
--   ->  Bitmap Index Scan on articles_tags_idx
--         Index Cond: (tags @> '{rare_tag}'::text[])
```

The example above deliberately makes `rare_tag` appear in only 1% of rows. Whether the GIN index is chosen is related to selectivity — if the condition matches most of the table, the optimizer will simply do a sequential scan.

## Applicable Types and Operator Pairings

Built-in operator classes and the indexable operators they support (see the [official operator class table](https://www.postgresql.org/docs/current/indexes-opclass.html)):

| Operator class | Index type | Indexable operators |
| --- | --- | --- |
| `array_ops` | any array | `@>` `<@` `&&` `=` |
| `jsonb_ops` (default) | jsonb | `@>` `?` `?\|` `?&` `@@` `@?` |
| `jsonb_path_ops` | jsonb | `@>` `@@` `@?` |
| `tsvector_ops` | tsvector | `@@` |
| `gin_trgm_ops` (pg_trgm extension) | text | `LIKE` `ILIKE` `~` and others |

Two easy pitfalls:

- **Arrays have no `?` operator**. To check whether an array contains an element, write `tags @> ARRAY['x']`; the `?` family exists only for jsonb.
- **jsonb key-existence queries `body ? 'title'` can only be indexed by the default `jsonb_ops`**; an index built with `jsonb_path_ops` can only do a sequential scan when it meets `?`.

For jsonb and full-text-search query patterns, see [jsonb Operations](../advanced-sql/jsonb-operations) and [Full-Text Search](../advanced-sql/full-text-search).

## fastupdate and the Pending List

The root cause of slow GIN updates: inserting one row into the table can produce many components, each of which has to be written into the index. PG's mitigation is **fastupdate**: new entries first accumulate in an unsorted pending list, and are merged into the main structure in one batch once enough have accumulated:

- The threshold is controlled by `gin_pending_list_limit`, default 4 MB (it can also be set separately on an index via a storage parameter of the same name).
- When the merge is triggered: the table is `VACUUM`ed or `ANALYZE`d, `gin_clean_pending_list()` is called, or an insert pushes the list past the threshold (in which case **the foreground insert pays the cost of merging the whole batch**).
- The cost: **every query has to scan the pending list**, so a larger list means slower queries and less stable latency.

```sql
SHOW gin_pending_list_limit;                        -- default 4MB
SELECT gin_clean_pending_list('articles_tags_idx'); -- clean manually, returns pages cleaned
ALTER INDEX articles_tags_idx SET (gin_pending_list_limit = 1024);  -- unit KB
```

## Tradeoffs for Write-Heavy Workloads

For tables that are written to far more than read, leaving fastupdate on is usually right: inserts are fast, and cleanup is left to autovacuum. For tables that need stable query latency, it is the reverse — just turn fastupdate off and let every insert go straight into the main structure:

```sql
-- disable at index creation time
CREATE INDEX idx_docs ON documents USING gin (body) WITH (fastupdate = off);
-- disable on an existing index
ALTER INDEX idx_docs SET (fastupdate = off);
```

You can quantify the decision: if queries frequently show millisecond-level jitter because of the pending list while insert throughput is not a bottleneck, turn it off; conversely, if writes are the hot path and queries can tolerate occasional slowness, leave it on and mind the cleanup cadence (lower `autovacuum_vacuum_scale_factor` a bit so cleanup runs more often, see [autovacuum Tuning](../internals/autovacuum-tuning)).

GIN also accumulates garbage entries through deletes/updates, and `VACUUM` cleans them up; when the structure degrades severely you can rebuild it wholesale:

```sql
REINDEX INDEX CONCURRENTLY articles_tags_idx;
```

For more on size and rebuilding, see [Index Bloat and Maintenance](./index-bloat-and-maintenance).

## Choosing Between jsonb_ops and jsonb_path_ops

The two operator classes produce entirely different structures on the same jsonb column:

- `jsonb_ops`: builds a separate entry for every key and every value, supporting key-existence queries (`?` `?|` `?&`) and containment queries (`@>`).
- `jsonb_path_ops`: builds entries only for the hash of "key path + value", **supports only `@>` `@@` `@?`**, and does not support key-existence queries; in exchange you get a smaller index and faster containment queries. Additionally, it does not build entries for "structures containing no scalar values" (such as an empty array), so queries for those values will miss.

Measured sizes of the two indexes on the same column (300k rows of jsonb):

```sql
CREATE INDEX articles3_body_idx     ON articles3 USING gin (body jsonb_path_ops);
CREATE INDEX articles3_body_ops_idx ON articles3 USING gin (body);
SELECT indexrelid::regclass AS idx, pg_size_pretty(pg_relation_size(indexrelid))
FROM pg_index WHERE indrelid = 'articles3'::regclass ORDER BY 1;
--     idx              |  size
-- ---------------------+--------
--  ..._body_idx        |  5248 kB   -- jsonb_path_ops, noticeably smaller
--  ..._body_ops_idx    |  6440 kB   -- jsonb_ops
```

Selection criteria: queries use only `@>` (or jsonpath `@@`/`@?`) → pick `jsonb_path_ops`, smaller and faster; you need `?` key-existence queries → only `jsonb_ops` can do it.

For trigram usage (`LIKE '%keyword%'` using an index), see [Pattern Matching](../advanced-sql/pattern-matching).

## References

- [PostgreSQL Official Documentation · Chapter 11. Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL Official Documentation · 11.2. Index Types](https://www.postgresql.org/docs/current/indexes-types.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [jsonb Operations](../advanced-sql/jsonb-operations)
- [Full-Text Search](../advanced-sql/full-text-search)
- [Index Bloat and Maintenance](./index-bloat-and-maintenance)
- [The Index Selection Decision Tree](./index-selection-decision-tree)
- [array-operations](/advanced-sql/array-operations.md)
- [full-text-search](/advanced-sql/full-text-search.md)
- [jsonb-design-patterns](/advanced-sql/jsonb-design-patterns.md)
- [jsonb-operations](/advanced-sql/jsonb-operations.md)
- [pattern-matching](/advanced-sql/pattern-matching.md)
- [pgvector](/ecosystem/pgvector.md)
- [expression-indexes](expression-indexes.md)
- [gist](gist.md)
- [index-failure-and-misuse](index-failure-and-misuse.md)
- [index-selection-decision-tree](index-selection-decision-tree.md)
- [index](index.md)
- [toast](/internals/toast.md)
