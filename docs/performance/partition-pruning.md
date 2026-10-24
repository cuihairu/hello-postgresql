# Partition Pruning

For a partitioned table to be fast, the planner or executor must be able to drop partitions that cannot contain the target data from the plan—this is "partition pruning". When pruning does not happen, the query degrades to scanning every partition with an Append, and performance can be worse than not partitioning at all. This page records the three moments pruning can happen, which writing styles defeat it, and how to confirm from EXPLAIN output whether pruning occurred.

## The Three Moments of Pruning

The official documentation splits pruning into three phases; understanding them is the basis for debugging pruning failures:

1. **Planning**: the partition key condition already has a definite value when the plan is generated (a constant, an expression evaluable at plan time). Pruned partitions do not appear in the plan at all.
2. **Executor initialization**: the condition value is only determined when execution starts—prepared statement parameters, subquery outputs, and so on. They are dropped once during initialization; pruned partitions no longer appear in the plan, and the count dropped shows as `Subplans Removed`.
3. **Execution**: values change as execution proceeds—the inner side of a parameterized nested loop join, execution-time parameters that vary per row. Pruning repeats on every parameter change.

```sql
CREATE TABLE measurements (
  taken_at  timestamptz NOT NULL,
  device_id int NOT NULL,
  value     numeric
) PARTITION BY RANGE (taken_at);

CREATE TABLE measurements_2026_09
  PARTITION OF measurements
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE measurements_2026_10
  PARTITION OF measurements
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
-- ...more monthly partitions

-- pruning at plan time: only measurements_2026_09 is in the plan,
-- the other partitions do not appear at all
EXPLAIN SELECT * FROM measurements
WHERE taken_at = '2026-09-15 12:00:00+08';
```

## Observing Execution-Time Pruning

Initialization and execution pruning only happen at run time, so you need `EXPLAIN ANALYZE` (`EXPLAIN EXECUTE` for prepared statements):

```sql
PREPARE q(timestamptz) AS
  SELECT * FROM measurements WHERE taken_at = $1;

EXPLAIN ANALYZE EXECUTE q('2026-09-15 12:00:00+08');
```

```plaintext
Append  (actual rows=5)
  ->  Seq Scan on measurements_2026_09 (actual rows=5)
  ->  Seq Scan on measurements_2026_10 (never executed)
  Subplans Removed: 1
```

- `Subplans Removed: N`: N subplans were dropped at initialization;
- `(never executed)`: this subplan was pruned on every parameter change and never ran once—the signature of execution-time pruning;
- You can also gauge execution-time pruning by the `loops` of each subplan: repeatedly pruned partitions have a loops count far below the number of times the outer side drives them.

Note: `EXPLAIN` without ANALYZE cannot see execution-time pruning; the plan still lists every partition. That does not mean pruning failed—you only know after executing once.

## Common Shapes of Pruning Failure

```sql
-- 1. An expression wraps the partition key: the condition is no longer "partition key compared to a constant"
EXPLAIN SELECT * FROM measurements
WHERE date(taken_at) = date '2026-09-15';
-- rewriting as a range comparison restores pruning:
EXPLAIN SELECT * FROM measurements
WHERE taken_at >= '2026-09-15 00:00:00+08'
  AND taken_at <  '2026-09-16 00:00:00+08';

-- 2. A cross-partition OR: one side carries no partition key condition, so the whole OR cannot be proven partition-independent
EXPLAIN SELECT * FROM measurements
WHERE taken_at >= '2026-09-01' OR device_id = 42;
-- split it into a UNION so the branch with the partition key prunes on its own

-- 3. An operation performed on the partition key
EXPLAIN SELECT * FROM measurements
WHERE taken_at + interval '8 hours' > now();
-- move the arithmetic to the constant side: taken_at > now() - interval '8 hours'
```

What these shapes have in common: pruning requires proof that "this partition cannot contain a matching row", and any writing that prevents the condition from being compared directly against partition boundaries breaks that proof.

## Prepared Statements and Generic Plans

After a prepared statement executes several times it may switch to a generic plan (decision rules in [Plan Cache and Generic Plans](../internals/plan-cache-and-generic-plan)). Impact on pruning:

- A generic plan carries no concrete parameter values, so plan-time pruning fails and the plan tree keeps every partition;
- Pruning is deferred to executor initialization (`Subplans Removed` will show it), the result is still correct and partitions are not really scanned, but every execution pays the cost of initializing and pruning a large plan tree;
- With hundreds of partitions and a light single query, that share becomes obvious, showing up as a prepared statement being slower than plain SQL.

Workarounds: make critical queries use a custom plan (usually automatic when parameter distributions differ widely), or build the constant dynamically with `EXECUTE` in PL/pgSQL to force plan-time pruning on every call.

## Partition Key Design Principles

- Choose a column every frequent query carries (usually a time column); making a column a partition key that never appears in a query is partitioning for nothing.
- Match partition granularity to "how many partitions a single query touches": a daily-partitioned table running a year-spanning report scans hundreds of partitions, and planning time itself becomes the cost.
- Pruning only honors conditions that "compare the partition key directly against a constant"; decide the WHERE shape of your mainline queries up front.
- Align partition boundaries with business semantics (natural months, natural days) so "look up a time range" translates cleanly into half-open interval comparisons.

## The Difference from constraint_exclusion

`constraint_exclusion` is the older mechanism, from the era of **inherited tables** (CHECK constraints hand-built to simulate partitioning); declarative partitioning (`PARTITION BY`) has its own dedicated pruning mechanism and does not rely on it. The default value `partition` means the declarative pruning path is enabled only for partitioned tables; you only need to set it to `on` if you are still using inherited tables. It works only at plan time, cannot recognize partition boundaries, and can only validate CHECK constraints—slow and narrow in coverage. Use declarative partitioning directly for new projects; see [Table Inheritance and Partitioning Design](../database-design/table-inheritance-and-partitioning-design).

## References

- [PostgreSQL Official Documentation · 5.12. Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html#DDL-PARTITIONING-PRUNING)
- [PostgreSQL Official Documentation · 14.1. Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [constraints-and-data-quality](/database-design/constraints-and-data-quality.md)
- [multi-tenant-modeling](/database-design/multi-tenant-modeling.md)
- [table-inheritance-and-partitioning-design](/database-design/table-inheritance-and-partitioning-design.md)
- [timescaledb](/ecosystem/timescaledb.md)
- [brin](/indexing/brin.md)
- [knowledge](/knowledge.md)
- [capacity-and-scaling-limits](capacity-and-scaling-limits.md)
- [index](index.md)- [EXPLAIN Basics](./explain-basics)——understanding Append and plan structure.
- [EXPLAIN ANALYZE and Buffers](./explain-analyze-buffers)——quantifying how much each partition actually scanned.
- [Plan Cache and Generic Plans](../internals/plan-cache-and-generic-plan)——generic plan decisions and switching.
- [Table Inheritance and Partitioning Design](../database-design/table-inheritance-and-partitioning-design)——design decisions for partition keys and granularity.

Official docs: <https://www.postgresql.org/docs/current/ddl-partitioning.html#DDL-PARTITIONING-PRUNING>
