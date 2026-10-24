# Money and Numeric

Getting the type for a money field wrong (float for money, text for money, inconsistent rounding) is a direct financial incident in accounting systems. The options PostgreSQL offers are actually short: semantically exact `numeric`, or `bigint` integers stored in the smallest unit; neither `float` nor the built-in `money` type belongs in money storage. Here I record the principle behind each option, the rounding-rule traps, and arithmetic and aggregation behavior.

## numeric: Semantically Exact Fixed-Point Decimal

`numeric(precision, scale)` is fixed-point decimal: `precision` is the total number of significant digits, `scale` is the number of decimal places. `numeric(12,2)` means up to 10 integer digits plus 2 decimal digits; unparameterized `numeric` is arbitrary precision.

```sql
CREATE TABLE payments (
  id     bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  note   text
);

INSERT INTO payments (amount) VALUES (199.90);

SELECT amount, amount * 100 FROM payments;
-- 199.90 | 19990.00    —— exact decimal arithmetic, no floating-point error
```

`numeric` uses software-implemented decimal arithmetic on the CPU, so it is slower than integer and floating-point math, but at the read/write volume of money columns in OLTP the difference is entirely unnoticeable. Its core value is **semantic exactness**: store 0.1 and read back 0.1. For the official type reference, see [Numeric Types](https://www.postgresql.org/docs/current/datatype-numeric.html).

## Do Not Store Money in float

`float4`/`float8` are binary floating point, and most decimal fractions cannot be represented exactly:

```sql
SELECT 0.1::float8 + 0.2::float8;              -- 0.30000000000000004
SELECT (0.1::float8 + 0.2::float8) = 0.3;      -- false

SELECT 0.1::numeric + 0.2::numeric = 0.3::numeric;   -- true
```

A single error may be invisible, but accumulation (reconciliation, rollups) and multiplication/division (currency conversion) keep amplifying it; a `sum()` that does not match the ledger entries is the classic symptom of this class of problem. For the numeric modeling overview, see [Data Types Overview](../basics/data-types-overview).

## Store Cents in bigint or Yuan in numeric

Both are correct; pick one and use it consistently across the whole database:

```sql
-- Option A: bigint stores the smallest unit (cents); 199.90 yuan stored as 19990
CREATE TABLE payments_fen (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  amount  bigint  NOT NULL CHECK (amount >= 0),   -- unit: cents
  currency char(3) NOT NULL DEFAULT 'CNY'
);

-- Option B: numeric stores yuan
amount numeric(12,2) NOT NULL CHECK (amount >= 0)
```

- **bigint in cents** pros: integer math is fast with no rounding ambiguity at all; it aligns naturally with payment-gateway reconciliation units (WeChat Pay and Alipay both use cents), so what lands in the database is already a ledger entry. Cons: poor readability, manual queries require mental math, and if a unit finer than "cents" ever appears (rate allocation) the column needs changing.
- **numeric in yuan** pros: intuitive, add/subtract/multiply/divide directly in SQL. Cons: the rounding rule must be stated explicitly at every conversion point.

The key discipline: **do not mix the two options within the same business**, and document the unit in the API docs. Both are correct relative to `float` and text types.

## Rounding Rules

Two rounding behaviors coexist in PostgreSQL; mixing them guarantees an imbalance:

```sql
SELECT round(2.5::numeric), round(3.5::numeric);   -- 3 | 4   half away from zero
SELECT round(2.5::float8),  round(3.5::float8);    -- 2 | 4   half to even (banker's rounding)
```

- `round` on `numeric` is **round half up, away from zero** (2.5 rounds to 3, -2.5 to -3). This matches Java `BigDecimal`'s `HALF_UP`.
- `round` on `float8` goes through the C library `rint` and is **half to even** (2.5 rounds to 2, 3.5 to 4). Python `decimal`'s `ROUND_HALF_EVEN` is of the same kind.
- When reconciling across languages or systems, first agree both sides on the same rounding mode before discussing amounts; for "the parts must sum to the total" cases like discount allocation (splitting 10 yuan across 3 products), use the "round each item, last item takes the difference" pattern.

## numeric Arithmetic and Aggregation

```sql
SELECT 10::numeric / 4;
-- 2.5000000000000000    division yields a high-scale result; do not use bare

SELECT round(100.00::numeric * 0.07, 2);   -- 7.00    set the scale explicitly after computing tax

SELECT sum(amount) FROM payments;          -- sum(numeric) is still numeric; no precision loss
```

Key rules: addition/subtraction take the larger scale of the two operands; multiplication adds scales; **division produces far more decimal places than you expect** (16 digits in the example above), so every division should be followed by an explicit `round(..., 2)` to land on the target scale. For aggregation, both `sum(numeric)` and `avg(numeric)` return `numeric`; `sum(bigint)` also returns `numeric` (not `bigint`), so large rollups do not overflow.

## Why the money Type Is Not Used

PostgreSQL's built-in `money` type (written as pg_money in some references) is not recommended for new tables: the scale is fixed at 2, output and parsing behavior vary with the `lc_monetary` locale setting (symbols and separators both change when the locale changes), mixing it with other numeric types requires explicit casts, and it does not suit multiple currencies. When you need "an amount with a currency", model it yourself with `numeric` plus a `currency char(3)` column — behavior is fully under your control.

## References

- [PostgreSQL Documentation · 5.5. Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
- [PostgreSQL Documentation · 5.12. Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Data Types Overview](../basics/data-types-overview)
- [Constraints and Data Quality](./constraints-and-data-quality)
- [Design Anti-Patterns](./anti-patterns)
- [Modeling Time](./time-modeling)
- [data-types-overview](/basics/data-types-overview.md)
- [functions-and-operators](/basics/functions-and-operators.md)
- [anti-patterns](anti-patterns.md)
- [index](index.md)
