# Real-World Cases

Three common scenarios. Each gives you the table definition, the broken approach, the analysis, and the improved approach. All the SQL is runnable as-is. The shared theme: a database problem is often not about "can it be written at all," but about "does it break under high concurrency, and what do you do when it's slow."

## Case 1: Deep pagination in an order list

```sql
CREATE TABLE orders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL,
  amount numeric(10,2) NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO orders (user_id, amount, status)
SELECT (random() * 10000)::bigint, (random() * 1000)::numeric(10,2),
       (ARRAY['pending','paid','shipped','done'])[1 + (random() * 3)::int]
FROM generate_series(1, 100000);
```

The broken approach: flipping to page 5001 of the list.

```sql
SELECT id, user_id, amount FROM orders ORDER BY id OFFSET 100000 LIMIT 20;
```

Analysis: `OFFSET` means "fetch first, then discard." To produce row 100001, the database still has to scan the first 100020 rows in `id` order — an index can only establish sort order, it can't make the scan "jump" past the 100,000th row. The cost of scanning those first 100,000 rows grows linearly with the page number, and that work is repeated on every page turn. The root cause of slow deep pages is "expressing position with an offset," not a missing index.

The fix: use **the last id of the previous page as an anchor**, i.e. keyset pagination.

```sql
-- First page: start from 0
SELECT id, user_id, amount FROM orders WHERE id > 0 ORDER BY id LIMIT 20;

-- Later pages: the anchor is the id of the last row of the previous page's result
SELECT id, user_id, amount FROM orders WHERE id > 100000 ORDER BY id LIMIT 20;
```

Per-page latency is independent of the page number. Two things to watch:

- The sort key must uniquely determine position, which is why you sort by the primary key `id`. If you switch to sorting by `created_at`, add a unique column as a secondary key, otherwise rows sharing the same timestamp overwrite each other and pagination repeats;
- This form of pagination can only go "next page." When a user wants to jump directly to page 200 there's no direct way, and the common compromise is narrowing the range with a search box, or using `OFFSET` for the few cases that need it with a performance warning.

## Case 2: Idempotent stock deduction

```sql
CREATE TABLE products (
  id bigint PRIMARY KEY,
  name text NOT NULL,
  stock int NOT NULL CHECK (stock >= 0)
);
INSERT INTO products VALUES (1, 'widget', 10);

-- Request de-duplication table
CREATE TABLE order_requests (
  request_id uuid PRIMARY KEY,
  order_no text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

The broken approach comes in two flavors.

```sql
-- Wrong 1: deduct with no condition; under concurrency or retries stock goes negative
UPDATE products SET stock = stock - 5 WHERE id = 1;

-- Wrong 2: read then deduct; there's no atomicity guarantee between the two requests
SELECT stock FROM products WHERE id = 1;   -- sees 3
-- ... the application layer decides it's enough, then ...
UPDATE products SET stock = stock - 5 WHERE id = 1;   -- both concurrent requests pass the check
```

Analysis: when the condition check and the update are split into two steps, the check is based on the value **at read time**, while the update happens **later**, and something else can modify it in between — that's the race condition. Adding a lock with `SELECT stock FOR UPDATE` solves it, but banking correctness on "every call site remembers to lock" will eventually leak. Retries are just as dangerous: a gateway timeout retry lets the same order request arrive twice.

The fix: move "is this deduction allowed" into the `WHERE` clause so the database checks and updates in one shot.

```sql
-- Conditional update: deduct only when stock is sufficient; 0 rows returned means insufficient stock
UPDATE products
   SET stock = stock - 5
 WHERE id = 1 AND stock >= 5
 RETURNING stock;

-- Guard against duplicate requests: unique request_id + ON CONFLICT DO NOTHING
INSERT INTO order_requests (request_id, order_no)
VALUES ('a1b2c3d4-0000-4000-8000-000000000001', 'SO-20261012')
ON CONFLICT (request_id) DO NOTHING
RETURNING request_id;
```

Both happen in the **same transaction**, and the order is de-duplicate first, deduct second:

```sql
BEGIN;
INSERT INTO order_requests (request_id, order_no) VALUES ($1, $2)
  ON CONFLICT (request_id) DO NOTHING RETURNING request_id;  -- 0 rows: duplicate request, return success to upstream straight away
