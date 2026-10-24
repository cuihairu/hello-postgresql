# Normalization and Denormalization

Normalization is where relational database design starts: you split tables to eliminate redundant dependencies, so each fact is written in exactly one place and every other place refers to it by foreign key. Here I record the 1NF/2NF/3NF rules, give one rewrite example for each from bad to good, and show how redundancy creates update anomalies. I close with when it is safe to denormalize on purpose.

## 1NF: Atomic Fields

1NF requires field values that cannot be subdivided — no comma-separated lists, arrays, or JSON documents. The most common code smell is cramming multiple values into a single field:

```sql
-- Bad: items is a comma-separated product string, so one order can only occupy one row
CREATE TABLE orders_bad (
    order_id int PRIMARY KEY,
    customer text NOT NULL,
    items    text NOT NULL,          -- e.g. "Laptop,Mouse,Keyboard"
    total    numeric(10,2) NOT NULL
);

INSERT INTO orders_bad VALUES (1, 'Zhang San', 'Laptop,Mouse,Keyboard', 8000.00);

-- Good: one row per product, so fields are atomic by nature
CREATE TABLE orders (
    order_id   int PRIMARY KEY,
    customer   text NOT NULL,
    total      numeric(10,2) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
    order_id   int REFERENCES orders(order_id),
    product_id int NOT NULL,
    quantity   int NOT NULL CHECK (quantity > 0),
    price      numeric(10,2) NOT NULL,
    PRIMARY KEY (order_id, product_id)
);

INSERT INTO orders VALUES (1, 'Zhang San', 8000.00, now());
INSERT INTO order_items VALUES
    (1, 101, 1, 5000.00),
    (1, 102, 1, 300.00),
    (1, 103, 1, 2700.00);
```

After the split, "how many units of each product were sold" can be answered directly with `GROUP BY product_id`; the bad table needs string splitting first to compute sales volume, which cannot be indexed and cannot carry per-product constraints.

## 2NF: Removing Partial Dependencies

2NF deals with composite primary keys: non-key fields must depend on the whole key, not just part of it.

```sql
-- Bad: the key is (purchase_id, product_id),
-- but product_name and unit_price depend only on product_id — partial dependencies
CREATE TABLE purchases_bad (
    purchase_id  int,
    product_id   int,
    product_name text NOT NULL,
    unit_price   numeric(10,2) NOT NULL,
    quantity     int NOT NULL,
    PRIMARY KEY (purchase_id, product_id)
);

INSERT INTO purchases_bad VALUES (1, 101, 'Laptop', 5000.00, 10);
INSERT INTO purchases_bad VALUES (2, 101, 'Laptop', 5000.00, 5);

-- Good: product info moves to products, and the detail table keeps only
-- "which purchase, which product, how many units"
CREATE TABLE products (
    product_id   int PRIMARY KEY,
    product_name text NOT NULL,
    unit_price   numeric(10,2) NOT NULL
);

INSERT INTO products VALUES (101, 'Laptop', 5000.00);

CREATE TABLE purchase_items (
    purchase_id int,
    product_id  int REFERENCES products(product_id),
    quantity    int NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (purchase_id, product_id)
);

INSERT INTO purchase_items VALUES (1, 101, 10), (2, 101, 5);
```

The cost of partial dependencies: the same product repeats its name and price in every detail row, which wastes space and leaves an inconsistency risk where two entry points can change the price.

## 3NF: Removing Transitive Dependencies

3NF requires that no dependency exists among non-key fields: a column must not be determined indirectly through another non-key field.

```sql
-- Bad: dept_name and dept_manager depend transitively on employee_id via dept_id
CREATE TABLE employees_bad (
    employee_id   int PRIMARY KEY,
    employee_name text NOT NULL,
    dept_id       int NOT NULL,
    dept_name     text NOT NULL,
    dept_manager  text NOT NULL
);

INSERT INTO employees_bad VALUES (1, 'Li Si', 5, 'R&D Dept', 'Wang Wu');

-- Good: department info appears once, in departments
CREATE TABLE departments (
    dept_id      int PRIMARY KEY,
    dept_name    text NOT NULL,
    dept_manager text NOT NULL
);

INSERT INTO departments VALUES (5, 'R&D Dept', 'Wang Wu');

CREATE TABLE employees (
    employee_id   int PRIMARY KEY,
    employee_name text NOT NULL,
    dept_id       int REFERENCES departments(dept_id)
);

INSERT INTO employees VALUES (1, 'Li Si', 5);
```

