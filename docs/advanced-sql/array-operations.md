# Array Operations

PostgreSQL's array types let one column hold multiple values of the same type, and are commonly used for "one to a few values" cases like tags, permission lists, and multi-value attributes. They are not a replacement for many-to-many relationships, but when "the values need no constraints and are only read or written whole with the row," they are far lighter than a child table. This page covers construction, subscripts, containment/overlap tests, converting to and from row sets, and the GIN index that goes with them.

## Sample Table and Array Construction

```sql
CREATE TABLE articles (
    id    int PRIMARY KEY,
    title text NOT NULL,
    tags  text[] NOT NULL DEFAULT '{}'
);

INSERT INTO articles VALUES
    (1, 'PG Indexing Basics', '{"postgres", "index", "basics"}'),
    (2, 'Slow Query Investigation',  '{"postgres", "performance"}'),
    (3, 'Redis Caching',  '{"redis", "performance"}');
```

A few ways to build an array:

```sql
SELECT ARRAY['postgres', 'index'];        -- {postgres,index}, recommended
SELECT '{a,b,c}'::text[];                 -- a literal; note the explicit type
SELECT string_to_array('a,b,c', ',');     -- split a string
SELECT array_append(ARRAY[1, 2], 3);      -- {1,2,3}
SELECT ARRAY(SELECT id FROM articles);    -- gather subquery results into an array
```

The `ARRAY[]` constructor must be able to infer its type, so write an empty array as `ARRAY[]::text[]`.

## Subscripts, Slices, and Multiple Dimensions

Subscripts start at 1 (not 0):

```sql
SELECT tags[1]    FROM articles WHERE id = 1;   -- postgres
SELECT tags[1:2]  FROM articles WHERE id = 1;   -- {postgres,index} (the slice includes both ends)
SELECT cardinality(tags)               FROM articles WHERE id = 1;   -- 3
SELECT array_length(tags, 1)           FROM articles WHERE id = 1;   -- 3

-- Assigning a single element is a legal UPDATE form
UPDATE articles SET tags[1] = 'postgresql' WHERE id = 1;
```

Multi-dimensional arrays are written as nested literals, and the dimensions must be equal length (rectangular):

```sql
SELECT ('{{1,2},{3,4}}'::int[])[2][1];          -- 3
SELECT array_length('{{1,2},{3,4}}'::int[], 2); -- 2 (the second dimension's length)
```

## Containment and Overlap: @>, <@, &&

Three operators cover most array queries:

```sql
-- @> containment: tags have both of these
SELECT * FROM articles WHERE tags @> ARRAY['postgres', 'performance'];   -- 2

-- <@ contained by: tags is a subset of the right-hand set
SELECT * FROM articles WHERE tags <@ ARRAY['postgres', 'index', 'basics']; -- 1

-- && overlap: tags shares any element with the right side
SELECT * FROM articles WHERE tags && ARRAY['redis', 'index'];            -- 1, 3
```

Keep the difference between `@>` and `&&` in mind: "all must be present" uses containment, "any one suffices" uses overlap.

## ANY/ALL Matching and unnest Expansion

`= ANY (array)` tests "any element equals the given value"; to treat an array as a row set, expand it with unnest:

```sql
-- Any element equals 'postgres'
SELECT * FROM articles WHERE 'postgres' = ANY (tags);    -- 1, 2

-- All elements satisfy the condition (shown here: all non-null)
SELECT * FROM articles WHERE true = ALL (SELECT unnest(tags) IS NOT NULL);

-- unnest expands an array into rows (a function written in FROM may implicitly reference earlier tables)
SELECT t.tag, count(*)
FROM articles a, unnest(a.tags) AS t(tag)
GROUP BY t.tag
ORDER BY count(*) DESC, t.tag;
-- performance | 2
-- postgres    | 2
-- ...

-- WITH ORDINALITY preserves the original position (PG 9.4+)
SELECT * FROM unnest(ARRAY['a', 'b']) WITH ORDINALITY AS t(v, n);
-- a | 1
-- b | 2
```

