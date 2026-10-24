# Recursive CTEs

WITH RECURSIVE lets a CTE refer to itself, expressing the process of "iterate repeatedly until no new rows are produced" in ordinary SQL: organizational hierarchy trees, bills of materials, directory trees, and reachability over a graph all fall into this category. PostgreSQL actually evaluates with iteration rather than true recursion: it first runs the anchor part to get the starting rows, then in each round feeds the new rows produced by the previous round as the working table into the recursive part, until some round produces no new rows.

## The Two-Part Structure

```sql
WITH RECURSIVE t AS (
    -- anchor: the non-recursive part, producing the starting rows
    SELECT ...
    UNION ALL
    -- recursive: refers to t itself, continuing to produce rows from the previous round's new rows
    SELECT ... FROM t JOIN ...
)
SELECT * FROM t;
```

Essentials:

- You must write the `RECURSIVE` keyword, even when the statement is not truly recursive.
- The anchor and the recursive part are joined with UNION or UNION ALL.
- The recursive part may refer to the CTE itself only once; referring to it twice is an error.
- Each iteration round substitutes only the new rows from the previous round into the recursive part, not a recomputation over all rows produced so far.

## Organizational Hierarchy: Top-Down Traversal

```sql
CREATE TABLE emp_tree (
    id         int PRIMARY KEY,
    name       text NOT NULL,
    manager_id int REFERENCES emp_tree(id)
);

INSERT INTO emp_tree VALUES
    (1, 'GM Zhang',      NULL),
    (2, 'VP Li',         1),
    (3, 'Mgr Wang',      2),
    (4, 'Supervisor Zhao', 3),
    (5, 'Eng Qian',      3),
    (6, 'Mgr Sun',       2);
```

```sql
WITH RECURSIVE org AS (
    SELECT id, name, manager_id, 1 AS depth
    FROM emp_tree
    WHERE manager_id IS NULL              -- anchor: start from the root

    UNION ALL

    SELECT e.id, e.name, e.manager_id, o.depth + 1
    FROM emp_tree e
    JOIN org o ON e.manager_id = o.id     -- recursive: find the direct reports of the level above
)
SELECT repeat('    ', depth - 1) || name AS org_chart, depth
FROM org
ORDER BY depth, id;
```

Output:

```plaintext
GM Zhang
    VP Li
        Mgr Wang
        Mgr Sun
            Supervisor Zhao
            Eng Qian
```

## Path Accumulation and Depth Limits

Add a `depth` counter and a `path` column to the output columns, and you can both display the hierarchical path and use it to cut off the traversal:

```sql
WITH RECURSIVE org AS (
    SELECT id, name, 1 AS depth, name::text AS path
    FROM emp_tree
    WHERE manager_id IS NULL
    UNION ALL
    SELECT e.id, e.name, o.depth + 1, o.path || ' / ' || e.name
    FROM emp_tree e
    JOIN org o ON e.manager_id = o.id
    WHERE o.depth < 2                     -- expand only two levels down
)
SELECT depth, path FROM org ORDER BY path;
```

- Write the depth limit in the WHERE of the recursive part; the value you test against is the previous row's `o.depth`, not the current row's.
- PostgreSQL has no built-in iteration-count cap for recursive CTEs: when the data contains a cycle and there is no guard, the statement will not stop on its own.

## UNION vs UNION ALL: Deduplication as Termination

Build a graph with a cycle:

```sql
CREATE TABLE graph_edge (src int, dst int);
INSERT INTO graph_edge VALUES (1, 2), (2, 3), (3, 1);   -- 1->2->3->1 forms a cycle
```

A recursive CTE joined with UNION can terminate on its own: rows that are completely identical across all columns are deduplicated, so when the cycle comes around there are no new rows to produce and the iteration ends.

```sql
WITH RECURSIVE walk AS (
    SELECT src, dst FROM graph_edge WHERE src = 1
    UNION
    SELECT w.src, e.dst
    FROM graph_edge e JOIN walk w ON e.src = w.dst
)
SELECT * FROM walk ORDER BY dst;      -- 4 rows: 1->2, 1->3, 2->3, 3->1
```