## How Redundancy Causes Update Anomalies

The three bad tables above share one root cause: a single fact is copied into many places. That produces three classes of anomaly:

```sql
-- Update anomaly: renaming a department means touching every related employee row;
-- miss one row and two department names exist
UPDATE employees_bad SET dept_name = 'R&D Center' WHERE dept_name = 'R&D Dept';
```

- **Update anomaly**: the same fact lives in many places, so every copy must be updated in sync; miss one and the data is inconsistent.
- **Insert anomaly**: when a new department has no employees yet, there is no place to put the department info in the employee table (no row to insert).
- **Delete anomaly**: delete the last employee of a department and the department info vanishes with it.

Normalization gives each fact a single write point: the department name is stored once in the `departments` table, so one update is enough.

## Two Common Forms of Denormalization

Normalization is not the end state. When JOIN cost becomes the bottleneck, you can introduce redundancy in a controlled way:

**Summary tables**: precompute aggregate results and store them, so reports query the summary directly instead of scanning the detail rows.

```sql
CREATE TABLE daily_sales (
    stat_date    date PRIMARY KEY,
    order_count  int NOT NULL,
    total_amount numeric(12,2) NOT NULL
);

-- A scheduled task backfills yesterday's summary; reruns are safe (UPSERT)
INSERT INTO daily_sales (stat_date, order_count, total_amount)
SELECT o.created_at::date, COUNT(*), SUM(o.total)
FROM orders o
WHERE o.created_at::date = CURRENT_DATE - 1
GROUP BY 1
ON CONFLICT (stat_date) DO UPDATE
    SET order_count  = EXCLUDED.order_count,
        total_amount = EXCLUDED.total_amount;
```

**Wide tables**: flatten several display dimensions of one entity into a single row, so queries do not need to JOIN multiple tables. Data-warehouse wide tables lean toward OLAP design; in OLTP the more common form is "redundant snapshot fields" — for example, storing the product name and transacted price at order time in the order detail, because products can be renamed and repriced, and the order must remember the values at the moment of sale.

The cost of denormalization is a longer write path, with consistency left to application code or triggers. So it belongs only on "read-heavy, write-light, aggregation is expensive" tables, and you must write out the maintenance logic for each redundant point explicitly.

## When to Normalize, When to Denormalize

- **Normalize by default**: design OLTP business tables at 3NF, keeping write paths short with consistency guaranteed by database constraints.
- **Denormalization is acceptable**: report summary tables, cache tables, snapshot fields — provided you know where the redundancy is and who maintains it.
- **Confirm the bottleneck first**: a slow JOIN often just means a missing index rather than a wrong table structure, so look at the execution plan before restructuring.

For the general definitions of the three normal forms, see [Database normalization - Wikipedia](https://en.wikipedia.org/wiki/Database_normalization); PostgreSQL-side constraint implementation is covered in [CHECK Constraints and Domains](./check-and-domains), and the overall flow from logical model to physical table structure is in [From Logical Model to Physical Table](./logical-to-physical-modeling).

## References

- [PostgreSQL Documentation · 5.5. Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
- [PostgreSQL Documentation · 5.12. Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Primary Key Design](./primary-key-design)
- [Foreign Keys and Referential Actions](./foreign-keys-and-referential-actions)
- [Materialized Views](./materialized-views)
- [Naming and Style Conventions](../basics/naming-and-style-conventions)
- [generated-columns-and-check](/advanced-sql/generated-columns-and-check.md)
- [anti-patterns](anti-patterns.md)
- [index](index.md)
- [materialized-views](materialized-views.md)
