# JSONB Operations

PostgreSQL offers two JSON types: `json` stores an exact copy of the input text, while `jsonb` stores a parsed binary representation. Nearly every day-to-day use should choose jsonb: it supports the full set of operators, indexes, and jsonpath queries, at the cost of one extra parse on write. Here we walk through jsonb's core operations in the order "read -> query -> modify -> narrow."

## Differences Between json and jsonb

| Dimension | json | jsonb |
| ---- | ---- | ----- |
| Storage | Exact copy of the original text, preserving whitespace, key order, and duplicate keys | Parsed binary; keys deduplicated, order not guaranteed |
| Write | Fast (no parsing) | Slightly slower (must parse and build the representation) |
| Queries and operators | Essentially none | Fully supported |
| Indexing | Only expression indexes | Direct GIN support |

Use json only when you must preserve the original text byte for byte (for example, storing external system messages for audit comparison); default to jsonb everywhere else.

## Sample Table

```sql
CREATE TABLE products (
    id    int PRIMARY KEY,
    name  text NOT NULL,
    attrs jsonb NOT NULL DEFAULT '{}'::jsonb
);

INSERT INTO products VALUES
    (1, 'Wireless Mouse', '{"color": "black", "weight_g": 98,
                          "tags": ["Office", "2.4G"], "specs": {"dpi": 1600}}'),
    (2, 'Mechanical Keyboard', '{"color": "white", "weight_g": 850,
                               "tags": ["Gaming", "Custom"], "specs": {"layout": "75%"}}');
```

## Path Operators: ->, ->>, #>, #>>

The single arrow returns jsonb, the double arrow returns text; `#>`/`#>>` use a path array to reach nested values:

```sql
SELECT attrs -> 'color'         FROM products WHERE id = 1;  -- "black" (jsonb)
SELECT attrs ->> 'color'        FROM products WHERE id = 1;  -- black (text)
SELECT attrs #> '{specs,dpi}'   FROM products WHERE id = 1;  -- 1600 (jsonb)
SELECT attrs #>> '{specs,dpi}'  FROM products WHERE id = 1;  -- '1600' (text)

-- Arrays use numeric subscripts (starting from 0)
SELECT attrs -> 'tags' ->> 0    FROM products WHERE id = 1;  -- Office
```

From PG 13, subscript syntax is also supported, with the same effect as `->` and more readable for deep nesting:

```sql
SELECT attrs['specs']['dpi'] FROM products WHERE id = 1;   -- 1600
```

## Containment and Existence: @>, <@, ?

`@>` (containment) tests whether the left side contains the right side's structure and values in whole, and is the most common way to query jsonb; the `?` family checks only top-level keys or top-level strings:

```sql
-- Whole containment: the document just needs to contain the color=black part; other keys do not matter
SELECT * FROM products WHERE attrs @> '{"color": "black"}';          -- 1

-- Nested containment works the same way
SELECT * FROM products WHERE attrs @> '{"specs": {"dpi": 1600}}';    -- 1

-- Array containment: tags contains "Office"
SELECT * FROM products WHERE attrs -> 'tags' @> '["Office"]';          -- 1

-- Top-level key exists
SELECT * FROM products WHERE attrs ? 'weight_g';                     -- 1, 2

-- Any key exists / all keys exist
SELECT * FROM products WHERE attrs ?| array['color', 'tags'];
SELECT * FROM products WHERE attrs ?& array['color', 'weight_g'];
```

Note the special semantics of `?`: applied to an array it checks "top-level string elements," so `'["a","b"]'::jsonb ? 'a'` is true; that is a different thing from `@>`'s whole containment.

## JSONB Array Elements

Arrays can be indexed by position or expanded into rows, connecting into the rest of SQL:

```sql
-- Expand into rows (one row per tag)
SELECT jsonb_array_elements_text(attrs -> 'tags') FROM products WHERE id = 1;
-- Office
-- 2.4G

-- JOIN with the full table to expand and count
SELECT p.name, t.tag
FROM products p, jsonb_array_elements_text(p.attrs -> 'tags') AS t(tag)
ORDER BY p.id;

-- Array length
SELECT jsonb_array_length(attrs -> 'tags') FROM products WHERE id = 1;   -- 2
```

## Modifying: jsonb_set, jsonb_insert, and ||

jsonb is an immutable value, so "modifying" it actually means replacing the whole value. The usual tools:

```sql
-- Set/add: when the path does not exist, it is created by default (create_missing defaults to true)
UPDATE products SET attrs = jsonb_set(attrs, '{specs,dpi}', '3200') WHERE id = 1;
UPDATE products SET attrs = jsonb_set(attrs, '{warranty_months}', '24') WHERE id = 1;

-- Delete: use - for top-level keys, #- for nested keys
UPDATE products SET attrs = attrs - 'color' WHERE id = 1;
UPDATE products SET attrs = attrs #- '{specs,dpi}' WHERE id = 1;

-- || merges: a key on the right overwrites the same key on the left (shallow merge; nested objects are not merged recursively)
UPDATE products SET attrs = attrs || '{"color": "grey", "stock": 12}' WHERE id = 1;

-- jsonb_insert: insert an element before a given array subscript (the fourth argument being true inserts after it)
UPDATE products SET attrs = jsonb_insert(attrs, '{tags,0}', '"New"') WHERE id = 1;
```

