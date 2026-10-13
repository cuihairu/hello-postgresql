# 表继承与分区表设计

把一张逻辑大表拆成多块物理存储，PostgreSQL 提供两条路：表继承（INHERITS）和声明式分区（`PARTITION BY`）。PG 10 起官方推荐声明式分区——分区是父表的组成部分，路由、约束、索引都由系统管理；表继承是更早的机制，子表是完全独立的表，需要应用层自己拼。这一页以声明式分区为主，讲三种分区方式、默认分区、分区键对主键的限制、数量与大小建议，最后对比两者的差异。

## PARTITION BY RANGE / LIST / HASH

```sql
-- RANGE 按时间分区：订单按月归档，最常见的形态（声明式分区 PG 10 起）
CREATE TABLE orders (
    order_id   bigint GENERATED ALWAYS AS IDENTITY,
    user_id    bigint NOT NULL,
    amount     numeric(12,2) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (order_id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE orders_2026_09 PARTITION OF orders
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE orders_2026_10 PARTITION OF orders
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE orders_2026_11 PARTITION OF orders
    FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');

INSERT INTO orders (user_id, amount, created_at)
VALUES (1, 99.00, '2026-10-12 10:00+08');   -- 自动路由进 orders_2026_10

-- 查父表会自动扫描命中的分区；也能确认每行落在哪个分区
SELECT tableoid::regclass AS partition, count(*) FROM orders GROUP BY 1;
```

三种分区方式按分区键的形态选：

| 方式 | 分区键 | 适用 |
|---|---|---|
| `RANGE` | 可比较的范围值（时间、数值） | 时间归档、按 ID 段切分 |
| `LIST` | 离散枚举值（地区、租户） | 按 region/tenant 隔离 |
| `HASH` | 任意列（内部取哈希） | 数据分布均匀、无明显范围语义 |

```sql
-- LIST：多租户按租户 id 隔离
CREATE TABLE events (
    id        bigint GENERATED ALWAYS AS IDENTITY,
    tenant_id int NOT NULL,
    payload   jsonb,
    PRIMARY KEY (id, tenant_id)
) PARTITION BY LIST (tenant_id);

CREATE TABLE events_t1 PARTITION OF events FOR VALUES IN (1);
CREATE TABLE events_t2 PARTITION OF events FOR VALUES IN (2);

-- HASH：日志表按 id 打散到 4 个分区
CREATE TABLE logs (
    id  bigint GENERATED ALWAYS AS IDENTITY,
    msg text,
    PRIMARY KEY (id)
) PARTITION BY HASH (id);

CREATE TABLE logs_p0 PARTITION OF logs FOR VALUES WITH (MODULUS 4, REMAINDER 0);
CREATE TABLE logs_p1 PARTITION OF logs FOR VALUES WITH (MODULUS 4, REMAINDER 1);
```

## 默认分区

默认分区（PG 11 起）兜住所有不匹配已有分区的写入，避免「路由失败直接报错」：

```sql
CREATE TABLE orders_default PARTITION OF orders DEFAULT;

INSERT INTO orders (user_id, amount, created_at)
VALUES (1, 1.00, '2027-01-05 00:00+08');   -- 没有对应分区，落进 default

SELECT count(*) FROM orders_default;
--  count
-- -------
--      1
```

默认分区是双刃剑：它挡住了插入报错，但里面长期堆积数据说明分区维护没跟上——尤其要注意，default 分区存在时给表挂新分区，PG 必须扫描 default 确认没有越界行，这一步会锁表。稳妥流程是提前把未来的分区建好，default 只作兜底。

## 主键与唯一约束必须包含分区键

分区表的**所有**主键和唯一约束（包括唯一索引）都必须包含全部分区键，否则直接报错：

```sql
-- 错误示范：主键不含分区键
CREATE TABLE bad_orders (
    order_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at timestamptz NOT NULL
) PARTITION BY RANGE (created_at);
-- ERROR: unique constraint on partitioned table must include all partitioning columns

-- 正确：主键带上分区键，成为复合键
CREATE TABLE orders (
    order_id   bigint GENERATED ALWAYS AS IDENTITY,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (order_id, created_at)
) PARTITION BY RANGE (created_at);
```

原因：每个分区各自持有独立索引，PG 无法跨分区保证全局唯一，除非唯一性判断本身落在同一个分区内。这是分区设计里最常被「事后发现」的限制——业务上要求 `order_id` 全局唯一时，全局唯一只能由应用层或序列保证，数据库约束退化为 `(order_id, created_at)` 内的唯一。

## 分区数量与单分区大小建议

- **分区数量**：几十到几百为宜。每个查询都要做分区剪枝、打开分区元数据，几千个分区时规划开销明显可见，锁管理也变重。
- **单分区大小**：按增长速度定粒度，经验值是单分区留在 GB 级。太细会分区爆炸，太粗则失去归档和剪枝的意义。
- **删老数据用 DETACH/DROP，不用 DELETE**：`DETACH PARTITION` 是元数据操作，瞬间完成且不产生死元组（PG 14 起还支持 `DETACH PARTITION … CONCURRENTLY` 不阻塞查询）。
- **分区键不可原地更新**：UPDATE 分区键意味着行要跨分区移动，PG 不支持，只能 DELETE + INSERT；选分区键时要选「写定后不变」的列。

```sql
-- 提前建好下月分区，新数据自然路由进去
CREATE TABLE orders_2026_12 PARTITION OF orders
    FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

-- 归档：老分区摘下来后可改名、导出、转移到冷存储
ALTER TABLE orders DETACH PARTITION orders_2026_09;
```

## 与表继承的区别

| 维度 | 声明式分区（PG 10+） | 表继承（INHERITS） |
|---|---|---|
| 子表定位 | 父表的组成部分，路由对应用透明 | 完全独立的表，只是「声明了列的来源」 |
| 约束与索引 | 父表上定义，自动落到每个分区 | 子表各自定义；父表不自动继承子表约束 |
| 主键/唯一 | 全分区统一，必须含分区键 | 每个子表独立，无跨子表保证 |
| 写入路由 | INSERT 自动路由 | 应用层自己决定写哪张子表 |
| 读路径 | 父表查询自动剪枝 | 依赖 CHECK 约束做约束排除（constraint exclusion） |
| 删数据 | DETACH/DROP 瞬间完成 | 逐子表 DROP |

表继承的查询优化依赖子表上的 CHECK 约束和 `constraint_exclusion` 配置，使用门槛高、容易漏；除非维护有历史包袱的老系统，新系统没有理由用它替代声明式分区。两者语法细节见官方文档 [声明式分区](https://www.postgresql.org/docs/current/ddl-partitioning.html) 与 [表继承](https://www.postgresql.org/docs/current/tutorial-inheritance.html)。

## 参考资料

- [PostgreSQL 官方文档 · 5.12. Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)
- [PostgreSQL 官方文档 · 5.5. Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- 子树总纲：[第2部分：数据库设计](/database-design/)

- [主键设计](./primary-key-design)
- [多租户建模](./multi-tenant-modeling)
- [分区裁剪](../performance/partition-pruning)
- [时间建模](./time-modeling)
- [batch-and-write](/advanced-sql/batch-and-write.md)
- [index](index.md)
- [multi-tenant-modeling](multi-tenant-modeling.md)
- [citus](/ecosystem/citus.md)
- [timescaledb](/ecosystem/timescaledb.md)
- [brin](/indexing/brin.md)
- [composite-index-design](/indexing/composite-index-design.md)
- [capacity-and-scaling-limits](/performance/capacity-and-scaling-limits.md)
- [partition-pruning](/performance/partition-pruning.md)