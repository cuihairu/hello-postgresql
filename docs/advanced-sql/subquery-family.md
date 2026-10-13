# 子查询家族

子查询是嵌在另一条 SQL 里的 SELECT，按出现位置分成两大类：写在 WHERE/SELECT 表达式里的（标量、IN、EXISTS、ANY/ALL）和写在 FROM 里的（派生表）。写法上层层嵌套，但优化器并不总是「先算内层再算外层」——多数子查询会被改写成 join 或一次性求值的计划。这一页过一遍家族成员，讲清 IN 与 EXISTS 的 NULL 语义差异、哪些形态能被优化器展平、哪些去不掉，以及怎么用 EXPLAIN 验证。

## 示例表

```sql
CREATE TABLE departments (
    dept_id int PRIMARY KEY,
    name    text NOT NULL
);

CREATE TABLE employees (
    id      int PRIMARY KEY,
    name    text NOT NULL,
    dept_id int REFERENCES departments(dept_id),
    salary  numeric(10,2) NOT NULL
);

INSERT INTO departments VALUES (1, '研发'), (2, '销售'), (3, '人事');

INSERT INTO employees VALUES
    (1, '张总', 1, 30000),
    (2, '小李', 1, 20000),
    (3, '小王', 1, 18000),
    (4, '小赵', 2, 15000),
    (5, '小钱', 2, 12000),
    (6, '小孙', NULL, 9000);   -- 没有部门的员工，专门演示 NULL 语义
```

## 标量子查询：只允许一个值

标量子查询出现在表达式位置，必须最多返回一行一列：结果为空时整个表达式取 NULL，多于一行直接报错 `more than one row returned by a subquery used as an expression`。

```sql
-- 全公司平均工资（不关联外层，整条查询只算一次）
SELECT name, salary,
       round(salary / (SELECT avg(salary) FROM employees), 2) AS ratio
FROM employees;

-- 工资高于全公司平均的员工
SELECT name, salary
FROM employees
WHERE salary > (SELECT avg(salary) FROM employees);
```

「最多一行」要靠子查询自身的语义保证：聚合函数天然只返回一行；普通查询则要靠唯一性条件或 LIMIT 1 兜底，否则数据一多就会从偶发问题变成线上故障。

## IN 与 EXISTS：NULL 是分水岭

IN 把子查询结果当作值列表逐个比对，EXISTS 只关心子查询是否返回至少一行（SELECT 列表不影响结果，惯用 `SELECT 1`）：

```sql
-- IN：等值列表比对，返回「研发」「销售」；子查询里的 NULL 不影响正向 IN
SELECT name FROM departments
WHERE dept_id IN (SELECT dept_id FROM employees);

-- EXISTS：逐行探测存在性，结果相同
SELECT name FROM departments d
WHERE EXISTS (SELECT 1 FROM employees e WHERE e.dept_id = d.dept_id);
```

正向查询里 IN 与 EXISTS 语义等价，NULL 顶多导致「匹配不上」；分水岭在否定形式。`x NOT IN (列表)` 等价于「x 与列表中每一个值都不相等」的 AND——只要列表里有一个 NULL，`x <> NULL` 是 unknown，整个 AND 永远不为真，查询返回空集：

```sql
-- 本意是「没有员工的部门」，实际返回 0 行：子查询结果里有 NULL（小孙）
SELECT name FROM departments
WHERE dept_id NOT IN (SELECT dept_id FROM employees);

-- NOT EXISTS 不受 NULL 影响，正确返回「人事」
SELECT name FROM departments d
WHERE NOT EXISTS (SELECT 1 FROM employees e WHERE e.dept_id = d.dept_id);
```

结论：否定存在性判断一律写 NOT EXISTS。`<> ALL (subquery)` 与 NOT IN 语义相同，同样有这个坑。

## ANY / ALL / SOME

ANY（SOME 是它的同义词）表示「与列表中任意一个比较为真」，ALL 表示「与列表中每一个比较都为真」：

```sql
-- 高于销售部（dept_id=2）任意一人 = 高于其最低工资 12000 → 4 行
SELECT name, salary FROM employees
WHERE salary > ANY (SELECT salary FROM employees WHERE dept_id = 2);

-- 高于销售部所有人 = 高于其最高工资 15000 → 3 行
SELECT name, salary FROM employees
WHERE salary > ALL (SELECT salary FROM employees WHERE dept_id = 2);
```

`= ANY (ARRAY[1, 3, 5])` 这种数组形式常用来替代长 OR 列表，与 IN 等价。三值逻辑在这里同样生效：`> ALL` 的列表里混入 NULL 后，结果只可能是 false 或 NULL，永远取不到 true；`<> ALL` 就是 NOT IN 的坑。列表可能含 NULL 时，先在子查询里 `WHERE col IS NOT NULL` 过滤。

## 关联子查询

引用了外层列的子查询叫关联子查询，概念上外层每一行都要执行一次。经典用途是「组内最值」：

```sql
-- 每个部门工资最高的员工
SELECT e.name, e.dept_id, e.salary
FROM employees e
WHERE e.salary = (SELECT max(salary) FROM employees e2
                  WHERE e2.dept_id = e.dept_id)
ORDER BY e.dept_id;
```

小孙的 dept_id 是 NULL，子查询里 `e2.dept_id = NULL` 永远匹配不上，他不会出现在结果里——这是三值逻辑的又一次显形，如果业务上需要统计无部门员工，要显式单独处理。

## 派生表：FROM 里的子查询

