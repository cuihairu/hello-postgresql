# Range Types and EXCLUDE

Range types express "from some value to some value" in a single column (such as a time span or a price interval), accompanied by containment, overlap, and adjacency operators; combined with an EXCLUDE constraint, business rules like "overlaps are not allowed" can be pushed down to the database layer. Typical uses are meeting-room bookings, validity-period management, and IP block allocation. This page covers the built-in types, boundary semantics, operator functions, and the complete way to write an overlap-prevention constraint.

## Built-in Range Types

| Type | Element type | Typical use |
| ---- | -------- | -------- |
| int4range | int4 | Ranking intervals, port blocks |
| int8range | int8 | Order number blocks, ID intervals |
| numrange | numeric | Price intervals, quotas |
| tsrange | timestamp (without time zone) | Local time intervals |
| tstzrange | timestamptz | Cross-time-zone schedules and bookings |
| daterange | date | Validity periods, business days |

For cross-time-zone applications, always use tstzrange — tsrange carries no time zone, so "the same instant" in two time zones gets stored as different literal values. From PG 14, each range family also has a corresponding multirange (a set of ranges); see range_agg below.

## Boundaries and Literals: The Default Is [)

In a literal, `[`/`]` mean the endpoint is included, `(`/`)` mean it is excluded. The default boundary for every range type is `[)` (closed on the left, open on the right):

```sql
SELECT '[3,7)'::int4range;      -- [3,7): includes 3, excludes 7
SELECT '(3,7]'::int4range;      -- (3,7]
SELECT '[3,7]'::int4range;      -- displayed as [3,8): discrete types are normalized to [)
SELECT int4range(3, 7);         -- the constructor defaults to [3,7)
SELECT int4range(3, 7, '[]');   -- specify the boundary style explicitly

SELECT 'empty'::int4range;                          -- an empty range
SELECT '[,)'::numrange;                             -- an unbounded range
SELECT '[2026-10-12 09:00+08, 2026-10-12 10:00+08)'::tstzrange;
```

Discrete types (integers, dates) normalize any boundary style to `[)`: `[3,7]` is stored as `[3,8)`. Continuous types (numrange, tsrange/tstzrange) leave the endpoints alone. Unbounded boundaries are always treated as open, and even written as `]` they are handled as `)`.

## Operators and Functions

```sql
SELECT int4range(1,5) @> 3;                     -- true: contains the element
SELECT int4range(1,5) @> int4range(2,4);        -- true: contains the whole range
SELECT int4range(1,5) <@ int4range(1,9);        -- true: contained by
SELECT int4range(1,5) && int4range(4,9);        -- true: overlaps (shares a point)
SELECT int4range(1,5) -|- int4range(5,9);       -- true: adjacent (touching)
SELECT int4range(1,5) << int4range(5,9);        -- true: strictly to the left

SELECT lower('[3,7)'::int4range),   upper('[3,7)'::int4range);    -- 3 | 7
SELECT lower_inc('[3,7)'::int4range), upper_inc('[3,7)'::int4range); -- t | f
SELECT isempty('empty'::int4range);             -- true
SELECT range_merge(int4range(1,3), int4range(5,7));  -- [1,7): the smallest range covering both

-- From PG 14: aggregate ranges into a multirange, merging overlapping parts automatically
SELECT range_agg(r)
FROM (VALUES ('[1,3)'::int4range), ('[2,5)'::int4range)) AS t(r);
-- {[1,5)}
```

`-|-` for adjacency is handy: to ask "does the next session immediately follow the previous one," do not hand-calculate boundary additions and subtractions — just use `-|-`.

## EXCLUDE: Preventing Overlaps with a Constraint

A classic meeting-room requirement: the same room may not be booked in overlapping times. EXCLUDE USING gist states it in a single constraint:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- needed for scalar equality GiST operators on int

