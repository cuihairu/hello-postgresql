# 实战案例

三个常见场景，每个给建表、问题写法、分析、改进写法，SQL 都可以直接拿去跑。共同主题：数据库的问题往往不在"能不能写"，而在"高并发下会不会错、慢了怎么办"。

## 案例一：订单列表的深分页

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

问题写法：列表翻到第 5001 页时。

```sql
SELECT id, user_id, amount FROM orders ORDER BY id OFFSET 100000 LIMIT 20;
```

分析：`OFFSET` 的含义是"先取再丢"。要把第 100001 行取出来，数据库仍要按 `id` 顺序扫过前 100020 行——索引只能确定排序顺序，无法让它"跳"到第 10 万行之后。前 10 万行的扫描成本随页数线性增长，而且这部分工作每次翻页都重复做。深页慢的根因是"用位移量表达位置"，而不是索引缺失。

改进：用**上一页的最后一个 id 作为锚点**，即 keyset 分页。

```sql
-- 首页：从 0 开始
SELECT id, user_id, amount FROM orders WHERE id > 0 ORDER BY id LIMIT 20;

-- 后续页：锚点是上一页结果的最后一行 id
SELECT id, user_id, amount FROM orders WHERE id > 100000 ORDER BY id LIMIT 20;
```

每页耗时与页数无关。两个注意点：

- 排序键必须能唯一确定位置，所以按主键 `id` 排序；改成按 `created_at` 排序要加唯一列作次要键，否则同一时刻的多行会互相覆盖、翻页重复；
- 这种分页只能"下一页"，用户想直接跳第 200 页时没有直接办法，常见折中是搜索框收窄范围，或对少数需求用 `OFFSET` 并给出性能提示。

## 案例二：库存扣减的幂等

```sql
CREATE TABLE products (
  id bigint PRIMARY KEY,
  name text NOT NULL,
  stock int NOT NULL CHECK (stock >= 0)
);
INSERT INTO products VALUES (1, 'widget', 10);

-- 请求去重表
CREATE TABLE order_requests (
  request_id uuid PRIMARY KEY,
  order_no text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

问题写法有两类。

```sql
-- 错法 1：无条件下扣，并发或重试时库存被扣成负数
UPDATE products SET stock = stock - 5 WHERE id = 1;

-- 错法 2：先查再扣，两次请求之间没有原子性保证
SELECT stock FROM products WHERE id = 1;   -- 看到 3
-- ... 应用层判断够用，然后 ...
UPDATE products SET stock = stock - 5 WHERE id = 1;   -- 两个并发都判断通过
```

分析：条件判断与更新分成两步时，判断的依据是**读时刻**的值，更新发生在**之后**，中间可能被其他事务改掉——这就是竞态。`SELECT stock FOR UPDATE` 加锁能解决，但把正确性寄托在"每个调用点都记得加锁"上，迟早有漏网之鱼。重试场景同样危险：网关超时重试让同一订单请求进来两次。

改进：把"能不能扣"写进 `WHERE`，让数据库一次判断一次更新。

```sql
-- 条件更新：库存足够才扣，返回 0 行表示库存不足
UPDATE products
   SET stock = stock - 5
 WHERE id = 1 AND stock >= 5
 RETURNING stock;

-- 防重复请求：request_id 唯一 + ON CONFLICT DO NOTHING
INSERT INTO order_requests (request_id, order_no)
VALUES ('a1b2c3d4-0000-4000-8000-000000000001', 'SO-20261012')
ON CONFLICT (request_id) DO NOTHING
RETURNING request_id;
```

两者在**同一个事务**里，顺序是先防重再扣减：

```sql
BEGIN;
INSERT INTO order_requests (request_id, order_no) VALUES ($1, $2)
  ON CONFLICT (request_id) DO NOTHING RETURNING request_id;  -- 返回 0 行：重复请求，直接按成功回给上游
UPDATE products SET stock = stock - $3 WHERE id = $4 AND stock >= $3;   -- 返回 0 行：库存不足，返回库存错误
COMMIT;
```

应用层判断更新返回的行数即可，不需要 `SELECT` 先读。**应用参数化占位符**（见[客户端驱动](/zh/tools/client-drivers)），别让扣减量从字符串拼进 SQL。`CHECK (stock >= 0)` 是最后一道防线，即使有漏网的错误写法也不会把库存写成负数。

## 案例三：高频活动计数器

```sql
-- 明细追加表
CREATE TABLE page_views_raw (
  page_id int NOT NULL,
  viewed_at timestamptz NOT NULL DEFAULT now()
);

-- 按分钟聚合表
CREATE TABLE page_view_minutes (
  bucket timestamp NOT NULL,
  page_id int NOT NULL,
  cnt bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, page_id)
);
```

问题写法：每次 PV 更新一行累计计数。

```sql
UPDATE page_views SET cnt = cnt + 1 WHERE page_id = 42;
```

分析：这是典型的**热行**——上万请求全部争抢同一行的行锁，在数据库里表现为一条排着队等锁的链条，吞吐被压到串行水平。更隐蔽的后果是每个请求都写入一行新版本，产生同样的 WAL 量和死元组量，vacuum 的回收压力随之上升，详见[vacuum 与死元组](/zh/internals/vacuum-and-hot)。

改进：把"累加到一行"改成"按分钟分桶插入"。

```sql
-- 写入路径：冲突时累加，同一分钟内仍是单行，但每分钟滚动一次
INSERT INTO page_view_minutes (bucket, page_id, cnt)
VALUES (date_trunc('minute', now()), 42, 1)
ON CONFLICT (bucket, page_id) DO UPDATE SET cnt = page_view_minutes.cnt + 1;

-- 读取路径：按时间范围聚合
SELECT date_trunc('minute', viewed_at) AS bucket, count(*) AS pv
FROM page_views_raw
WHERE viewed_at >= now() - interval '1 hour'
GROUP BY 1 ORDER BY 1;
```

冲突窗口从"整页生命周期"缩小到"一分钟"，写入并发能力显著提升；`(bucket, page_id)` 复合主键让 upsert 命中同一行索引，代价是一行一 WAL 记录，因此桶粒度不能太细（秒级桶会把冲突省下来的写入开销又还回去）。

再往下是定时聚合：用调度任务把分钟表汇总进日表或总表，明细表按月分区便于归档删除。

另一个极端是**只追加不更新**：PV 全部 `INSERT` 进 `page_views_raw`，写放大最小、完全没有锁冲突，但每次展示都要 `GROUP BY` 聚合；读多写少、要求低延迟的场景再用聚合表兜住。近似去重计数（如独立访客数）可以引入 HLL 类扩展用概率数据结构估算，牺牲精度换取常数空间。

## 参考资料

- [PostgreSQL 官方文档 · psql](https://www.postgresql.org/docs/current/app-psql.html)
- [PostgreSQL 官方文档 · F.32. pg_stat_statements — track statistics of SQL planning and execution](https://www.postgresql.org/docs/current/pgstatstatements.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [批量写入](/zh/advanced-sql/batch-and-write)
- [复合索引设计](/zh/indexing/composite-index-design)
- [vacuum 与死元组](/zh/internals/vacuum-and-hot)
- [CRUD 与 ON CONFLICT](/zh/basics/crud-and-on-conflict)
- [index](/zh/tools/index)
官方文档：[INSERT 命令](https://www.postgresql.org/docs/current/sql-insert.html)、[UPDATE 命令](https://www.postgresql.org/docs/current/sql-update.html)。
