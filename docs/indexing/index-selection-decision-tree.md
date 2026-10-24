# The Index Selection Decision Tree

PostgreSQL's index types (access methods, AMs) each answer different query shapes: B-tree excels at turning conditions into ordered ranges, GIN at answering "contains", GiST at "overlap and proximity", BRIN trades a tiny block summary for time-series scan cost, and SP-GiST handles prefixes and points by space partitioning. The first selection step is not "which one has better performance", but the question: **what shape is my query condition?** Only conditions that B-tree cannot express (containment, overlap, proximity, full-text) require a different AM.

## The Decision Tree

```plaintext
What shape is the dominant WHERE / ORDER BY condition in the query?
│
├─ Equality =, range < > BETWEEN, sorting ORDER BY ... LIMIT, unique constraints
│    └─ B-tree (the default choice, covering the vast majority of business queries)
│         └─ condition involves a function/expression → B-tree expression index
│         └─ only a small fraction of rows → add a WHERE predicate for a partial index
│
├─ Containment/membership: jsonb @> ?, array @> && <@, full-text @@, fuzzy match LIKE '%kw%'
│    └─ GIN
│
├─ Range type overlap &&, geometric intersection/containment, KNN nearest-neighbor ORDER BY col <-> point
│    └─ GiST (also the only choice for EXCLUDE constraints)
│
├─ Very large tables (far beyond memory), append-only writes, range scans in natural order (e.g. time)
│    └─ BRIN (precondition: physical order and column value order are highly aligned)
│
├─ Prefix-structured data (URLs, IPs, phone numbers), 2-D points, unbalanced hierarchical data
│    └─ SP-GiST
│
└─ Pure equality = only, and the key is very long / values extremely scattered, B-tree key limit exceeded
     └─ Hash (= only; more common alternative: md5 the value and build a B-tree expression index)
```

The B-tree branch comes first in the tree not because it is the most used, but because the other branches' query shapes are not supported by B-tree at all — operators such as `jsonb @>`, `range &&`, `tsvector @@` have no corresponding B-tree operator class, so building a B-tree does not help.

## Quick Reference for Each Type's Boundaries

| Index type | Query shapes it answers | Typical column types | Boundaries and costs |
| --- | --- | --- | --- |
| B-tree | =, <, <=, >, >=, BETWEEN, IN, prefix LIKE, ORDER BY | numeric, text, time, enum | key width limit about 2704 bytes; two-sided `%kw%` wildcard is useless |
| GIN | @>, ?, &&, @@ (jsonb/array/full-text/trigram) | jsonb, array, tsvector, trgm | no unique constraints; no IOS; write amplification and pending list see the GIN page |
| GiST | && overlap, @>, <-> KNN, geometric operators | range, geometry, PostGIS | lossy structure, usually with Recheck; no unique constraints |
| BRIN | min/max filtering by block range | time-series timestamps, auto-increment sequences | only effective when physically correlated; breaks on high-update tables; precision is per block range, Recheck required |
| SP-GiST | prefix matching, point/region partitioning | text prefixes, inet, point, uuid | capability is entirely decided by the operator class, less general than B-tree |
| Hash | = only | any hashable type | no range/sort/uniqueness; does not participate in ORDER BY optimization |

Version notes: BRIN's bloom and minmax-multi operator classes were added in PG 14; Hash indexes only write WAL from PG 10 onward (replication-capable, crash-safe); `REINDEX CONCURRENTLY` requires PG 12+.

## Two Typical Routing Examples

**Time-series monitoring table → BRIN**: data is appended in time order, physical order matches `ts` order, and a 200 GB table needs tens of GB for a B-tree time index, while BRIN needs only a few MB:

```sql
CREATE TABLE metrics_b (
    ts    timestamptz NOT NULL,
    host  text NOT NULL,
    value double precision NOT NULL
);

CREATE INDEX idx_metrics_b_ts ON metrics_b USING brin (ts)
    WITH (pages_per_range = 64);

EXPLAIN
SELECT count(*) FROM metrics_b
WHERE ts >= '2026-10-01' AND ts < '2026-10-02';
-- Bitmap Heap Scan ... Bitmap Index Scan on idx_metrics_b_ts
```

Be clear about the cost: BRIN records only "the min and max of each block range", and rows inside a range that do not satisfy the condition are filtered by Recheck; if the table has undergone large amounts of out-of-order updates so that physical order and time diverge, BRIN degrades to scanning most of the table — **physical correlation is BRIN's line of life and death**, see [BRIN Indexes](./brin) for details.

