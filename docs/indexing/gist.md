# GiST Indexes

GiST (Generalized Search Tree) is not a concrete index but a "balanced tree + predicate nodes" framework: what it can index and what operators it supports are decided entirely by the **operator class (opclass)** on the column. The same structure does spatial retrieval with a geometry opclass and interval-overlap queries with a range opclass. This makes GiST the primary choice for "data B-tree cannot sort": range types, geometry types, KNN nearest neighbors. See the official documentation on [GiST Indexes](https://www.postgresql.org/docs/current/gist.html).

## The Operator Class Decides What Can Be Indexed

Built-in opclasses (PG 16/17):

| Operator class | Index type | Typical operators |
| --- | --- | --- |
| `range_ops` | any range type | `&&` `@>` `<@` `<<` `>>` `-|-` `=` |
| `box_ops` / `poly_ops` | box / polygon | `&&` `@>` `<@` `<<` `>>` |
| `point_ops` (default) / `kd_point_ops` | point | `<@` `~=` and KNN `<->` |
| `inet_ops` (PG 10+) | inet / cidr | `<<` `<<=` `>>` `>>=` `=` `&&` |
| `text_ops` | text | `<` `<=` `=` `>` `>=` and `^@` (PG 15+) |

When you build an index without naming an opclass, the type's default is used, e.g. `tstzrange` defaults to `range_ops`:

```sql
CREATE TABLE meetings (
    room   text,
    during tstzrange NOT NULL,
    title  text
);

INSERT INTO meetings
SELECT 'room-' || (g % 5),
       tstzrange(now() - (g || ' min')::interval,
                 now() - (g || ' min')::interval + interval '30 min'),
       'm' || g
FROM generate_series(1, 2000) g;

CREATE INDEX meetings_during_idx ON meetings USING gist (during);
ANALYZE meetings;

EXPLAIN (COSTS OFF) SELECT * FROM meetings
WHERE during && tstzrange(now(), now() + interval '1 hour', '[)');
-- Bitmap Heap Scan on meetings
--   Recheck Cond: (during && tstzrange(...))
--   ->  Bitmap Index Scan on meetings_during_idx
--         Index Cond: (during && tstzrange(...))
```

For the full semantics of range types, see [Range Types and EXCLUDE](../advanced-sql/range-types-and-exclude).

## KNN: Distance Ordering Straight from the Index

GiST (and the point classes of SP-GiST) supports a distance operator `<->` in `ORDER BY`: the index returns rows in distance order, and with `LIMIT n` only the nearest n are computed:

```sql
CREATE TABLE poi (name text, loc point);
INSERT INTO poi
SELECT 'p' || g, point(120 + (g % 1000) * 0.001, 30 + (g % 1000) * 0.001)
FROM generate_series(1, 2000) g;

CREATE INDEX poi_loc_idx ON poi USING gist (loc);

EXPLAIN (COSTS OFF) SELECT name FROM poi
ORDER BY loc <-> point(120.5, 30.5) LIMIT 5;
-- Limit
--   ->  Index Scan using poi_loc_idx on poi
--         Order By: (loc <-> '(120.5,30.5)'::point)
```

Notice there is no Sort node in the plan — distance ordering is the index's own traversal order. Vector search (pgvector) uses HNSW/IVFFlat, which are independent access methods with the same underlying idea, see [pgvector](../ecosystem/pgvector).

## Lossy Indexes and Recheck

Some opclasses store only **approximate information** in the index. For example, `poly_ops` stores only the bounding box for a polygon: the index uses the box to judge "possibly intersecting", and on a hit the executor applies the original condition for an exact filter — this step is called a **recheck**. Such indexes are called lossy. In the plan it shows up as `Recheck Cond`, and under `EXPLAIN ANALYZE` you also see `Rows Removed by Index Recheck`:

```sql
CREATE TABLE shapes (id int, poly polygon);
INSERT INTO shapes SELECT g, polygon(circle(point(0,0), 5 + (g % 10)))
FROM generate_series(1, 2000) g;
CREATE INDEX shapes_poly_idx ON shapes USING gist (poly);

EXPLAIN (COSTS OFF) SELECT * FROM shapes
WHERE poly && polygon(box(point(0.1,0.1), point(0.1,0.1)));
-- Bitmap Heap Scan on shapes
--   Recheck Cond: (poly && '((0.1,0.1),...)'::polygon)   -- the exact filter happens here
--   ->  Bitmap Index Scan on shapes_poly_idx             -- the index filters only by bounding box
```

Design impact: the closer the bounding box is to the actual shape, the less recheck waste; for thin, holed, or otherwise odd geometries, recheck may filter out a large number of candidate rows, which is a common reason geometry indexes underperform expectations.

## btree_gist: Getting Ordinary Types into GiST

GiST's built-in opclasses cover only range, geometry, text and similar types. But a high-frequency need is "an ordinary column + a range column" combined into one GiST index — **EXCLUDE constraints** require every column to go through GiST (see [Constraints and Data Quality](../database-design/constraints-and-data-quality)). The `btree_gist` extension brings B-tree types such as int, text, and timestamptz into GiST:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- no two bookings for the same room in the same time slot
ALTER TABLE meetings ADD CONSTRAINT no_overlap
  EXCLUDE USING gist (room WITH =, during WITH &&);
```

Two practical tips:

- If the table already has mutually conflicting data when you add the constraint, you get a direct error, e.g. `DETAIL: Key (room, during)=(room-1, [...]) conflicts with key (room, during)=(room-1, [...])`; clean the data first.
- The B-tree-equivalent query performance of `btree_gist` is **not as good as a real B-tree index**; it exists to make the constraint work, not to replace B-tree.

## GiST vs. GIN

Both are "generalized" indexes, and the choice depends on the data shape and the query shape:

| Dimension | GiST | GIN |
| --- | --- | --- |
| Entry granularity | one entry per row, updatable in place | one entry per component, one row insert may write many entries |
| Write cost | relatively gentle, no pending list | depends on fastupdate/pending list, jitter if cleanup lags |
| Strong queries | overlap `&&`, adjacency, nearest neighbor `<->`, EXCLUDE constraints | containment `@>`, key existence `?`, lexeme matching `@@` |
| Lossy | some opclasses are lossy (require recheck) | effectively lossless |
| Typical data | range types, geometry, point | arrays, jsonb, tsvector, trigram |

Rule of thumb: when the query shape is "is there an intersection / who is nearest", use GiST; when it is "does it contain / does it have this lexeme", use GIN. For tsvector full-text search the official docs also recommend GIN first (GiST is lossy and its queries are slower), see [Full-Text Search](../advanced-sql/full-text-search). For the full selection path, see [The Index Selection Decision Tree](./index-selection-decision-tree).

## References

- [PostgreSQL Official Documentation · Chapter 11. Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL Official Documentation · 11.2. Index Types](https://www.postgresql.org/docs/current/indexes-types.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Range Types and EXCLUDE](../advanced-sql/range-types-and-exclude)
- [GIN Indexes](./gin)
- [PostGIS](../ecosystem/postgis)
- [The Index Selection Decision Tree](./index-selection-decision-tree)
- [range-types-and-exclude](/advanced-sql/range-types-and-exclude.md)
- [postgis](/ecosystem/postgis.md)
- [index-selection-decision-tree](index-selection-decision-tree.md)
- [index](index.md)
- [spgist-and-hash](spgist-and-hash.md)