The semantics of `ALL (array)` combined with a comparison operator match the subquery forms of ANY/ALL, and the same three-valued logic applies when NULLs are mixed in.

## array_agg and array_to_string

The aggregation direction (row set -> array) complements the expansion direction (array -> string):

```sql
-- Gather rows into an array: all article titles under each tag
SELECT t.tag, array_agg(a.title ORDER BY a.title)
FROM articles a, unnest(a.tags) AS t(tag)
GROUP BY t.tag;

-- Join an array into a string (for display)
SELECT array_to_string(tags, ', ') FROM articles WHERE id = 1;
-- postgres, index, basics

-- Deduplicate while aggregating
SELECT array_agg(DISTINCT t.tag) FROM articles a, unnest(a.tags) AS t(tag);
```

`array_agg` and `unnest` are close inverses: the former folds a column into one row, the latter spreads one row out into a column. Group-then-aggregate-and-return-an-array is a common technique for saving a round trip to the application side.

## GIN Indexes and Tag Queries

`@>`/`<@`/`&&` on arrays are slow with sequential scans; a GIN index turns them into index lookups:

```sql
CREATE INDEX articles_tags_gin ON articles USING gin (tags);

-- All three forms use the GIN index
SELECT * FROM articles WHERE tags @> ARRAY['postgres', 'performance'];
SELECT * FROM articles WHERE tags && ARRAY['redis', 'index'];
SELECT * FROM articles WHERE tags <@ ARRAY['postgres', 'index', 'basics'];
```

The default `array_ops` opclass serves containment, overlap, containment by, and whole-value equality. To keep a query reliably hitting the index, write the condition in one of the operator forms above; `'postgres' = ANY(tags)` is a different expression, is not guaranteed to be rewritten, so in equality cases prefer writing `tags @> ARRAY['postgres']`. For GIN's structure and maintenance cost, see [GIN indexes](../indexing/gin).

## Boundaries for Using Tags and Multi-Value Attributes

Arrays suit: tags, category lists, sets of permissions/roles, several contact details for one entity — values that need no constraints, are only read or written whole with the row, and are queried with "containment/overlap."

Arrays do not suit:

- Values that need a foreign key reference, a uniqueness constraint, or reverse lookups elsewhere -> use a real many-to-many table.
- Arrays that grow without bound (such as appended logs) -> a single row inflates and every update rewrites the whole column. See [TOAST and large-field storage](../internals/toast).
- High-frequency "value -> row" lookups needing precise statistics -> expanding into rows with a B-tree is more direct.

## Caveats and Common Traps

- Subscripts start at 1; `tags[0]` is NULL and raises no error, and silent mistakes are the hardest to catch.
- A NULL array and an empty array are two different things: `tags IS NULL` differs from `tags = '{}'`, so normalize with `coalesce(tags, '{}')` before aggregating.
- Multi-dimensional arrays must be rectangular; unequal lengths within a row are an immediate error.
- `&&` and `@>` have different semantics; using the wrong one raises no error, it just returns results that "look wrong."
- After unnest and then filtering, the array shape is gone and GIN can no longer help; if you want an index, keep the array operator query.
- Updating any single element of an array rewrites the whole column's storage, so large arrays with frequent updates are a source of write amplification.

## References

- [PostgreSQL official documentation · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL official documentation · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [GIN indexes](../indexing/gin)
- [JSONB Operations](./jsonb-operations)
- [LATERAL and FROM Subqueries](./lateral-and-from-subquery)
- [Range Types and EXCLUDE](./range-types-and-exclude)
- [index](index.md)
- [lateral-and-from-subquery](lateral-and-from-subquery.md)
- [range-types-and-exclude](range-types-and-exclude.md)
- [recursive-cte](recursive-cte.md)
- [special-types-intro](/basics/special-types-intro.md)
Official documentation: [Array types](https://www.postgresql.org/docs/current/arrays.html), [Array functions and operators](https://www.postgresql.org/docs/current/functions-array.html).
