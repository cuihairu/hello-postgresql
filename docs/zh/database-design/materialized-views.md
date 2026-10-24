# 物化视图

物化视图（Materialized View）与普通视图的本质区别：它把查询结果**真实存下来**，像一张表一样可以建索引、被统计；代价是数据只是刷新时刻的快照，必须手动（或定时）刷新。这里整理两种刷新方式的差别、并发刷新的前提条件、刷新策略与增量思路，以及适合用它的场景。

## 本质区别：实体化，需要刷新

```sql
CREATE TABLE orders (
    order_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    amount     numeric(12,2) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO orders (amount, created_at) VALUES
    (100.00, now() - interval '2 days'),
    (200.00, now() - interval '2 days'),
    (50.00,  now() - interval '1 day');

-- 普通视图：不存数据，每次查询实时聚合
-- 物化视图：把结果落盘成快照
CREATE MATERIALIZED VIEW mv_daily_summary AS
SELECT created_at::date            AS stat_date,
       count(*)                    AS order_count,
       sum(amount)                 AS total_amount
FROM orders
GROUP BY 1
WITH DATA;

SELECT * FROM mv_daily_summary ORDER BY stat_date;

-- 之后新订单不会出现在快照里，直到下一次 REFRESH
INSERT INTO orders (amount) VALUES (99.00);
SELECT order_count FROM mv_daily_summary;   -- 仍是 3
```

`WITH NO DATA` 可以先建空壳（常用于初始化时装载），默认 `WITH DATA` 建完即填充。语法见官方文档 [CREATE MATERIALIZED VIEW](https://www.postgresql.org/docs/current/sql-creatematerializedview.html)。

## 全量刷新 vs CONCURRENTLY

```sql
-- 全量：重跑底层查询、整体替换，刷新期间拿排他锁，读写全部阻塞
REFRESH MATERIALIZED VIEW mv_daily_summary;

-- 并发：先在后台生成新数据，最后原子替换，刷新期间不阻塞读
CREATE UNIQUE INDEX mv_daily_summary_pk
    ON mv_daily_summary (stat_date);          -- 前提：唯一索引

REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_summary;
```

`CONCURRENTLY` 的硬性要求（官方文档 [REFRESH MATERIALIZED VIEW](https://www.postgresql.org/docs/current/sql-refreshmaterializedview.html)）：

- 物化视图上至少有一个唯一索引（不能带 WHERE 谓词，列不得含 NULL）；
- 不能在事务块内执行，`BEGIN; REFRESH … CONCURRENTLY; COMMIT;` 会报错；
- 刷新期间普通查询不受影响，但开头和结尾会有短暂加锁，高并发读下也只是毫秒级停顿。

没有唯一索引时用 `CONCURRENTLY` 会直接失败：

```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_no_index;
-- ERROR: cannot refresh materialized view "public.mv_no_index" concurrently
-- HINT: Create a unique index with no WHERE clause on one or more columns of the table.
```

选型很直接：允许短暂阻塞的内部刷新用全量；面向在线查询的看板、API 用 `CONCURRENTLY`。大表上两种方式内部都是重算整份查询，区别只在锁行为。

## 刷新策略与增量刷新

PG 原生只有全量刷新——每次都把底层查询重跑一遍，没有原生的增量物化。常用策略：

- **定时全量**：数据时效要求到分钟级以上时，用调度器定时 `REFRESH`，最简单可靠。
- **pg_cron 调度**：在数据库内部注册刷新任务，不依赖外部 crontab：

  ```sql
  CREATE EXTENSION pg_cron;
  SELECT cron.schedule(
      'refresh-daily-summary', '30 2 * * *',
      $job$ REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_summary $job$
  );
  ```

- **扩展实现真增量**：社区扩展 [pg_ivm](https://github.com/sraoss/pg_ivm) 基于增量视图维护（IVM）思路，底层表变更时只更新受影响的部分。
- **应用层增量**：自己维护汇总表，用触发器或 CDC（逻辑复制）更新变化部分——这本质上是 [三范式与反范式](/zh/database-design/normalization-and-denormalization) 里说的冗余汇总表，只是把维护逻辑搬到了应用侧。

刷新时机的经验：报表数据天级/小时级全量刷新通常已经够用；当全量刷新耗时逼近刷新间隔时，才值得引入 pg_ivm 或应用层增量，不要提前为不存在的数据量做增量设计。

## 适合物化视图的场景

- **报表与看板**：dashboard 直接查快照，毫秒级响应，不必每次实时聚合几亿行明细。
- **跨库/跨服务快照**：通过 FDW 把外部数据拉到本地物化，查询走本地副本。
- **昂贵 JOIN 的中间结果**：多表 JOIN 的结果固化下来，供多个下游查询复用。
- **读多写少的聚合**：聚合代价远高于可接受的刷新频率时，用存储空间和时效换查询时间。

不适合的场景也很明确：要求实时、且聚合本身不贵——这时普通视图或建好索引的实时查询更合适，省掉刷新链路。

```sql
-- 物化视图是实打实的表：建索引、收集统计、 Vacuum 维护都要自己做
CREATE INDEX idx_mv_stat_date ON mv_daily_summary (stat_date);
ANALYZE mv_daily_summary;
VACUUM (ANALYZE) mv_daily_summary;
```

两个常被忽略的点：物化视图不会自动 `ANALYZE`，刷新后统计信息是旧的，复杂查询前记得手动统计；它也会积累死元组（尤其 `CONCURRENTLY` 刷新采用追加-替换方式），autovacuum 覆盖物化视图，但刷新频繁的视图值得纳入观察，相关现象见 [pg_stat 观测](/zh/internals/pg-stat-observation)。

## 参考资料

- [GitHub · sraoss/pg_ivm](https://github.com/sraoss/pg_ivm)
- [PostgreSQL 官方文档 · 5.5. Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [视图与可更新视图](/zh/database-design/views-and-updatable-views)
- [三范式与反范式](/zh/database-design/normalization-and-denormalization)
- [FDW 与外部数据](/zh/ecosystem/fdw-and-foreign-data)
- [统计信息与 ANALYZE](/zh/performance/statistics-and-analyze)
- [index](/zh/database-design/index)
- [normalization-and-denormalization](/zh/database-design/normalization-and-denormalization)
- [views-and-updatable-views](/zh/database-design/views-and-updatable-views)
- [timescaledb](/zh/ecosystem/timescaledb)