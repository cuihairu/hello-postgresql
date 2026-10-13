# 三范式与反范式

范式化（Normalization）是关系库设计的起点：通过拆表消除冗余依赖，让每一份事实只在一个地方写入，其余地方靠外键引用。这一页依次过一遍 1NF/2NF/3NF，各给一个从坏到好的改写示例，看冗余如何制造更新异常，最后讨论什么时候可以故意反范式化。

## 1NF：字段原子性

1NF 要求字段值不可再分——不能是逗号分隔的列表、数组或 JSON 文档。最常见的坏味道是把多个值塞进一个字段：

```sql
-- 坏：items 是逗号分隔的商品串，一份订单只能存一行
CREATE TABLE orders_bad (
    order_id int PRIMARY KEY,
    customer text NOT NULL,
    items    text NOT NULL,          -- 形如 "笔记本,鼠标,键盘"
    total    numeric(10,2) NOT NULL
);

INSERT INTO orders_bad VALUES (1, '张三', '笔记本,鼠标,键盘', 8000.00);

-- 好：一个商品一行，字段天然原子
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

INSERT INTO orders VALUES (1, '张三', 8000.00, now());
INSERT INTO order_items VALUES
    (1, 101, 1, 5000.00),
    (1, 102, 1, 300.00),
    (1, 103, 1, 2700.00);
```

拆表之后「各商品卖了多少份」可以直接 `GROUP BY product_id` 回答；坏表里想统计销量得先切割字符串，既没法建索引，也没法对单个商品加约束。

## 2NF：消除部分依赖

2NF 针对复合主键：非主键字段必须依赖整个主键，不能只依赖主键的一部分。

```sql
-- 坏：主键是 (purchase_id, product_id)，
-- 但 product_name、unit_price 只依赖 product_id，属于部分依赖
CREATE TABLE purchases_bad (
    purchase_id  int,
    product_id   int,
    product_name text NOT NULL,
    unit_price   numeric(10,2) NOT NULL,
    quantity     int NOT NULL,
    PRIMARY KEY (purchase_id, product_id)
);

INSERT INTO purchases_bad VALUES (1, 101, '笔记本', 5000.00, 10);
INSERT INTO purchases_bad VALUES (2, 101, '笔记本', 5000.00, 5);

-- 好：商品信息抽到 products，明细只留「哪次进货、哪个商品、多少份」
CREATE TABLE products (
    product_id   int PRIMARY KEY,
    product_name text NOT NULL,
    unit_price   numeric(10,2) NOT NULL
);

INSERT INTO products VALUES (101, '笔记本', 5000.00);

CREATE TABLE purchase_items (
    purchase_id int,
    product_id  int REFERENCES products(product_id),
    quantity    int NOT NULL CHECK (quantity > 0),
    PRIMARY KEY (purchase_id, product_id)
);

INSERT INTO purchase_items VALUES (1, 101, 10), (2, 101, 5);
```

部分依赖的代价：同一商品在每条明细里重复存一份名称和价格，既浪费空间，又留下「两个入口都能改价格」的不一致风险。

## 3NF：消除传递依赖

3NF 要求非主键字段之间不能再有依赖：不能通过「另一个非主键字段」间接决定某列。

```sql
-- 坏：dept_name、dept_manager 通过 dept_id 传递依赖于 employee_id
CREATE TABLE employees_bad (
    employee_id   int PRIMARY KEY,
    employee_name text NOT NULL,
    dept_id       int NOT NULL,
    dept_name     text NOT NULL,
    dept_manager  text NOT NULL
);

INSERT INTO employees_bad VALUES (1, '李四', 5, '研发部', '王五');

-- 好：部门信息只在 departments 里出现一次
CREATE TABLE departments (
    dept_id      int PRIMARY KEY,
    dept_name    text NOT NULL,
    dept_manager text NOT NULL
);

INSERT INTO departments VALUES (5, '研发部', '王五');

CREATE TABLE employees (
    employee_id   int PRIMARY KEY,
    employee_name text NOT NULL,
    dept_id       int REFERENCES departments(dept_id)
);

INSERT INTO employees VALUES (1, '李四', 5);
```

## 冗余如何导致更新异常

上面三张坏表病根相同：一份事实被复制到多处。由此产生三类异常：

```sql
-- 更新异常：部门改名要改所有相关员工行，漏一行就出现两个部门名
UPDATE employees_bad SET dept_name = '研发中心' WHERE dept_name = '研发部';
```

- **更新异常**：同一事实多处存放，修改必须处处同步，漏改即不一致。
- **插入异常**：新部门还没有员工时，部门信息在员工表里无处可放（没有对应行可插）。
- **删除异常**：删掉某部门最后一个员工，部门信息跟着蒸发。

范式化让每个事实只有一个写入点：部门名只在 `departments` 表里存一次，改一次就够。

## 反范式的两种常见形态

范式化不是终点。当 JOIN 成本成为瓶颈时，可以有控制地引入冗余：

**冗余汇总表**：把聚合结果提前算好落盘，报表直接查它，不再扫明细。

```sql
CREATE TABLE daily_sales (
    stat_date    date PRIMARY KEY,
    order_count  int NOT NULL,
    total_amount numeric(12,2) NOT NULL
);

-- 定时任务回填昨天的汇总，重复执行也安全（UPSERT）
INSERT INTO daily_sales (stat_date, order_count, total_amount)
SELECT o.created_at::date, COUNT(*), SUM(o.total)
FROM orders o
WHERE o.created_at::date = CURRENT_DATE - 1
GROUP BY 1
ON CONFLICT (stat_date) DO UPDATE
    SET order_count  = EXCLUDED.order_count,
        total_amount = EXCLUDED.total_amount;
```

**宽表**：把一张实体的多个展示维度拉平到一行，查询时不必 JOIN 多张表。数仓宽表偏 OLAP 设计；OLTP 里更常见的是「冗余快照字段」——比如订单明细里存下单时刻的商品名和成交价，因为商品会改名调价，订单必须记住成交那一刻的值。

反范式的代价是写入路径变长、一致性要靠应用代码或触发器兜底。所以它一般只用于「读多写少、聚合很贵」的表，而且要显式写出冗余点的维护逻辑。

## 何时范式化，何时反范式

- **默认范式化**：OLTP 业务表按 3NF 设计，写入路径短，一致性由数据库约束保证。
- **允许反范式**：报表汇总表、缓存表、快照字段；前提是你清楚冗余点在哪、由谁维护。
- **先确认瓶颈**：很多时候 JOIN 慢只是缺索引，不是表结构设计错了，先看执行计划再动手。

三范式的通用定义可参考 [Database normalization - Wikipedia](https://en.wikipedia.org/wiki/Database_normalization)；PostgreSQL 侧的约束落地见 [CHECK 与域类型](./check-and-domains)，从逻辑模型到物理表结构的整体流程见 [逻辑模型到物理模型](./logical-to-physical-modeling)。

## 参考资料

- [PostgreSQL 官方文档 · 5.5. Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
- [PostgreSQL 官方文档 · 5.12. Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [主键设计](./primary-key-design)
- [外键与引用动作](./foreign-keys-and-referential-actions)
- [物化视图](./materialized-views)
- [命名与风格约定](../basics/naming-and-style-conventions)
- [generated-columns-and-check](/advanced-sql/generated-columns-and-check.md)
- [anti-patterns](anti-patterns.md)
- [index](index.md)
- [materialized-views](materialized-views.md)