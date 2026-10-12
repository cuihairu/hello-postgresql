# 集合运算

UNION、UNION ALL、INTERSECT、EXCEPT 把两条 SELECT 的结果按集合规则拼合：去重并、不去重并、交、差。它们与 JOIN 的分工是——JOIN 横向按列关联行，集合运算纵向按行叠放结果集，要求两边列数相同、对应位置类型兼容。这一页讲清语义、去重的成本，以及最容易出错的排序位置与 NULL 行为。

## 四种运算的语义

```sql
CREATE TABLE list_2025 (email text);
CREATE TABLE list_2026 (email text);

INSERT INTO list_2025 VALUES ('a@x.com'), ('b@x.com'), ('c@x.com'), (NULL);
INSERT INTO list_2026 VALUES ('b@x.com'), ('c@x.com'), ('d@x.com'), (NULL);
```

```sql
SELECT email FROM list_2025
UNION SELECT email FROM list_2026;      -- a、b、c、d、NULL：去重后 5 行

SELECT email FROM list_2025
UNION ALL SELECT email FROM list_2026;  -- 原样 8 行

SELECT email FROM list_2025
INTERSECT SELECT email FROM list_2026;  -- b、c、NULL

SELECT email FROM list_2025
EXCEPT SELECT email FROM list_2026;     -- a（NULL 两侧都有，被减掉）
```

速记：

- UNION：并集再去重；UNION ALL 不去重。
- INTERSECT：两侧都出现的值（去重后）。
- EXCEPT：在左侧、不在右侧的值（去重后）；`A EXCEPT B` 与 `B EXCEPT A` 一般不同。
- 三个运算都有对应的多重集合版本：`UNION ALL`、`INTERSECT ALL`、`EXCEPT ALL`（按重复计数做并/交/差），后两个很少用。

## ALL 与去重成本

不带 ALL 的 UNION、INTERSECT、EXCEPT 都要去重，执行计划里通常表现为 Sort + Unique 或 HashAggregate，内存、临时盘开销与输入规模成正比，排序版是 O(n log n)；UNION ALL 只做拼接，代价最小。

经验法则：

- 两侧本身无重复（如各自按主键过滤）或业务允许重复：直接 UNION ALL，需要唯一时在外层统一处理。
- 该去重的场景别为了省排序硬用 UNION ALL，重复行会污染下游统计。
- INTERSECT/EXCEPT 没有不去重的默认版本，参与运算前先在各自 SELECT 里把范围过滤小，别拿两张全量表求差。

## 列数与类型兼容

```sql
SELECT 1, 'a'
UNION
SELECT 2.5, 'b';      -- 正常：第 1 列按 numeric 统一

SELECT 1, 'a'
UNION
SELECT 'x', 2;        -- 报错：第 1 列 integer 与 text 无公共类型
```

规则：

- 两条 SELECT 的列数必须一致，按位置对齐，列名不参与匹配。
- 每一列的类型要能解析出公共类型，解析不了直接报错。
- 结果的列名取自第一条 SELECT，后续 SELECT 的列别名会被忽略。

## 优先级、括号与排序位置

- INTERSECT 的优先级高于 UNION 和 EXCEPT；UNION 与 EXCEPT 同级、从左往右结合，`A UNION B INTERSECT C` 等价于 `A UNION (B INTERSECT C)`。不依赖这个记忆，混合使用时一律加括号。
- ORDER BY、LIMIT 只能写在最后一个 SELECT 之后，作用于整体结果；写在中间是语法错误，写在某条 SELECT 内部的排序对最终结果无效。

EXCEPT 的结合顺序很容易踩坑，比如求「只在一侧出现的值」（对称差），必须给每个 EXCEPT 加括号：

```sql
(SELECT email FROM list_2025
 EXCEPT
 SELECT email FROM list_2026)
UNION ALL
(SELECT email FROM list_2026
 EXCEPT
 SELECT email FROM list_2025)
ORDER BY email;        -- a、d
```

不加括号时语句会按 `((A EXCEPT B) UNION ALL C) EXCEPT D` 解析，结果是另一回事。

## 用 EXCEPT 找差异行

EXCEPT 按整行比较，且把 NULL 视为彼此相等——与 DISTINCT、GROUP BY 一致，而不同于 WHERE 里的 `=`。这让它成为对比两张同构表的利器，例如数据迁移后校验新旧快照：

```sql
CREATE TABLE products_old (id int, name text, price numeric(10,2));
CREATE TABLE products_new (id int, name text, price numeric(10,2));

INSERT INTO products_old VALUES
    (1, '键盘', 199.00), (2, '鼠标', 99.00), (3, '显示器', 1299.00);
INSERT INTO products_new VALUES
    (1, '键盘', 219.00), (2, '鼠标', 99.00), (4, '桌垫', 39.00);
```

```sql
-- 新表多出或改动的行
SELECT * FROM products_new
EXCEPT
SELECT * FROM products_old;
-- (1, 键盘, 219.00)、(4, 桌垫, 39.00)

-- 旧表多出或被改掉的行
SELECT * FROM products_old
EXCEPT
SELECT * FROM products_new;
-- (1, 键盘, 199.00)、(3, 显示器, 1299.00)
```

解读方式：id=1 在两个方向都出现，说明它是「被改动的行」；只在单向出现的是纯新增或纯删除。就算 price 里混着 NULL，EXCEPT 也能整行对齐，而 `NOT IN` 和 `<>` 连接遇到 NULL 都会失手。

## 注意事项与常见坑

- 想给 UNION 的某一条 SELECT 单独排序再合并：做不到，排序只认最后一条 ORDER BY；需要分支内有序时，改成先各自包一层带序号的子查询。
- 结果列名来自第一条 SELECT：给第二条起的别名不生效，文档和代码里别引用它。
- 位置错位的类型「恰好兼容」不报错但语义错了（比如把 id 对到 amount 上），列顺序变化后要重新核对集合运算。
- 集合运算不去重的三个运算都是重操作，监控里见到大量 Sort/HashAggregate 时，优先检查是不是不必要的 UNION。

## 相关页面

- [递归 CTE](./recursive-cte)
- [聚合与 GROUP BY](../basics/aggregate-and-group-by)
- [条件表达式](./conditional-expressions)
- [EXPLAIN 基础](../performance/explain-basics)

官方文档：[组合查询（UNION、INTERSECT、EXCEPT）](https://www.postgresql.org/docs/current/queries-union.html)、[SELECT 语法](https://www.postgresql.org/docs/current/sql-select.html)。
