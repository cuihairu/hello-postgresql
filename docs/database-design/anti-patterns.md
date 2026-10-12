# 反模式清单

这一页收录建表层最常见的反模式。它们的共同点是**不是语法错误，都能跑通上线**，要等数据量增长、并发上来或一次删除操作之后才暴露。每条给出症状、最小复现和修法，供 code review 与存量表体检时对照。

## EAV：实体-属性-值

把"属性"当数据存，而不是当列定义：

```sql
CREATE TABLE entity_attrs (
  entity_id  bigint NOT NULL,
  attr_name  text  NOT NULL,
  attr_value text              -- 一切属性都是文本
);

INSERT INTO entity_attrs VALUES (1, 'age', '30'), (2, 'age', '9');

-- 「查 age > 30 的实体」变成文本比较
SELECT entity_id FROM entity_attrs
WHERE attr_name = 'age' AND attr_value > '30';   -- 返回 1 和 2：'9' > '30' 按文本序为真
```

三重代价：**类型丢失**（年龄、金额、日期全成文本，比较与聚合都要靠 cast，cast 失败即整条查询报错）；**约束无处安放**（"某属性必填""取值限定枚举"在行级无法表达）；**查询与统计困难**（看一个实体的完整画像要 N 行透视，报表 SQL 复杂度爆炸）。修法：核心业务字段老老实实建列；真正动态的少量扩展属性用 JSONB 列加表达式索引。范式层面的讨论见 [三范式与反范式](./normalization-and-denormalization)。

## 万能 JSONB 表

EAV 的现代变体——把整张表塞进一个 JSONB 列：

```sql
CREATE TABLE data (
  id   bigint PRIMARY KEY,
  body jsonb NOT NULL          -- 订单、用户、配置、日志全进这一列
);
```

症状：没有 schema 就没有约束，键名拼错静默进库；查询全靠 `body->>'status'` 这类表达式，普通索引无从谈起；大 JSON 由 TOAST 管理，更新其中一个字段要重写整包。修法：关键实体用关系表建模，JSONB 只存真正半结构化的部分（第三方回执、不确定结构的配置）；常查的键提升为表达式索引或生成列。实践模式见 [JSONB 设计模式](../advanced-sql/jsonb-design-patterns) 与 [JSONB 操作](../advanced-sql/jsonb-operations)。

## 无界自关联

自引用外键本身没问题（评论楼中楼、组织架构树），问题出在**对深度没有任何约束**：

```sql
CREATE TABLE comments (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id bigint REFERENCES comments (id),
  body      text
);

WITH RECURSIVE t AS (
  SELECT id, parent_id, 1 AS depth FROM comments WHERE id = 1
  UNION ALL
  SELECT c.id, c.parent_id, t.depth + 1
  FROM comments c JOIN t ON c.parent_id = t.id
)
SELECT * FROM t;
```

数据出现环（A 的后代指向 A）或路径过深时，这条递归要么无限跑、要么产出天量行，一个接口查询拖垮整个库。修法：业务上限制层级并写入 CHECK 或应用校验；递归查询里给 `depth` 设上限，`UNION`（而非 `UNION ALL`）靠去重终止成环数据，PG 14 起还可用 `CYCLE` 子句显式处理，见 [递归 CTE](../advanced-sql/recursive-cte)。

## 外键无索引，父表高频删除

```sql
CREATE TABLE orders (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint REFERENCES users (id)     -- orders(user_id) 没建索引
);

DELETE FROM users WHERE id = 42;
```

删除一行父表时，PostgreSQL 必须确认子表没有残留引用；`orders(user_id)` 无索引，这次检查就是一次顺序扫描。父表删除越频繁、子表越大，删除越慢，还会在子表上堆积行锁。修法很固定：**子表外键列一律建索引**，这条也应写进建表规范，选型依据见 [复合索引设计](../indexing/composite-index-design)。

## 用 timestamp without time zone 存本地时间

最小复现：

```sql
SET timezone = 'Asia/Shanghai';
SELECT '2026-03-01 12:00:00'::timestamp;    -- 12:00（哪个时区的 12:00？）
SET timezone = 'America/New_York';
INSERT INTO events (at) SELECT '2026-03-01 12:00:00';   -- 又一个 12:00，相差 12 小时
```

两个写入方存出互相矛盾的值，夏令时切换日还会出现"不存在的时刻"。修法：一律 `timestamptz` 存绝对时刻、展示层做转换，坑与方案见 [时间建模](./time-modeling)。

## 用字符类型存金额

```sql
SELECT '9'::text > '10'::text;    -- true，字典序比较
```

`amount text` 的库里迟早出现 `'1,299.00'`、`'$99'`、带空格的 `' 12 '` 等各种格式：排序按字典序全乱，聚合先要 `::numeric` 且格式不齐即报错，精度约定无从谈起。修法：`numeric(12,2)` 或 bigint 存最小单位，取舍与舍入规则见 [金额与数值](./money-and-numeric)。

## 把 PostgreSQL 当队列用

用任务表加轮询实现消息队列，PG 9.5 起的 [`FOR UPDATE SKIP LOCKED`](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE) 让多 worker 抢任务互不阻塞：

```sql
SELECT id, payload FROM jobs
WHERE status = 'pending'
ORDER BY created_at
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

结论一句话：**小规模任务表这样用是可以的**，但把它当生产级消息队列会陆续撞上这些问题——轮询占用连接、消息可见性超时要自己造、死信与重试逻辑自己写、完成任务的墓碑行要定期清理。任务量大或可靠性要求高时换专业队列；任务表的批量写入与清理见 [批量写入](../advanced-sql/batch-and-write)。

## NULL 参与唯一约束

```sql
CREATE TABLE accounts (
  email      text NOT NULL,
  deleted_at timestamptz,
  UNIQUE (email, deleted_at)       -- 想防重复注册
);

INSERT INTO accounts (email) VALUES ('a@example.com');
INSERT INTO accounts (email) VALUES ('a@example.com');   -- 两次都成功
```

唯一约束中 NULL 互不相等，含可空列的组合唯一形同虚设；软删表几乎必然踩中（`deleted_at` 为 NULL 的存活行可无限重复）。修法：部分唯一索引 `WHERE deleted_at IS NULL`，或 PG 15 起 `UNIQUE NULLS NOT DISTINCT`，两种方案的副作用对比见 [软删除与墓碑](./soft-delete-and-tombstone)。

## 相关页面

- [三范式与反范式](./normalization-and-denormalization)
- [软删除与墓碑](./soft-delete-and-tombstone)
- [金额与数值](./money-and-numeric)
- [JSONB 设计模式](../advanced-sql/jsonb-design-patterns)