Switch to UNION ALL and it loops forever, reproducing the same rows in every round. Conversely, once your SELECT carries a depth column that increments per level, every round's rows differ, so UNION's deduplication no longer applies and it still loops forever — at that point you need a visited set or the CYCLE clause. For the full semantics of deduplication, see [Set Operations](./set-operations).

## Graph Traversal: a Visited Set

Store already-visited nodes in an array, and have the recursive part expand only nodes not yet visited. This makes UNION ALL safe to terminate as well, and you keep depth:

```sql
WITH RECURSIVE walk AS (
    SELECT src, dst, ARRAY[]::int[] AS visited, 0 AS depth
    FROM graph_edge
    WHERE src = 1
    UNION ALL
    SELECT w.src, e.dst, w.visited || e.dst, w.depth + 1
    FROM walk w
    JOIN graph_edge e ON e.src = w.dst
    WHERE NOT e.dst = ANY(w.visited)
)
SELECT dst, depth, visited FROM walk ORDER BY depth;
```

Starting from 1 you can reach 2 and 3, then go back to the start itself via 3->1, after which there is nowhere to go — 3 rows in total. For array operations in general, see [Array Operations](./array-operations).

## The CYCLE Clause (PG 14+)

From PG 14, cycle detection is built in, so you do not have to hand-roll a visited array:

```sql
WITH RECURSIVE walk AS (
    SELECT src, dst, 1 AS depth
    FROM graph_edge
    WHERE src = 1
    UNION ALL
    SELECT w.src, e.dst, w.depth + 1
    FROM graph_edge e
    JOIN walk w ON e.src = w.dst
)
CYCLE dst SET is_cycle USING visited
SELECT src, dst, depth, is_cycle FROM walk ORDER BY depth;
```

- `CYCLE dst` detects duplicates on the dst column; `SET is_cycle` names the boolean marker column; `USING visited` lets the system maintain the visited-path array column automatically.
- The row that hits a cycle is still output normally but with `is_cycle = true`, and traversal no longer continues from it, so UNION ALL terminates safely.
- The result set automatically gains two columns, `is_cycle` and `visited`, on top of the columns in the SELECT on either side of the UNION; take care not to redeclare them in either SELECT.

The query above yields 4 rows: it reaches 2, 3, and 1 in turn, and on the 4th row arriving at 2 again it is marked `is_cycle = true`, so the iteration stops.

## Caveats and Common Traps

- Self-check for the three ingredients of an infinite loop: UNION ALL + cyclic data + no visited/CYCLE guard. During debugging you can temporarily add a LIMIT to the main query so row production "stops once enough," but that is only a stopgap — a production statement must have a definite termination condition.
- UNION deduplication requires sorting or hashing, so it is noticeably slower than UNION ALL at large data volumes; when you can control termination precisely with visited/CYCLE, prefer UNION ALL.
- The recursive part may refer to the CTE only once; when you need to join it with other tables multiple times, consolidate the references to the CTE into a single JOIN.
- A self-loop with `manager_id = id` in tree data is also a cycle; CYCLE and visited both catch it correctly, so do not guard only against "long cycles."
- Forgetting to filter the anchor part (for example, omitting `WHERE manager_id IS NULL`) makes every node a starting point and blows up the row count exponentially.

## References

- [PostgreSQL official documentation · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL official documentation · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [CTEs and Non-Recursive WITH](./cte-and-non-recursive-with)
- [Set Operations](./set-operations)
- [Foreign Keys and Referential Actions](../database-design/foreign-keys-and-referential-actions)
- [Array Operations](./array-operations)
- [cte-and-non-recursive-with](cte-and-non-recursive-with.md)
- [index](index.md)
- [set-operations](set-operations.md)
- [join-family](/basics/join-family.md)
- [anti-patterns](/database-design/anti-patterns.md)
Official documentation: [WITH RECURSIVE and the CYCLE clause](https://www.postgresql.org/docs/current/queries-with.html).
