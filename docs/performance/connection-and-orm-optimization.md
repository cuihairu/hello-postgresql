# 连接与 ORM 优化

很多「数据库慢」的问题在 SQL 本身之前就发生了：ORM 把一条查询拆成几百条、连接数超过 CPU 核数、事务横跨整个 HTTP 请求、逐行 INSERT 打满 WAL。这一页从应用侧看数据库性能：N+1 的识别与批量化、ORM 常见坑、参数绑定与 prepared statement、连接池大小、事务边界与批量写入。

## N+1 的识别与批量化

N+1 是 ORM 场景的头号性能问题：取 1 次列表，再对列表里每个对象各查 1 次关联数据。识别手段很直接——打开 ORM 的 SQL 日志数条数：

```plaintext
# Django 调试日志，列表页 100 个用户打了 101 条 SQL
SELECT * FROM users LIMIT 100;
SELECT * FROM profiles WHERE user_id = 1;
SELECT * FROM profiles WHERE user_id = 2;
...
```

批量化有三条路，按场景选：

```sql
-- 方式 1：IN 列表一次取回，应用侧按 id 组装
SELECT * FROM profiles WHERE user_id = ANY ($1);   -- 绑定整型数组 {1,2,...,100}

-- 方式 2：JOIN 一次带出（ORM 里的 select_related / includes / eager loading）
SELECT u.*, p.bio
FROM users u LEFT JOIN profiles p ON p.user_id = u.user_id;

-- 方式 3：关联数据要「每行前 N 条」时用 LATERAL，避免全量 JOIN 后再过滤
SELECT u.user_id, r.order_id, r.amount
FROM users u
LEFT JOIN LATERAL (
    SELECT order_id, amount
    FROM orders o
    WHERE o.user_id = u.user_id
    ORDER BY created_at DESC
    LIMIT 3
) r ON true;
```

LATERAL 写法能让优化器为每个用户走一次「按 user_id 定位 + 取前 3 条」的索引扫描，比先 JOIN 全部订单再窗口函数过滤省一个数量级，语法细节见 [LATERAL 与 FROM 子查询](../advanced-sql/lateral-and-from-subquery)。

## ORM 常见坑

四个高频坑，都能从 SQL 日志里看出来：

- **懒加载层层触发**：对象图深一层，查询翻一倍。策略是显式声明预加载（eager load），只在读路径懒加载。
- **SELECT \***：ORM 默认拉全列，宽表 + TOAST 大字段时单次查询翻几倍。列表接口用 `only()`/`select` 指定列；大字段独立成表或懒取，见 [TOAST](../internals/toast)。
- **无 LIMIT 的 count**：分页组件默认 `count(*)` 全表，千万行表一次几秒。能估算就 `EXPLAIN` 估算行数、能缓存就缓存、能改 keyset 分页就别要精确总数，分页方案见 [分页与排序](../advanced-sql/pagination-and-sorting)。
- **对象逐条 save**：循环里 1000 次 UPDATE 每次一个事务。合并为批量操作（见下文「批量写」）。

另有一个隐蔽坑：ORM 生成的参数类型与列类型不一致（比如字符串绑给整型列），轻则索引走不了，重则触发隐式转换。在日志里看绑定的实际值和类型，对照列定义。

## prepared statement 与参数绑定

应用侧一律用参数绑定，不要拼接 SQL：既杜绝注入，也让语句结构稳定、可被服务端缓存计划：

```sql
-- 服务端 prepared statement（驱动通常自动完成扩展协议的 Parse/Bind）
PREPARE get_user_orders(bigint, text) AS
SELECT order_id, amount, created_at
FROM orders
WHERE user_id = $1 AND status = $2
ORDER BY created_at DESC
LIMIT 20;

EXECUTE get_user_orders(40021, 'paid');
```

要点：

- 驱动通过扩展协议发送参数，PostgreSQL 按实际类型做比较，不存在字符串拼接的类型漂移。
- 服务端会缓存执行计划：前 5 次执行按真实参数生成 custom plan，之后可能切换为 generic plan。极端分布场景下 generic plan 变慢，可用 `SET plan_cache_mode = force_custom_plan;` 兜底，机制见 [计划缓存与通用计划](../internals/plan-cache-and-generic-plan)。
- 连接池的事务级复用（如 PgBouncer transaction pooling 模式）与有状态 prepared statement 有兼容边界，选池模式时先确认驱动行为，见 [连接管理](../operations/connection-management)。

## 连接池参数

