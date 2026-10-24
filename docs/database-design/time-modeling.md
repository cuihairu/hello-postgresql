# Modeling Time

Time fields are the highest-error-rate class of modeling: timezone interpretation, daylight-saving switchover, validity intervals — each can produce hard-to-trace bugs like "off by one hour" or "duplicate records". This page gives a set of conventions that hold up in production: store only `timestamptz` in the database (an absolute instant, internally UTC) and do the timezone conversion at the presentation layer; express interval semantics like validity windows with `tstzrange` plus an EXCLUDE constraint.

## timestamptz and the UTC Principle

`timestamptz` (`timestamp with time zone`) does not store a timezone; it stores **an absolute instant**. On input it interprets the string according to the session timezone as a point on the UTC timeline, and on output renders it again according to the session timezone. So the same value displays differently in different sessions:

```sql
SET timezone = 'Asia/Shanghai';
SELECT '2026-03-01 12:00:00'::timestamptz;
-- 2026-03-01 12:00:00+08

SET timezone = 'UTC';
SELECT '2026-03-01 12:00:00'::timestamptz;
-- 2026-03-01 12:00:00+00    ← same string, but this is already a different instant
```

From this follows the principle: **column types are always `timestamptz`, the database stores the absolute instant (internally UTC), and the timezone conversion happens at the presentation layer**. The application renders per the user's timezone, or the session runs `SET timezone` and the database renders. Do not scramble the server timezone and session timezone everywhere just to make the UI display "Beijing time" — that mixes presentation logic into the storage layer.

## The Pitfalls of timestamp without time zone

`timestamp` (without time zone) stores a "wall-clock time" literal, and the database applies no timezone interpretation at all. Two problems:

```sql
SELECT '2026-03-08 02:30:00'::timestamp;
-- just a wall-clock time; there is no way to know which absolute instant it corresponds to

SELECT '2026-03-08 02:30:00'::timestamp
       AT TIME ZONE 'America/New_York';   -- only after naming a timezone can it convert to an absolute instant
```

First, multi-timezone writers produce mutually contradictory values: the `12:00` written from Shanghai and the `12:00` written from New York are instants 12 hours apart, and once they land in the same column they cannot be told apart. Second, wall-clock times at a DST boundary are inherently ambiguous — the US enters daylight saving at 02:00 on March 8, 2026, so New York's wall-clock `02:30` that day **does not exist**; and in the autumn fall-back the `01:30` wall-clock time occurs twice. Only by storing the absolute instant (`timestamptz`) does this class of problem get a definite answer.

## Handling Timezones and Daylight Saving

- **Use IANA names for timezones** (`'Asia/Shanghai'`, `'America/New_York'`), not fixed offsets (`'+08:00'`) — an offset does not change with DST, and using it to convert dates spanning DST is guaranteed to be wrong.
- `AT TIME ZONE` is a bidirectional conversion operator whose direction is decided by the operand types:

  ```sql
  SELECT now() AT TIME ZONE 'Asia/Shanghai';
  -- timestamptz → timestamp: get Shanghai's wall-clock time

  SELECT '2026-03-01 08:00'::timestamp AT TIME ZONE 'America/New_York';
  -- timestamp → timestamptz: wall-clock time + timezone = absolute instant
  ```

- **Convert to the user's timezone before truncating for day-level aggregates**, otherwise the "each day" boundary is UTC midnight rather than the midnight the user perceives:

  ```sql
  SELECT date_trunc('day', created_at AT TIME ZONE 'Asia/Shanghai') AS day,
         count(*)
  FROM orders
  GROUP BY 1 ORDER BY 1;
  ```

