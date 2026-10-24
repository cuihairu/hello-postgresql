# pgvector: Vector Search

pgvector is an open-source vector extension for PostgreSQL: add a `vector` column to a table, rank by similarity with distance operators, and add an HNSW or IVFFlat index for approximate nearest neighbors (ANN). The typical use cases are RAG, semantic search, and recommendation recall — embeddings live in the same database as your business data, so they can be JOINed, filtered, and transacted together. The project is at [pgvector on GitHub](https://github.com/pgvector/pgvector).

## Installation and Creating the Extension

```bash
# Debian/Ubuntu (PGDG repository)
sudo apt install postgresql-16-pgvector
# Or use the official Docker image
docker run -e POSTGRES_PASSWORD=secret -p 5432:5432 pgvector/pgvector:pg16
```

Most major managed PG services (RDS, Cloud SQL, etc.) already ship pgvector; you just enable it where it is on the allowlist. Once installed:

```sql
CREATE EXTENSION vector;
```

## Vector Columns and Distance Operators

`vector(n)` is a fixed-dimension vector, capped at 16000 dimensions. Three core operators — note that they mean different things:

| Operator | Meaning | Distance range |
| --- | --- | --- |
| `<->` | Euclidean distance (L2) | ≥ 0, smaller means more similar |
| `<=>` | **Cosine distance** (1 − cosine similarity) | 0 to 2, smaller means more similar |
| `<#>` | **Negative inner product** (negated so that "larger is more similar" sorts ascending first) | result is negative |

The most common pitfall: treating `<=>` as cosine similarity. It is cosine **distance**; sort ASC with it (`ORDER BY ... <=>` ascending gives the nearest). If your model returns a similarity score and it does not line up with your query results, check this first. For normalized, OpenAI-style vectors, `<=>` and `<->` give the same ordering; unnormalized vectors usually use `<=>`.

```sql
CREATE TABLE docs (
    id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    content   text NOT NULL,
    embedding vector(4) NOT NULL
);

INSERT INTO docs (content, embedding) VALUES
    ('cat', '[0.9, 0.1, 0.0, 0.2]'),
    ('dog', '[0.8, 0.2, 0.1, 0.1]'),
    ('car', '[0.0, 0.1, 0.9, 0.8]');

-- The two closest by cosine distance
SELECT content,
       embedding <=> '[0.85, 0.15, 0.0, 0.2]' AS distance
FROM docs
ORDER BY embedding <=> '[0.85, 0.15, 0.0, 0.2]'
LIMIT 2;
```

In a real system, replace `vector(4)` with the dimension your model outputs (768, 1536, and so on).

## Two Index Types: HNSW and IVFFlat

Without an index, `ORDER BY ... <=>` is an exact full table scan; once an index exists, the planner switches to approximate search automatically. The index type must match the query operator (`vector_cosine_ops` corresponds to `<=>`).

**HNSW** (hierarchical navigable small world graph): high recall, slow to build, large memory footprint. Two build-time parameters and one query-time parameter:

```sql
CREATE INDEX ON docs
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

- `m` (default 16): the number of neighbor links kept per node; larger makes the graph denser, recall higher, and memory larger.
- `ef_construction` (default 64): the candidate queue length while building; larger builds slower but yields a better graph.
- `hnsw.ef_search` (default 40): the candidate queue length **at query time**, which directly sets the recall-latency tradeoff of a single query.

**IVFFlat** (inverted file clustering): fast to build and memory-frugal, but recall is sensitive to parameters:

```sql
ANALYZE docs;  -- make sure statistics are ready first
CREATE INDEX ON docs
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
SET ivfflat.probes = 10;
```

- `lists`: the number of cluster centers. Rule of thumb: `row count / 1000` up to a million rows, `sqrt(row count)` at larger scales.
- `ivfflat.probes` (default 1): the number of clusters probed at query time. Setting it to 1 usually gives unacceptable recall; start around `sqrt(lists)`.
- IVFFlat must be built **after the table already has data** (it needs data to estimate cluster centers); an empty table produces a broken index. HNSW has no such requirement.

## Tuning at Query Time and Exact Search

`SET` is session-scoped and `SET LOCAL` is transaction-scoped — in a search service, use `SET LOCAL` so each query carries its own recall budget:

```sql
BEGIN;
SET LOCAL hnsw.ef_search = 100;  -- default 40; raise it to buy recall
SELECT id, content
FROM docs
ORDER BY embedding <=> $1
LIMIT 20;
COMMIT;
```

An `ORDER BY ... <=>` with no index and no parameters set is an exact search (exhausting every row). For small tables (tens of thousands of rows) that is often simpler and more reliable. To judge whether the approximation error is acceptable: run the same batch of queries both exactly and approximately, and compute the top-k overlap (recall@k).

## Vector Queries with Filters

A common RAG requirement is "do semantic search within one tenant / one document class", i.e. `WHERE` plus vector ordering:

```sql
SELECT id, content
FROM docs
WHERE tenant_id = 42 AND status = 'published'
ORDER BY embedding <=> $1
LIMIT 10;
```

Both performance and correctness matter here:

- An HNSW index scan walks the graph while carrying the filter, but if the filter is very selective (a low hit rate), it can exhaust its `ef_search` budget before the LIMIT is filled, and the result comes back "short and narrow". Mitigations: raise `ef_search`, build a [partial index](../indexing/partial-indexes) on the high-frequency filter dimensions, or upgrade pgvector to 0.8+ and use iterative index scans.
- Keep the filter columns in the same table as the vector (pairing with a composite index); cross-table JOINs make it much harder for the plan to use the index.

## pgvector vs. a Dedicated Vector Database

Reasons to stay in PostgreSQL: embeddings share the same database and transaction as the business rows, and JOINs, soft deletes, and permissions ([RLS](../security/row-level-security)) all come free — you never build and run a second sync pipeline. Signals that say you may need to move out: vector data in the tens of GB or above (an HNSW graph basically has to be resident in memory), single-node QPS is not maxed out, or you need multi-replica sharded search. For sizing guidance, see [Capacity and Scaling Limits](../performance/capacity-and-scaling-limits).

## Caveats and Common Pitfalls

- The dimension must match the table definition: you cannot stuff a 768-dimensional vector into a `vector(1536)` column; changing models means altering the column or adding a new one.
- Run `ANALYZE` after building an index, or row count estimates go wrong and affect [plan choice](../performance/explain-basics).
- When loading in bulk, load first and build the index afterward; maintaining the HNSW graph while loading noticeably slows the import.
- For vectors above 2000 dimensions, prefer `halfvec` (half precision, up to 4000 dimensions) or reduce the dimensionality first, to shrink the index.

## References

- [wiki.postgresql.org/wiki/Foreign_data_wrappers](https://wiki.postgresql.org/wiki/Foreign_data_wrappers)
- [GitHub · pgvector/pgvector](https://github.com/pgvector/pgvector)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Extension Management](./extension-management)
- [GiST Indexes](../indexing/gist)
- [The Index Selection Decision Tree](../indexing/index-selection-decision-tree)
- [Choosing PostgreSQL](./when-to-choose-postgresql)
- [extension-management](extension-management.md)
- [index](index.md)
- [gist](/indexing/gist.md)
- [knowledge](/knowledge.md)