PostgreSQL 每个连接是一个进程，连接数过多时调度和上下文切换的开销会吃掉并发收益。起步公式：

```plaintext
池大小 ≈ CPU 核数 × 2（再按存储能力微调，机械盘可 + 磁盘轴数）
```

16 核机器从 32 个活跃连接起步，压测后再调，不要按「应用实例数 × 框架默认 10」算——那通常几百起步，只会更慢。配套检查：

```sql
-- 看连接都在干什么：active 多还是 idle 多
SELECT state, count(*) FROM pg_stat_activity GROUP BY state ORDER BY 2 DESC;
```

- `idle` 大量堆积 → 应用没有归还连接，池没起到复用作用；
- `active` 长期 ≈ 池上限、排队严重 → 数据库已到并发瓶颈，先优化慢查询再考虑加连接；
- 90% 以上的请求等 1 个慢 SQL，加连接只是把排队从应用搬到数据库。

池架在应用侧还是独立网关（PgBouncer/内置池化）、池模式怎么选，见 [连接管理](../operations/connection-management)；单机容量边界见 [容量与扩展边界](./capacity-and-scaling-limits)。

## 事务边界不要太长

事务持有锁并阻碍 VACUUM 清理（见 [VACUUM 与 HOT](../internals/vacuum-and-hot)），长事务是并发退化和表膨胀的共同源头。两条纪律：

- **事务内不做外部交互**：不发 HTTP、不调 RPC、不等用户输入。取数、计算、写库三段式里，只有读写库的两小段放在事务里。
- **给空闲事务设上限**：连接泄漏或死循环会留下 `idle in transaction` 的连接，一键兜底：

```sql
-- postgresql.conf 或按会话设置
SET idle_in_transaction_session_timeout = '30s';
SET statement_timeout = '60s';   -- 单语句上限，防止慢查询长期占连接
```

排查现场用 `pg_stat_activity` 找 `state = 'idle in transaction'` 的连接及其 `xact_start`，配合 [锁与并发瓶颈](./lock-and-concurrency-bottlenecks) 处理热点行。

## 批量写：executemany 与 COPY

逐行提交是写吞吐的大敌：每条语句一次网络往返、一次解析、一次事务日志。按数据量升级写法：

```sql
-- 1 千行级：多值 INSERT，一条语句一次提交
INSERT INTO metrics (tag, value, taken_at)
VALUES ('cpu', 0.72, now()), ('cpu', 0.81, now()), ('cpu', 0.77, now());

-- 1 万行级以上：驱动批量 API 或 COPY
COPY metrics (tag, value, taken_at) FROM STDIN WITH (FORMAT csv);
```

驱动侧对应关系：JDBC 打开 `rewriteBatchedInserts=true` 让 `addBatch` 落成多值 INSERT；psycopg3 的 `executemany` 内置管道模式（一次网络往返批量执行）；任何语言下 COPY 都是灌数据的速度上限，`psycopg.copy`、`pgx.CopyFrom` 都有现成接口。批量写本身的事务粒度、fsync 权衡见 [批量写入](../advanced-sql/batch-and-write) 与 [写入吞吐优化](./write-throughput-optimization)。

## 注意事项与常见坑

- 批量化之前先确认瓶颈真在往返次数：单条本来就跑 2 秒的 SQL，批量化救不了它，先走 [慢查询治理流程](./slow-query-governance)。
- ORM 的 `bulk_create`/`insert_all` 通常跳过 ORM 钩子和默认值校验，行为差异要在测试里确认。
- 连接池不是越大越好：超过 CPU 核数两倍的活跃连接只会增加争用，排队（少量等待）比全并发更稳。
- `ANY ($1)` 数组绑定的元素类型要与列类型一致，否则可能走不了索引。
- COPY 与多值 INSERT 都会撑大单条 WAL，超大批次拆成 1-5 万行一段，给复制与 checkpoint 留缓冲。
- 事务里嵌套大量 SAVEPOINT 的 ORM 行为（如 Django 原子块嵌套）在连接池 transaction 模式下可能失效，上线前验证。

## 相关页面

- [慢查询治理流程](./slow-query-governance)
- [批量写入](../advanced-sql/batch-and-write)
- [连接管理](../operations/connection-management)
- [计划缓存与通用计划](../internals/plan-cache-and-generic-plan)

官方文档：[COPY](https://www.postgresql.org/docs/current/sql-copy.html)、[查询规划配置](https://www.postgresql.org/docs/current/runtime-config-query.html)。