For more date functions and timezone details, see the official documentation on [Date/Time Types](https://www.postgresql.org/docs/current/datatype-datetime.html) and the [Function Reference](https://www.postgresql.org/docs/current/functions-datetime.html).

## Expressing Validity Windows with tstzrange

For business that runs "from one moment to another" — price effective periods, membership validity, booking time slots — do not use two columns `valid_from`/`valid_to` with a pile of boundary comparisons; use a range type directly:

```sql
CREATE TABLE price_rules (
  id     bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku    text          NOT NULL,
  price  numeric(10,2) NOT NULL CHECK (price >= 0),
  during tstzrange     NOT NULL DEFAULT tstzrange(now(), NULL)  -- NULL upper bound = no expiry
);
```

The crux is the **boundary convention**: range types default to `'[)'`, left-closed right-open — the start is inclusive, the end exclusive. That way adjacent segments `['03-01','04-01')` and `['04-01','05-01')` abut perfectly without overlapping; with fully closed `'[]'`, the endpoint `04-01 00:00` would belong to both segments. For the full semantics of open and closed ranges, see the official [Range Types](https://www.postgresql.org/docs/current/rangetypes.html) documentation, and for operator details see [Range Types and EXCLUDE](../advanced-sql/range-types-and-exclude).

Overlap prevention relies on an EXCLUDE constraint (database-enforced "generalized uniqueness"):

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- makes GiST support text equality

ALTER TABLE price_rules ADD CONSTRAINT price_rules_no_overlap
  EXCLUDE USING gist (sku WITH =, during WITH &&);

INSERT INTO price_rules (sku, price, during)
VALUES ('A1', 99.00, tstzrange('2026-03-01', '2026-04-01'));   -- OK

INSERT INTO price_rules (sku, price, during)
VALUES ('A1', 89.00, tstzrange('2026-03-15', '2026-05-01'));
-- ERROR: conflicting key value violates exclusion constraint "price_rules_no_overlap"
```

Once a price segment for the same SKU overlaps it is rejected, so you no longer rely on the application checking before inserting (check-then-insert always leaks under concurrency).

## Queries and Indexes for "Currently Effective"

```sql
-- Approach 1: containment check, paired with a GiST index
SELECT * FROM price_rules
WHERE sku = 'A1' AND during @> now();

-- Approach 2: the equivalent valid_from/valid_to two-column form, btree-friendly
SELECT * FROM price_rules_v2
WHERE sku = 'A1'
  AND valid_from <= now()
  AND (valid_to IS NULL OR valid_to > now());
```

Approach 1 builds a GiST index on `(sku, during)`: `CREATE INDEX price_rules_sku_during_idx ON price_rules USING gist (sku, during);`. Approach 2 needs only a plain composite index on `(sku, valid_from)`. Either modeling is fine — pick one and use it consistently across the team; the range form's advantage is that it pairs naturally with EXCLUDE constraints and the overlap operator (`&&`).

## The Audit Snapshot Pattern

When dimension data that needs historical versions (prices, org structure, membership levels), record every change as a row interval using the `valid_from`/`valid_to` pair (i.e. the SCD2 pattern), and locate the version at any past moment in historical queries with `during @> some_instant` — indexes, constraints, and query form are all identical to above, except the range is closed off automatically by the system at change time. For implementation details and trigger maintenance, see [Constraints and Data Quality](./constraints-and-data-quality).

## References

- [PostgreSQL Documentation · 5.5. Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
- [PostgreSQL Documentation · 5.12. Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Data Types Overview](../basics/data-types-overview)
- [Range Types and EXCLUDE](../advanced-sql/range-types-and-exclude)
- [Constraints and Data Quality](./constraints-and-data-quality)
- [TimescaleDB](../ecosystem/timescaledb)
- [range-types-and-exclude](/advanced-sql/range-types-and-exclude.md)
- [data-types-overview](/basics/data-types-overview.md)
- [naming-and-style-conventions](/basics/naming-and-style-conventions.md)
- [anti-patterns](anti-patterns.md)
- [constraints-and-data-quality](constraints-and-data-quality.md)
- [index](index.md)
- [logical-to-physical-modeling](logical-to-physical-modeling.md)
- [money-and-numeric](money-and-numeric.md)
- [table-inheritance-and-partitioning-design](table-inheritance-and-partitioning-design.md)
- [timescaledb](/ecosystem/timescaledb.md)
