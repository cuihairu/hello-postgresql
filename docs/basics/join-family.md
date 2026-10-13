# JOIN 全家族

JOIN 按关联条件把两张表的行拼在一起，家族成员按「匹配不上的行去留」区分：INNER 只保留两边都匹配的行，LEFT/RIGHT/FULL 分别额外保留左表、右表、两表中未匹配的行（缺失一侧填 NULL），CROSS 则不做匹配、直接输出所有组合。这一页用员工-部门示例演示每种 JOIN，并重点讲两个实际高频的错误模式。

## 示例表

```sql
CREATE TABLE departments (
    dept_id int PRIMARY KEY,
    name    text NOT NULL
);

CREATE TABLE employees (
    id         int PRIMARY KEY,
    name       text NOT NULL,
    dept_id    int REFERENCES departments(dept_id),
    manager_id int REFERENCES employees(id)
);

INSERT INTO departments VALUES (1, '研发'), (2, '销售'), (3, '人事');

INSERT INTO employees VALUES
    (1, '张总', 1, NULL),
    (2, '小李', 1, 1),
    (3, '小王', 1, 2),
    (4, '小赵', 2, 1),
    (5, '小钱', NULL, 1);   -- 未分配部门
```

数据里埋了两个「不匹配」来源：员工小钱没有部门，部门「人事」没有员工。

## INNER / LEFT / RIGHT / FULL

```sql
-- INNER：只有 4 名有部门的员工，小钱和人事部门都不出现
SELECT e.name AS employee, d.name AS dept
FROM employees e
JOIN departments d ON e.dept_id = d.dept_id;

-- LEFT：左表全保留，小钱的 dept 为 NULL（共 5 行）
SELECT e.name AS employee, d.name AS dept
FROM employees e
LEFT JOIN departments d ON e.dept_id = d.dept_id;

-- RIGHT：右表全保留，人事部门的 employee 为 NULL
SELECT e.name AS employee, d.name AS dept
FROM employees e
RIGHT JOIN departments d ON e.dept_id = d.dept_id;

-- FULL：两边未匹配的都保留
SELECT e.name AS employee, d.name AS dept
FROM employees e
FULL JOIN departments d ON e.dept_id = d.dept_id;
```

`LEFT JOIN ... WHERE 右表.键 IS NULL` 是常用的反连接写法，用来找「没有任何匹配」的行，比如找出没有员工的部门：

```sql
SELECT d.name
FROM departments d
LEFT JOIN employees e ON e.dept_id = d.dept_id
WHERE e.id IS NULL;      -- 人事
```

实践建议：日常建模统一用 LEFT/INNER（RIGHT JOIN 总能改写成调换表顺序的 LEFT JOIN，团队里混用两种方向的可读性差）。

## CROSS JOIN

不写 ON，输出两张表的笛卡尔积（M x N 行）。合法用途是生成组合，比如「每个门店 x 每个月份」的骨架表再 LEFT JOIN 实际数据；行数是相乘关系，大表上慎用。

```sql
SELECT d.name AS dept, e.name AS employee
FROM departments d CROSS JOIN employees e;   -- 3 x 5 = 15 行
```

## USING 与 NATURAL

两表的关联列同名时，`USING` 比 `ON` 简洁，且输出里只保留一列：

```sql
SELECT e.name AS employee, d.name AS dept, dept_id
FROM employees e JOIN departments d USING (dept_id);
```

对比 `ON` 写法，`dept_id` 在结果里只出现一次；`USING` 里声明的列不能再加表名前缀引用。它要求 JOIN 两侧存在同名同类型的列，否则报 `column referenced in USING clause not found in any FROM item`。

`NATURAL JOIN` 是 `USING` 的全自动版：把两表所有同名列都当成关联条件。危险在于给表加一个同名列（如 `updated_at`）之后，JOIN 语义就悄悄变了。生产代码里显式写出关联条件比依赖巧合的同名可靠。

## 自连接：员工-经理表

同一张表和自己 JOIN，靠别名区分两个角色。employees 的 `manager_id` 指向同表 `id`，查「每人及其经理」：

