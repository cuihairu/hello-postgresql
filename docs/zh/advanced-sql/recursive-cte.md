# 递归 CTE

WITH RECURSIVE 让一个 CTE 引用自己，用普通 SQL 表达「重复迭代直到没有新行」的过程：组织架构树、物料清单、目录树、图上的可达性都属此类。PostgreSQL 实际用迭代而非真递归求值：先执行 anchor 部分得到起点行，之后每轮拿上一轮产出的新行作为工作表跑一遍递归部分，直到某轮不再产出新行。

## 两段式结构

```sql
WITH RECURSIVE t AS (
    -- anchor：非递归部分，产出起点行
    SELECT ...
    UNION ALL
    -- recursive：引用 t 自身，基于上一轮的新行继续产出
    SELECT ... FROM t JOIN ...
)
SELECT * FROM t;
```

要点：

- 必须写 `RECURSIVE` 关键字，即使语句并不真正递归。
- anchor 与递归部分用 UNION 或 UNION ALL 连接。
- 递归部分对 CTE 自身只能引用一次，引用两次会报错。
- 每轮迭代只把上一轮的新行代入递归部分，不是拿全部已产出行重算。

## 组织架构树：自上而下遍历

```sql
CREATE TABLE emp_tree (
    id         int PRIMARY KEY,
    name       text NOT NULL,
    manager_id int REFERENCES emp_tree(id)
);

INSERT INTO emp_tree VALUES
    (1, '张总',   NULL),
    (2, '李副总', 1),
    (3, '王经理', 2),
    (4, '赵主管', 3),
    (5, '钱工',   3),
    (6, '孙经理', 2);
```

```sql
WITH RECURSIVE org AS (
    SELECT id, name, manager_id, 1 AS depth
    FROM emp_tree
    WHERE manager_id IS NULL              -- anchor：从根开始

    UNION ALL

    SELECT e.id, e.name, e.manager_id, o.depth + 1
    FROM emp_tree e
    JOIN org o ON e.manager_id = o.id     -- recursive：找上一层的直接下属
)
SELECT repeat('    ', depth - 1) || name AS org_chart, depth
FROM org
ORDER BY depth, id;
```

输出：

```plaintext
张总
    李副总
        王经理
        孙经理
            赵主管
            钱工
```

## 路径累积与深度限制

在输出列里加一个 `depth` 计数和一个 `path` 路径列，既能展示层级路径，也能用来截断遍历：

```sql
WITH RECURSIVE org AS (
    SELECT id, name, 1 AS depth, name::text AS path
    FROM emp_tree
    WHERE manager_id IS NULL
    UNION ALL
    SELECT e.id, e.name, o.depth + 1, o.path || ' / ' || e.name
    FROM emp_tree e
    JOIN org o ON e.manager_id = o.id
    WHERE o.depth < 2                     -- 只向下展开两层
)
SELECT depth, path FROM org ORDER BY path;
```

- 深度限制写在递归部分的 WHERE 里，判断依据是上一行的 `o.depth`，不是当前行。
- PostgreSQL 对递归 CTE 没有内置的迭代次数上限：数据成环又没有防护时，语句不会自己停。

## UNION 与 UNION ALL：去重即终止

构造一个带环的图：

```sql
CREATE TABLE graph_edge (src int, dst int);
INSERT INTO graph_edge VALUES (1, 2), (2, 3), (3, 1);   -- 1→2→3→1 成环
```

用 UNION 连接的递归 CTE 能自己终止：整行完全相同的行会被去重，环走回来时不再产生新行，迭代结束。

```sql
WITH RECURSIVE walk AS (
    SELECT src, dst FROM graph_edge WHERE src = 1
    UNION
    SELECT w.src, e.dst
    FROM graph_edge e JOIN walk w ON e.src = w.dst
)
SELECT * FROM walk ORDER BY dst;      -- 4 行：1→2、1→3、2→3、3→1
```

换成 UNION ALL 就会死循环，每轮把相同的行再产一遍。反过来，一旦 SELECT 里带了逐层加一的 depth 列，每轮的行都不相同，UNION 的去重也失效，照样死循环——这时需要 visited 集合或 CYCLE 子句。去重的完整语义见 [集合运算](/zh/advanced-sql/set-operations)。

## 图遍历：visited 集合

把已访问节点存进数组，递归部分只扩展没走过的节点。这样 UNION ALL 也能安全终止，且能保留 depth：

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

从 1 出发可达 2、3，再经 3→1 回到起点自身，随后无处可去，共 3 行。数组相关操作详见 [数组操作](/zh/advanced-sql/array-operations)。

## CYCLE 子句（PG 14 起）

PG 14 起内置了环检测，不用手写 visited 数组：

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

- `CYCLE dst` 按 dst 列检测重复；`SET is_cycle` 指定布尔标记列；`USING visited` 让系统自动维护已访问路径数组列。
- 命中环的那行照常输出但 `is_cycle = true`，并且不再从它继续展开，UNION ALL 因此安全终止。
- 结果列在 UNION 两侧的列之外自动多出 `is_cycle` 与 `visited` 两列，注意别在两侧 SELECT 里重复声明它们。

上面的查询会得到 4 行：依次到达 2、3、1，第 4 行再次到达 2 时标记 `is_cycle = true`，迭代停止。

## 注意事项与常见坑

- 死循环三要素自查：UNION ALL + 成环数据 + 无 visited/CYCLE 防护。调试期可以临时在主查询加 LIMIT 让行产出「够用即停」，但这只是止血，正式语句必须有确定终止条件。
- UNION 去重要排序或哈希，大数据量时明显慢于 UNION ALL；能用 visited/CYCLE 精确控制时优先 UNION ALL。
- 递归部分引用 CTE 只能一次；需要和别的表多次关联时，把对 CTE 的引用收敛在一个 JOIN 里。
- 树数据里 `manager_id = id` 的自环同样会成环，CYCLE 与 visited 都能正常拦住，别只防「长环」。
- anchor 部分忘了过滤（如不写 `WHERE manager_id IS NULL`）会让每个节点都成为起点，行数指数膨胀。

## 参考资料

- [PostgreSQL 官方文档 · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL 官方文档 · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [CTE 与非递归 WITH](/zh/advanced-sql/cte-and-non-recursive-with)
- [集合运算](/zh/advanced-sql/set-operations)
- [外键与引用动作](/zh/database-design/foreign-keys-and-referential-actions)
- [数组操作](/zh/advanced-sql/array-operations)
- [cte-and-non-recursive-with](/zh/advanced-sql/cte-and-non-recursive-with)
- [index](/zh/advanced-sql/index)
- [set-operations](/zh/advanced-sql/set-operations)
- [join-family](/zh/basics/join-family)
- [anti-patterns](/zh/database-design/anti-patterns)
官方文档：[WITH RECURSIVE 与 CYCLE 子句](https://www.postgresql.org/docs/current/queries-with.html)。