**Tag filtering table → GIN**: querying articles by array containment is beyond B-tree:

```sql
CREATE TABLE articles_g (
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tags  text[] NOT NULL
);
INSERT INTO articles_g (tags)
SELECT ARRAY['db', 'pg', 'tag' || (g % 50)::text]
FROM generate_series(1, 100000) g;

CREATE INDEX idx_articles_g_tags ON articles_g USING gin (tags);

EXPLAIN ANALYZE
SELECT id FROM articles_g WHERE tags @> ARRAY['pg'];
-- Bitmap Index Scan on idx_articles_g_tags
```

If this query were changed to `tags = ARRAY['pg']` (exact equality), B-tree should be used instead — the query shape decides the AM, not the column type.

## After Selecting: Verify with BUFFERS

Only measurement can answer whether the selection holds. The standard move is to **run `EXPLAIN (ANALYZE, BUFFERS)` on the same query once before and once after adding the index**, and compare three things: execution time, pages of buffers read (`shared read` is real I/O, `shared hit` is a cache hit), and whether the plan nodes match expectations (see [EXPLAIN ANALYZE and BUFFERS](../performance/explain-analyze-buffers)):

```sql
-- before adding the index
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM articles_g WHERE tags @> ARRAY['pg'];
-- Seq Scan ... rows=2000 ... Buffers: shared hit=835
--   Execution Time: 25 ms

CREATE INDEX idx_articles_g_tags ON articles_g USING gin (tags);

-- after adding the index
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM articles_g WHERE tags @> ARRAY['pg'];
-- Bitmap Index Scan ... rows=2000 ... Buffers: shared hit=18
--   Execution Time: 1.5 ms
```

Buffer pages dropping from 835 to 18 shows the selection delivered on the "read fewer pages" expectation; if time does not drop, or the plan shows an absurdly large `Rows Removed by Recheck`, go back to the decision tree and re-examine the query shape. Three things to mind when verifying:

- A cold cache is closer to production; `DISCARD ALL` is not enough (it does not clear the OS cache), so run repeatedly and judge stability rather than the single fastest value.
- After creating a new index, `ANALYZE` the table first; otherwise the optimizer has no basis for GIN/GiST selectivity and the Recheck ratio.
- The write-side cost must be measured too: GIN's fastupdate and Hash's maintenance cost are both passed on to INSERT/UPDATE latency, so a select-fast-write-slow choice can be a negative optimization for high-write tables.

## Notes and Common Pitfalls

- **One index can only use one AM**, but modifiers such as expressions, partial predicates, and INCLUDE are orthogonal to the AM: `CREATE INDEX ... USING gin (totsvector) WHERE is_published` is a legal combination.
- **A table does not need one heavyweight index per query shape**. Look at query frequency first: an analysis query that runs occasionally is fine with a sequential scan plus parallelism (see [Parallel Query](../internals/parallel-query)), and is not worth keeping an index for.
- Both GIN and GiST can index range types: retrieval is faster with GIN, updates are faster with GiST — choose by the read/write ratio.
- The decision tree says "where to start trying"; the final answer is the before/after comparison with EXPLAIN BUFFERS, and the column-order question for composite indexes is a further layer after the AM is chosen, see [Composite Index Design](./composite-index-design).

## References

- [PostgreSQL Official Documentation · Chapter 11. Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL Official Documentation · 11.2. Index Types](https://www.postgresql.org/docs/current/indexes-types.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [full-text-search](/advanced-sql/full-text-search.md)
- [pgvector](/ecosystem/pgvector.md)
- [brin](brin.md)
- [gin](gin.md)
- [gist](gist.md)
- [index](index.md)
- [spgist-and-hash](spgist-and-hash.md)
- [knowledge](/knowledge.md)- [B-tree Structure and Principles](./btree-structure), [GIN Indexes](./gin), [GiST Indexes](./gist), [BRIN Indexes](./brin), [SP-GiST and Hash](./spgist-and-hash) — the structure and operator class details of each AM.
- [EXPLAIN ANALYZE and BUFFERS](../performance/explain-analyze-buffers) — an expanded account of the verification method on this page.
- [Full-Text Search](../advanced-sql/full-text-search) — the most common business scenario for the GIN branch.

Official documentation: [Index Types](https://www.postgresql.org/docs/current/indexes-types.html), [Indexes and Operator Classes](https://www.postgresql.org/docs/current/indexes-opclass.html).