```sql
SELECT e.name AS employee, m.name AS manager
FROM employees e
LEFT JOIN employees m ON e.manager_id = m.id
ORDER BY e.id;

-- employee | manager
-- 张总     | NULL（没有上级，LEFT JOIN 保住这行）
-- 小李     | 张总
-- 小王     | 小李
```

这里必须用 LEFT JOIN：用 INNER 会把没有经理的员工（张总）整行丢掉。递归地查整条汇报链则要用递归 CTE，见 [递归 CTE](../advanced-sql/recursive-cte)。

## JOIN + 聚合的常见错误

**错误一：把右表条件写在 WHERE 里，LEFT JOIN 退化成 INNER JOIN。** 对 LEFT JOIN 的右表过滤，条件放在 `ON` 还是 `WHERE`，结果完全不同：

```sql
-- 错误：WHERE 作用在 JOIN 结果上，小钱（dept 为 NULL）被过滤掉
SELECT e.name, d.name AS dept
FROM employees e
LEFT JOIN departments d ON e.dept_id = d.dept_id
WHERE d.name = '研发';

-- 正确：条件写进 ON，右表不匹配的行保留为 NULL
SELECT e.name, d.name AS dept
FROM employees e
LEFT JOIN departments d
  ON e.dept_id = d.dept_id AND d.name = '研发';
```

「先过滤再 join」要表达的就是把条件放进 ON 或子查询里；写进 WHERE 就是「join 再过滤」，LEFT 语义随之消失。

**错误二：一对多 JOIN 后直接聚合，计数/求和被撑大。** 部门表 LEFT JOIN 员工表是一对多，`count(*)` 会把「没有员工的部门」错算成 1 行：

```sql
-- 错误：人事显示 count = 1（来自 NULL 填充行）
SELECT d.name, count(*) AS headcount
FROM departments d
LEFT JOIN employees e ON e.dept_id = d.dept_id
GROUP BY d.name;

-- 正确：对左表的列计数，未匹配行计数为 0
SELECT d.name, count(e.id) AS headcount
FROM departments d
LEFT JOIN employees e ON e.dept_id = d.dept_id
GROUP BY d.name;
```

同样的放大效应也出现在求和上：订单表 JOIN 订单明细表后 `sum(订单金额)` 会按明细行数重复累加，正确做法是先在子查询里按订单聚合，再 JOIN。规律一句话：**一对多 JOIN 之后，凡对「一」侧的列做 count/sum 都要先聚合再 JOIN**。

## JOIN 顺序与优化器

SQL 里 JOIN 的书写顺序（除外连接外）不决定执行顺序，优化器会基于统计信息重排内连接顺序、选择 Nested Loop / Hash Join / Merge Join 等实现。调优时先看执行计划而不是机械调整表顺序，见 [JOIN 实现方式](../internals/join-implementations) 与 [EXPLAIN 读法](../performance/explain-basics)。

## 注意事项与常见坑

- 多表 JOIN 后出现 `column reference is ambiguous`：同名列没有加表名前缀，输出列一律加限定。
- `FULL JOIN` 两侧都可能产生 NULL 填充行，输出键常用 `coalesce(a.key, b.key)` 归一。
- 外连接会限制优化器重排的自由度，多层外连接的计划变差时，检查是否真的需要 OUTER。
- LEFT JOIN 的行数可能比左表多（一对多），拿它做去重假设前先 `EXPLAIN` 确认。

## 参考资料

- [PostgreSQL 官方文档 · Part I. Tutorial](https://www.postgresql.org/docs/current/tutorial.html)
- [PostgreSQL 官方文档 · The SQL Language](https://www.postgresql.org/docs/current/sql.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [聚合与 GROUP BY](./aggregate-and-group-by)
- [JOIN 实现方式](../internals/join-implementations)
- [外键与引用动作](../database-design/foreign-keys-and-referential-actions)
- [LATERAL 与 FROM 子查询](../advanced-sql/lateral-and-from-subquery)
- [subquery-family](/advanced-sql/subquery-family.md)
- [aggregate-and-group-by](aggregate-and-group-by.md)
- [index](index.md)
官方文档：[连接查询教程](https://www.postgresql.org/docs/current/tutorial-join.html)、[FROM 与 JOIN 完整语法](https://www.postgresql.org/docs/current/queries-table-expressions.html)。