One silent trap: when an intermediate level of `jsonb_set`'s path does not exist, it does not create it automatically — the original value is returned unchanged with no error, so confirm the structure exists before a bulk update.

## jsonpath: SQL/JSON Path (PG 12+)

jsonpath is a standalone path language that supports variables, filters, and arithmetic, making it far more expressive than `#>`:

```sql
-- Expand array elements
SELECT jsonb_path_query(attrs, '$.tags[*]') FROM products WHERE id = 1;

-- Existence check with a filter: dpi greater than 1500
SELECT id FROM products
WHERE jsonb_path_exists(attrs, '$.specs.dpi ? (@ > 1500)');        -- 1

-- @? is the operator form of jsonb_path_exists
SELECT id FROM products WHERE attrs @? '$.tags[*] ? (@ == "Office")';

-- Take the first matching value
SELECT jsonb_path_query_first(attrs, '$.tags[*]') FROM products WHERE id = 1;
```

Also available are `jsonb_path_query_array` (collects results into an array) and `@@` (treats a path predicate's result directly as a boolean). The default lax mode automatically unwraps arrays, so writing `$.tags[*]` and `$.tags` is often equivalent; when you need strict structure validation, start with `$strict.`.

## Containment Combined with GIN Indexes

`@>` and the `?` family have no ordinary B-tree index available; pair them with GIN to work on large tables:

```sql
CREATE INDEX products_attrs_gin ON products USING gin (attrs);

-- Both of the following use the index above
SELECT * FROM products WHERE attrs @> '{"color": "black"}';
SELECT * FROM products WHERE attrs ? 'weight_g';
```

The default `jsonb_ops` supports `@>`/`?`/`?|`/`?&`; when you only query containment, switch to `jsonb_path_ops`, which gives a smaller index and faster point lookups but does not support the `?` family. For choosing between the two opclasses, see [GIN indexes](../indexing/gin); if the hotspot is "retrieve the text value of a key for equality queries," an expression index is often more cost-effective than GIN. See [Expression indexes](../indexing/expression-indexes).

## Type Narrowing and Casts

`->>`/`#>>` both return text, so you must cast explicitly before numeric or timestamp comparisons:

```sql
-- Trap: text comparison is lexicographic, so '98' > '850' is true
SELECT attrs ->> 'weight_g' > '850' FROM products WHERE id = 1;       -- true (wrong)

-- Narrow to a number first, then compare
SELECT (attrs ->> 'weight_g')::int > 850 FROM products WHERE id = 1;  -- false (right)
```

Conversely, to flatten jsonb into relational rows use `jsonb_to_record`:

```sql
SELECT * FROM jsonb_to_record('{"color": "black", "weight_g": 98}')
    AS x(color text, weight_g int);
--  color | weight_g
-- -------+----------
--  black |       98
```

## Caveats and Common Traps

- `->` returns jsonb and `->>` returns text; comparing jsonb and text directly raises `operator does not exist: jsonb = text`.
- Numeric values pulled out of jsonb come back as text, so lexicographic comparison gives wrong conclusions — cast before comparing.
- jsonb does not preserve key order and keeps only the last of duplicate keys; any logic that depends on key order is unreliable.
- `@>` on arrays is whole containment; to test "the array contains some element," either use `?` or write a single-element array like `'["Office"]'`.
- Frequent partial updates of a large jsonb column rewrite the entire TOAST value every time, causing noticeable write amplification. See [TOAST and large-field storage](../internals/toast).
- To update one key, use `jsonb_set`/`||`; a direct `SET attrs = '{"a":1}'` overwrites every other key.

## References

- [PostgreSQL official documentation · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL official documentation · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [JSONB Design Patterns](./jsonb-design-patterns)
- [GIN indexes](../indexing/gin)
- [Generated Columns and CHECK Constraints](./generated-columns-and-check)
- [TOAST and large-field storage](../internals/toast)
- [array-operations](array-operations.md)
- [index](index.md)
- [jsonb-design-patterns](jsonb-design-patterns.md)
- [special-types-intro](/basics/special-types-intro.md)
- [anti-patterns](/database-design/anti-patterns.md)
- [postgresql-17-features](/ecosystem/postgresql-17-features.md)
- [gin](/indexing/gin.md)
- [toast](/internals/toast.md)
- [knowledge](/knowledge.md)
Official documentation: [JSON types](https://www.postgresql.org/docs/current/datatype-json.html), [JSON functions and operators](https://www.postgresql.org/docs/current/functions-json.html).
