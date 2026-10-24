# TOAST

PostgreSQL's page size is fixed at 8KB, and a tuple is in principle supposed to fit into a single page. Overly long fields (variable-length types such as `text`, `jsonb`, and arrays) are not rejected; instead TOAST (The Oversized-Attribute Storage Technique) compresses them automatically or moves them into an associated TOAST table. The whole process is completely transparent to SQL, but the differences in storage location and update cost are behind many cases of "slow UPDATE" and "the table grew for no reason". Official reference: [TOAST](https://www.postgresql.org/docs/current/storage-toast.html).

## Where big values go: the TOAST table and chunking

- Every table that might hold big values has an accompanying TOAST table (schema `pg_toast`, named like `pg_toast.pg_toast_<oid>`) plus one btree index.
- If a tuple exceeds roughly 2KB once assembled (`toast_tuple_target`, default 2000 bytes), the TOASTable fields are compressed first according to their storage strategy, with out-of-line storage considered after that.
- An out-of-line big value is cut into chunks of about 2KB each and stored in the TOAST table, read back through the index by `(chunk_id, chunk_seq)`; a single field maxes out at about 1GB.
- Even when a compressed value stays in the main row it is far smaller than the original, so many large fields never need to go out of line at all.

To see where a table's TOAST went and how much it actually occupies:

```sql
CREATE TABLE docs (id int PRIMARY KEY, body text);
INSERT INTO docs VALUES (1, repeat('x', 500000));

SELECT reltoastrelid::regclass AS toast_table
FROM   pg_class
WHERE  relname = 'docs';                     -- pg_toast.pg_toast_16384

SELECT pg_size_pretty(pg_relation_size('docs'))       AS heap,
       pg_size_pretty(pg_total_relation_size('docs')) AS total;
-- the heap is only a few KB; the bulk lives in the TOAST table
```

## The four storage strategies

Every variable-length column has a storage strategy deciding "compress or not, out-of-line or not":

| Strategy | Compress | Out-of-line | Notes |
| --- | --- | --- | --- |
| PLAIN | No | No | The only option for fixed-length types (integer, timestamp, etc.) |
| EXTENDED | Compress first | Out-of-line only if it still does not fit after compression | The default for the vast majority of types |
| EXTERNAL | No | Out-of-line when the row is too wide | Skips compression to save CPU; once out of line, substring reads by chunk are supported |
| MAIN | Compress first | Keep inline as much as possible, out-of-line only when it truly does not fit | Prioritizes staying in the main row |

To view and change:

```sql
-- attstorage: p=PLAIN, e=EXTERNAL, x=EXTENDED, m=MAIN
SELECT attname, attstorage
FROM   pg_attribute
WHERE  attrelid = 'docs'::regclass AND attname = 'body' AND NOT attisdropped;

ALTER TABLE docs ALTER COLUMN body SET STORAGE EXTERNAL;  -- disable compression
-- PG 14+ lets you pick the compression algorithm per column:
ALTER TABLE docs ALTER COLUMN body SET COMPRESSION lz4;
```

**Compression algorithms**: traditionally there was only pglz. From PG 14 lz4 is supported (fast decompression, low CPU, slightly worse ratio). The default algorithm is governed by `default_toast_compression` (still pglz) and can be overridden per column. Large fields with many random reads, where decompression sits on the hot path, are worth trying lz4 on.

**The typical EXTERNAL scenario**: a large `text`/`jsonb` that is written a lot and read little, or where you often fetch only a prefix — taking a substring of an out-of-line, uncompressed value (e.g. `left(body, 200)`) reads only the first few chunks instead of decompressing the whole value.

## Read cost: automatic detoasting

Only when the executor reads a column carrying a TOAST pointer does it fetch all the chunks back through the TOAST index and decompress them (detoast):

- This happens only when the query actually references the large field; `SELECT id FROM docs` does not touch TOAST at all.
- `SELECT *` and the ORM default of loading the whole row are the most common sources of accidental detoasting, and the network transfer gets amplified on top.
- To check the actual on-disk size of a given column in a given row:

```sql
SELECT id, pg_size_pretty(pg_column_size(body)) AS body_bytes FROM docs;
```

## Updating large fields: the cost of rewriting every chunk

An MVCC `UPDATE` writes out a new tuple version (see [MVCC and Multi-Versioning](./mvcc-and-multi-version)), and its behavior toward TOAST splits into two cases:

- **A small column was changed**: the new tuple directly references the old TOAST chunks; the big value is not rewritten, and the cost is only the new version of the main row.
- **The large field itself was changed**: all the old chunks become garbage, and the new value is compressed, chunked, and written all over again. Changing one character in a 500KB field still rewrites the entire 500KB, and the old chunks must wait for VACUUM to be reclaimed (see [VACUUM and HOT](./vacuum-and-hot)).

```sql
UPDATE docs SET body = body || '!' WHERE id = 1;
SELECT pg_size_pretty(pg_total_relation_size('docs'));  -- clearly bigger
VACUUM docs;                                            -- falls back after the old chunks are reclaimed
```

This is why **a large field under high-frequency updates should be split into its own 1:1 child table**:

```sql
CREATE TABLE doc_bodies (
  doc_id int PRIMARY KEY REFERENCES docs(id),
  body   text
);
```

The payoff: the main table stays narrow, more rows fit per page, and both index and sequential scans get faster; updating other columns of the main table never touches body; and the large field is only joined in when it is genuinely needed. This matches the modeling idea of putting "variable-length cold data" in its own table; see [Logical to Physical Modeling](../database-design/logical-to-physical-modeling).

## Notes and common pitfalls

- `toast_tuple_target` is a table-level storage parameter (`ALTER TABLE t SET (toast_tuple_target = 128)`); lowering it sends shorter values out of line earlier. Except for special cases there is no need to adjust it.
- **The btree index entry ceiling is about 2704 bytes** (roughly 1/3 of a page, with 8KB pages): building an ordinary index directly on a large text raises `index row size ... exceeds maximum` — switch to a prefix or expression index, or GIN plus pg_trgm. See [GIN Indexes](../indexing/gin) and [Pattern Matching](../advanced-sql/pattern-matching).
- When monitoring bloat, **do not forget the TOAST table**: `pg_total_relation_size` already includes it, but looking at `pg_relation_size(reltoastrelid)` per table is more direct.
- When `ORDER BY`, `DISTINCT`, or a join key lands on a large field, every row has to be detoasted, at a cost far beyond intuition.
- `VACUUM FULL`, `pg_dump`, and logical replication all move large fields in their entirety, so these operations are slow on tables with huge TOAST data.

## References

- [PostgreSQL official documentation · 66.2. TOAST](https://www.postgresql.org/docs/current/storage-toast.html)
- [PostgreSQL official documentation · Chapter 51. Overview of PostgreSQL Internals](https://www.postgresql.org/docs/current/overview.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [MVCC and Multi-Versioning](./mvcc-and-multi-version)
- [VACUUM and HOT](./vacuum-and-hot)
- [GIN Indexes](../indexing/gin)
- [JSONB Operations](../advanced-sql/jsonb-operations)
- [array-operations](/advanced-sql/array-operations.md)
- [jsonb-operations](/advanced-sql/jsonb-operations.md)
- [data-types-overview](/basics/data-types-overview.md)
- [special-types-intro](/basics/special-types-intro.md)
- [index](index.md)
- [connection-and-orm-optimization](/performance/connection-and-orm-optimization.md)
Official reference: [TOAST](https://www.postgresql.org/docs/current/storage-toast.html)