UPDATE products SET stock = stock - $3 WHERE id = $4 AND stock >= $3;   -- 0 rows: insufficient stock, return a stock error
COMMIT;
```

The application layer just checks the number of rows returned by the update — no need for a prior `SELECT` read. **Use parameterized placeholders** (see [client drivers](./client-drivers)); don't let the deduction amount get spliced into SQL from a string. `CHECK (stock >= 0)` is the last line of defense: even a leaked broken statement can't write stock negative.

## Case 3: High-frequency activity counters

```sql
-- Detail append table
CREATE TABLE page_views_raw (
  page_id int NOT NULL,
  viewed_at timestamptz NOT NULL DEFAULT now()
);

-- Per-minute aggregate table
CREATE TABLE page_view_minutes (
  bucket timestamp NOT NULL,
  page_id int NOT NULL,
  cnt bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, page_id)
);
```

The broken approach: updating a single cumulative row on every page view.

```sql
UPDATE page_views SET cnt = cnt + 1 WHERE page_id = 42;
```

Analysis: this is the textbook **hot row** — tens of thousands of requests all contend for the row lock on a single row, which shows up in the database as a chain queued up waiting for a lock, and throughput gets squeezed to serial levels. A more insidious consequence is that every request writes a new row version, producing the same amount of WAL and dead tuples, which raises vacuum's reclamation pressure. See [vacuum and dead tuples](../internals/vacuum-and-hot) for details.

The fix: change "accumulate into one row" to "insert into per-minute buckets."

```sql
-- Write path: on conflict, accumulate; still one row within a minute, but it rolls over each minute
INSERT INTO page_view_minutes (bucket, page_id, cnt)
VALUES (date_trunc('minute', now()), 42, 1)
ON CONFLICT (bucket, page_id) DO UPDATE SET cnt = page_view_minutes.cnt + 1;

-- Read path: aggregate over a time range
SELECT date_trunc('minute', viewed_at) AS bucket, count(*) AS pv
FROM page_views_raw
WHERE viewed_at >= now() - interval '1 hour'
GROUP BY 1 ORDER BY 1;
```

The conflict window shrinks from "the page's whole lifecycle" to "one minute," which sharply improves write concurrency. The `(bucket, page_id)` composite primary key lets the upsert hit the same index row, and the cost is one WAL record per row — so the bucket granularity can't be too fine (second-level buckets would give back the write overhead the conflict reduction saved).

Further down the line is scheduled aggregation: a scheduled job rolls the minute table up into a daily table or a totals table, and the detail table is partitioned by month to make archival deletion easy.

The other extreme is **append-only, never update**: all page views are plain `INSERT`s into `page_views_raw`, write amplification is minimal, and there's no lock contention at all — but every display has to aggregate with `GROUP BY`. Only layer in an aggregate table for read-heavy, write-light, low-latency scenarios. Approximate de-duplicated counting (such as unique visitors) can use HLL-family extensions with probabilistic data structures, trading precision for constant space.

## References

- [PostgreSQL official docs · psql](https://www.postgresql.org/docs/current/app-psql.html)
- [PostgreSQL official docs · F.32. pg_stat_statements — track statistics of SQL planning and execution](https://www.postgresql.org/docs/current/pgstatstatements.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [batch and write](../advanced-sql/batch-and-write)
- [composite index design](../indexing/composite-index-design)
- [vacuum and dead tuples](../internals/vacuum-and-hot)
- [CRUD and ON CONFLICT](../basics/crud-and-on-conflict)
- [index](index.md)
Official docs: [INSERT command](https://www.postgresql.org/docs/current/sql-insert.html), [UPDATE command](https://www.postgresql.org/docs/current/sql-update.html).