CREATE TABLE room_bookings (
    id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    room_id   int NOT NULL,
    during    tstzrange NOT NULL,
    booked_by text NOT NULL,
    EXCLUDE USING gist (room_id WITH =, during WITH &&)
);

INSERT INTO room_bookings (room_id, during, booked_by)
VALUES (1, '[2026-10-12 09:00+08, 2026-10-12 10:00+08)', 'Zhang');

-- Same room, overlapping times -> rejected
INSERT INTO room_bookings (room_id, during, booked_by)
VALUES (1, '[2026-10-12 09:30+08, 2026-10-12 11:00+08)', 'Li');
-- ERROR: conflicting key value violates exclusion constraint
--        "room_bookings_room_id_during_excl"

-- A different room -> fine
INSERT INTO room_bookings (room_id, during, booked_by)
VALUES (2, '[2026-10-12 09:30+08, 2026-10-12 11:00+08)', 'Li');
```

What the constraint means: there are no two rows where "room_id is equal and during overlaps." A few essentials:

- `room_id WITH =` depends on the scalar equality GiST operator supplied by the btree_gist extension; without it you get `data type integer has no default operator class for access method "gist"`.
- EXCLUDE automatically creates a GiST index of the same name, and constraint checks and ordinary queries share it.
- An empty range "does not overlap" any range (`empty && x` is always false), so empty bookings are never blocked — that is both a feature and a trap; do not let the business write empty ranges.
- The constraint applies only within a single table; exclusion across tables or across partitions must be guaranteed separately by the application layer or a partitioning strategy.

## GiST Indexes and Range Queries

A GiST index on a range column serves all the range operators `@>`/`<@`/`&&`/`-|-`. The composite index (room_id, during) that the EXCLUDE above created can directly serve "find bookings in a room that conflict with a given window":

```sql
-- Uses the GiST index that EXCLUDE created automatically
SELECT id, booked_by
FROM room_bookings
WHERE room_id = 1
  AND during && tstzrange('2026-10-12 10:30+08', '2026-10-12 12:00+08');
```

For tables without an EXCLUDE constraint, just build a GiST index manually:

```sql
CREATE INDEX room_bookings_during_idx ON room_bookings USING gist (during);
```

For GiST's structure and applicable scenarios, see [GiST indexes](../indexing/gist).

## Caveats and Common Traps

- Mixing tstzrange and tsrange produces two representations of "the same instant"; use tstzrange uniformly in business tables.
- `upper()` on a discrete type returns the exclusive bound: after normalization `'[3,7]'` is `[3,8)`, so `upper()` yields 8, not 7; to get 7 you need `upper(...) - 1`.
- EXCLUDE does not check NULL: rows where `during` is NULL are completely unconstrained, so add NOT NULL to range columns.
- Use `-|-` for adjacency; do not compare `upper(a) = lower(b)` yourself — open and closed boundaries will make that equality fail to line up.
- Times inside range literals must carry a time zone offset (tstzrange); a literal without an offset is interpreted in the server's time zone, which easily plants a mine when the container's and the host's time zones differ.
- The exclusion-constraint conflict error occurs at write time; the application must be ready to turn 23P01 (exclusion_violation) into a friendly message.

## References

- [PostgreSQL official documentation · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL official documentation · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [GiST indexes](../indexing/gist)
- [Array Operations](./array-operations)
- [Time Modeling](../database-design/time-modeling)
- [CHECK and Domains](../database-design/check-and-domains)
- [array-operations](array-operations.md)
- [index](index.md)
- [special-types-intro](/basics/special-types-intro.md)
- [constraints-and-data-quality](/database-design/constraints-and-data-quality.md)
- [time-modeling](/database-design/time-modeling.md)
- [postgis](/ecosystem/postgis.md)
- [postgresql-17-features](/ecosystem/postgresql-17-features.md)
- [gist](/indexing/gist.md)
Official documentation: [Range types](https://www.postgresql.org/docs/current/rangetypes.html), [btree_gist extension](https://www.postgresql.org/docs/current/btree-gist.html).