```sql
-- 平均工资高于全公司平均的部门
SELECT d.name, s.avg_salary
FROM departments d
JOIN (SELECT dept_id, avg(salary) AS avg_salary
      FROM employees
      GROUP BY dept_id) s ON s.dept_id = d.dept_id
WHERE s.avg_salary > (SELECT avg(salary) FROM employees);
```

习惯上给派生表起个短别名（PG 16 起别名可以省略，但显式写出可读性更好）。「先聚合再 JOIN」的写法也顺带规避了「一对多 JOIN 后计数被撑大」的问题。带 LATERAL 的派生表还能引用左侧的列，见 [LATERAL 与 FROM 子查询](./lateral-and-from-subquery)。

## 优化器怎么处理子查询

写法是嵌套的，执行未必。优化器主要做两类改写：

- **展平（pull-up）**：不引用外层的子查询、以及能安全合并的派生表，会被合并进外层查询，最终计划与手写 join 完全一样。
- **去相关化（subquery unlinking）**：把 EXISTS/IN 转换成 Semi Join、NOT EXISTS 转换成 Anti Join；对无法改写的关联标量子查询，生成 SubPlan 节点逐行执行，等值关联时会用哈希缓存参数来减少重复计算。

这套能力从 PG 8.x 起逐步增强（8.4 引入 semi-join/anti-join 实现，此后可转换的形态不断扩大），「子查询一定比手写 JOIN 慢」在现代版本里基本是过时经验，先看计划再下结论。

去不掉的形态，通常是因为改写会改变语义：

- **LIMIT / OFFSET**：「前 N 行」没有等价的 join 形式，子查询保持原样。
- **volatile 函数或带副作用的调用**（`random()`、`nextval()`、声明为 VOLATILE 的函数）：必须按行真实求值，不能提前算、也不能缓存。
- **COUNT 等聚合的关联子查询**：转成 join 会改变行数，只能作为 SubPlan 逐行执行，大表上容易退化成「每行一次扫描」。
- **出现在 OR 分支里的 IN/EXISTS**：进不了 join 树，退回 SubPlan 形式（不关联时会用 hashed SubPlan 缓存结果）。
- **NOT IN 且子查询列可能为 NULL**：转不了 anti-join（anti-join 的 NULL 语义与 NOT IN 不同），既慢又坑，改写成 NOT EXISTS。

## 用 EXPLAIN 验证是否被展平

[EXPLAIN 读法](../performance/explain-basics)里最实用的判断之一：看计划里有没有 InitPlan / SubPlan 节点。

EXISTS 被转成 semi-join 后是平铺的 join，没有 SubPlan：

```plaintext
EXPLAIN SELECT name FROM departments d
WHERE EXISTS (SELECT 1 FROM employees e WHERE e.dept_id = d.dept_id);

            QUERY PLAN
-----------------------------------
 Hash Semi Join
   Hash Cond: (d.dept_id = e.dept_id)
   ->  Seq Scan on departments d
   ->  Hash
         ->  Seq Scan on employees e
```

不关联的标量子查询则变成 InitPlan，形如 `InitPlan 1 (returns $0)`，整条查询只算一次，外层的 `Filter: (salary > $0)` 以参数引用其结果。

LIMIT 挡住了改写，标量子查询保持 SubPlan，外层每行执行一次：

```plaintext
EXPLAIN SELECT d.name,
       (SELECT e.name FROM employees e
        WHERE e.dept_id = d.dept_id
        ORDER BY e.salary DESC LIMIT 1) AS top_earner
FROM departments d;

        QUERY PLAN
---------------------------
 Seq Scan on departments d
   SubPlan 1
     ->  Limit
           ->  Sort
                 Sort Key: e.salary DESC
                 ->  Seq Scan on employees e
                       Filter: (dept_id = d.dept_id)
```

判读规则：`InitPlan` = 一次性计算，不用担心；`SubPlan` = 逐行（或按参数缓存）执行，外层行数多时优先想办法改写成 join；两者都没有、只见 Semi/Anti/普通 join = 已被展平。改写前后用 `EXPLAIN ANALYZE` 对比实际耗时，见 [EXPLAIN ANALYZE 与 BUFFERS](../performance/explain-analyze-buffers)。

## 注意事项与常见坑

- 标量子查询返回多行报错：改用聚合、加唯一条件或 LIMIT 1，不要赌数据量。
- NOT IN 遇上可空列 = 空结果陷阱，统一写 NOT EXISTS。
- 子查询里的 ORDER BY 不带 LIMIT 没有意义（排序结果会被丢弃，还白耗 CPU）；顺序要去外层写。
- 关联子查询出现在 OR 分支或聚合函数里时，去相关化经常失效；复杂查询先 EXPLAIN 确认形态。
- CTE 从 PG 12 起默认会被内联展平（行为与派生表一致），需要优化屏障时加 MATERIALIZED，见 [CTE 与非递归 WITH](./cte-and-non-recursive-with)。

## 参考资料

- [PostgreSQL 官方文档 · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL 官方文档 · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- 子树总纲：[第3部分：高级 SQL](/advanced-sql/)

- [EXPLAIN 读法](../performance/explain-basics)
- [LATERAL 与 FROM 子查询](./lateral-and-from-subquery)
- [CTE 与非递归 WITH](./cte-and-non-recursive-with)
- [JOIN 全家族](../basics/join-family)
- [cte-and-non-recursive-with](cte-and-non-recursive-with.md)
- [index](index.md)
- [lateral-and-from-subquery](lateral-and-from-subquery.md)
- [common-beginner-mistakes](/basics/common-beginner-mistakes.md)
官方文档：[子查询表达式](https://www.postgresql.org/docs/current/sql-expressions.html)、[子查询教程](https://www.postgresql.org/docs/current/sql-expressions.html)。
