# SP-GiST and Hash

This page records two "niche but clearly positioned" index types together. SP-GiST belongs to the same generalized index framework as GiST, but targets **naturally unbalanced** data distributions (spatial points, string prefixes, IP subnets), using a space-partitioned tree that cuts the data to match it better; Hash indexes serve only equality queries and have long been in a "exists but rarely used" state in PostgreSQL — understanding its boundaries matters more than memorizing its usage.

## SP-GiST: A Space-Partitioned Tree

SP-GiST (Space-Partitioned GiST) recursively divides space into mutually exclusive regions: a quadtree splits the plane into four quadrants around the center point, a radix tree (trie) branches character by character along a string. Unlike GiST's "node predicates may overlap", SP-GiST's partitions are mutually exclusive, so it fits data that is naturally tree-shaped with uneven depth. Built-in opclasses (measured via `pg_opclass`):

| Operator class | Data type | Tree structure | Typical use |
| --- | --- | --- | --- |
| `quad_point_ops` (point default) | point | quadtree | geographic points, spatial clustering |
| `kd_point_ops` | point | K-D tree | same, may be faster for a different query pattern |
| `text_ops` | text | radix tree | prefix search |
| `inet_ops` (PG 10+) | inet / cidr | radix tree | IP attribution, subnet queries |
| `box_ops` / `poly_ops` | box / polygon | quadtree | rectangles/polygons |
| `range_ops` | any range type | quadtree | interval overlap |

`quad_point_ops`, `kd_point_ops`, and `poly_ops` support KNN ordering (`ORDER BY col <-> point`). For opclass details, see the official [SP-GiST built-in operator classes](https://www.postgresql.org/docs/current/spgist.html).

## Using SP-GiST for Text Prefix Search

SP-GiST `text_ops`'s strong point is **prefix matching**: the radix tree branches per character, so `LIKE 'abc%'` walks directly along the prefix. Internally it is rewritten as a `^@` (starts with, introduced in PG 15) condition:

```sql
CREATE TABLE usernames (name text);
INSERT INTO usernames
SELECT 'user' || lpad(g::text, 7, '0') FROM generate_series(1, 100000) g;

CREATE INDEX usernames_name_spgist ON usernames USING spgist (name text_ops);
ANALYZE usernames;

EXPLAIN (COSTS OFF) SELECT * FROM usernames WHERE name LIKE 'user0001%';
-- Bitmap Heap Scan on usernames
--   Filter: (name ~~ 'user0001%'::text)
--   ->  Bitmap Index Scan on usernames_name_spgist
--         Index Cond: (name ^@ 'user0001'::text)
```

Compared with B-tree `text_pattern_ops`: SP-GiST prefix search is not affected by collation and uses less memory for very high-cardinality prefix distributions (such as URLs or identifiers); but it is a bitmap scan and does not support patterns that start with `%`. For the B-tree tradeoffs, see [Pattern Matching](../advanced-sql/pattern-matching).

An example in the inet case (all addresses within a subnet):

```sql
CREATE TABLE nets (ip inet);
CREATE INDEX nets_ip_spgist ON nets USING spgist (ip inet_ops);

EXPLAIN (COSTS OFF) SELECT * FROM nets WHERE ip << '10.0.3.0/24';
-- Bitmap Heap Scan on nets
--   ->  Bitmap Index Scan on nets_ip_spgist
--         Index Cond: (ip << '10.0.3.0/24'::inet)
```

## Hash Indexes: Equality Only

Hash indexes hash key values into 4 bytes and support only the `=` operator. Historically it was a second-class citizen: before PG 10, hash indexes **did not write WAL**, so they could be corrupted after a crash and were not shipped to standbys via streaming replication, and were banned in production; only after the PG 10 rewrite did they become production-viable. So remember the version cutoff: **reliable from PG 10 onwards**.

Its boundaries are hard, and both are measured:

```sql
CREATE TABLE users_h (email text);
INSERT INTO users_h SELECT 'u' || g || '@example.com' FROM generate_series(1, 100000) g;
CREATE INDEX users_h_email_hash ON users_h USING hash (email);

EXPLAIN (COSTS OFF) SELECT * FROM users_h WHERE email = 'u50000@example.com';
-- Index Scan using users_h_email_hash on users_h
--   Index Cond: (email = 'u50000@example.com'::text)

CREATE UNIQUE INDEX h_uniq ON users_h USING hash (email);
-- ERROR:  access method "hash" does not support unique indexes

CREATE INDEX h_multi ON users_h USING hash (email, email);
-- ERROR:  access method "hash" does not support multicolumn indexes
```

That is: **no unique constraints, no multi-column**, and it does not participate in `ORDER BY` or range conditions.

## Why B-tree Is Already Enough for Most Equality Cases

"hash gives O(1) equality lookups so it should be faster" is an intuition trap. A B-tree is only 3–4 levels tall (see [B-tree Structure and Principles](./btree-structure)), so the number of page reads for an equality lookup differs little from hash, while a hash index still has to handle hash collisions and page packing. The real-world difference for equality queries is usually unmeasurable, whereas B-tree additionally gives you ranges, sorting, multi-column, and unique constraints. Hash has no size advantage either — measured on the same column with 200k long strings (a repeated 160-character md5 string):

```sql
-- long_text_h: v is a 160-character text
-- long_text_h_hash  | 64 MB   -- hash
-- long_text_h_btree | 15 MB   -- btree (smaller after PG 13+ deduplication)
```

The official documentation's position is equally clear: prefer B-tree unless testing proves a measurable benefit from hash (see [Index Types](https://www.postgresql.org/docs/current/indexes-types.html)).

## Checklist: When to Use / When Not To

**SP-GiST is worth using**:

- point data, where queries are "inside a box / nearest neighbor" — benchmark both GiST and SP-GiST;
- prefix retrieval on high-cardinality text (`LIKE 'prefix%'`, `^@`);
- inet/cidr subnet attribution queries.

**SP-GiST is unnecessary**: ordinary sortable types (use B-tree); you need unique constraints (SP-GiST does not support them); array/jsonb containment queries (use GIN).

**Hash is worth considering**: only in the very narrow case where "single-column equality is the sole query shape and benchmarks show a real benefit".

**Do not use Hash**: when you need unique constraints (use B-tree); multi-column conditions (use a B-tree composite index); range or sort needs (use B-tree); servers before PG 10 (no WAL, simply disabled). In one sentence: **default to B-tree for equality, and let hash appear only when benchmarks speak**. For the full selection path, see [The Index Selection Decision Tree](./index-selection-decision-tree).

## References

- [PostgreSQL Official Documentation · Chapter 11. Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL Official Documentation · 11.2. Index Types](https://www.postgresql.org/docs/current/indexes-types.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Pattern Matching](../advanced-sql/pattern-matching)
- [GiST Indexes](./gist)
- [B-tree Structure and Principles](./btree-structure)
- [The Index Selection Decision Tree](./index-selection-decision-tree)
- [index-selection-decision-tree](index-selection-decision-tree.md)
- [index](index.md)
