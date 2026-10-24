# BRIN 索引

BRIN（Block Range Index，块区间索引）为超大表而生：它不为每一行建条目，而是把堆表每连续若干个页（默认 128 页）划成一个区间，**每个区间只存被索引列的 min/max 摘要**。查询时先看摘要：区间与查询条件不可能相交就整段跳过，可能相交就把整段交给执行器过滤。它的体积比 B-tree 小几个数量级，但精确度完全依赖数据本身的物理顺序。官方文档见 [BRIN 索引](https://www.postgresql.org/docs/current/brin.html)。

## 体积：几个数量级的差距

BRIN 的条目数 = 堆页数 ÷ pages_per_range，与行数无关。100 万行的时序表（约 12500 个堆页）默认配置下只有约 100 个摘要条目，索引总共 3 个页：

```sql
CREATE TABLE brin_events (id bigint, sensor_id int, ts timestamptz);
INSERT INTO brin_events
SELECT g, g % 100, now() - (g || ' seconds')::interval   -- ts 随插入单调递增（此处递减）
FROM generate_series(1, 1000000) g;

CREATE INDEX brin_events_ts_idx ON brin_events USING brin (ts);
CREATE INDEX brin_events_ts_btree ON brin_events USING btree (ts);

SELECT indexrelid::regclass AS idx, pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_index WHERE indrelid = 'brin_events'::regclass ORDER BY 1;
--         idx               |  size
-- ---------------------------+--------
--  brin_events_ts_idx        | 24 kB    -- BRIN
--  brin_events_ts_btree      | 21 MB    -- B-tree，约 900 倍
```

查询走位图扫描，计划形如：

```sql
EXPLAIN (COSTS OFF) SELECT count(*) FROM brin_events WHERE ts > now() - interval '10 minutes';
-- Aggregate
--   ->  Bitmap Heap Scan on brin_events
--         Recheck Cond: (ts > (now() - '00:10:00'::interval))
--         ->  Bitmap Index Scan on brin_events_ts_idx
--               Index Cond: (ts > (now() - '00:10:00'::interval))
```

## 适用场景：列值与物理顺序强相关

BRIN 的摘要是"区间 min/max"，只有当**列值随物理存储位置单调变化**时摘要才有区分度。官方的表述是：最适合"值与表行的物理顺序高度相关"的列。典型形态：

- **追加式时序表**：`created_at`/事件时间随插入递增，每个区间的 ts 范围互不重叠，BRIN 能跳过 99% 的数据。
- **按物理位置有序的列**：如自增 id、分批导入的批次号。

判断方法直接看统计信息里的 `correlation`（接近 +1 或 -1 都算强相关，符号只代表方向）：

```sql
SELECT correlation FROM pg_stats
WHERE tablename = 'brin_events' AND attname = 'ts';
--  correlation
-- --------------
--            -1    -- 单调，物理顺序与列值完全一致（方向相反）
```

反之，UUID 主键、随机更新的状态列，correlation 接近 0，BRIN 基本无用。

## pages_per_range 与精度

默认每个摘要覆盖 128 页（1 MB 堆数据）。区间越大，索引越小，但"区间 min/max"越宽、可跳过的页越少；调小则相反：

```sql
CREATE INDEX brin_sh_ts32 ON brin_shuffled USING brin (ts) WITH (pages_per_range = 32);
SELECT relname, reloptions FROM pg_class WHERE relname = 'brin_sh_ts32';
--    relname     |       reloptions
-- ---------------+-------------------------
--  brin_sh_ts32  | {pages_per_range=32}
```

pages_per_range 在建索引时固定，改它需要重建。一般做法：数据完全单调时用默认值即可；数据有轻度乱序时把值调小（如 32 或 16）换取更细的粒度。

## minmax-multi 与 bloom 变体（PG 14+）

PG 14 引入了两类扩展 opclass，解决普通 minmax 的短板：

- **minmax-multi**（如 `timestamptz_minmax_multi_ops`）：每个区间存**多个** min/max 子区间，容忍离群值——比如 99% 的行按时间插入、1% 是补录的历史数据时，普通 minmax 的区间会被离群值撑得极宽，multi 版本仍能保持跳段能力。
- **bloom**（如 `int4_bloom_ops`）：区间内存 bloom filter，服务**等值**查询——minmax 对随机分布列做 `=` 查询几乎没有区分度，bloom 可以。

```sql
CREATE INDEX brin_events_sensor_mm ON brin_events
    USING brin (sensor_id int4_minmax_multi_ops);
```

两者都可用 `values_per_range`（默认 32）控制每区间的存储预算。opclass 必须显式指定，普通 `USING brin (col)` 一律是 minmax。

## 物理顺序被打乱后失效的原因

BRIN 的失效模式很直接：**乱序数据混进来，区间的 min/max 被撑大，所有区间的摘要都开始覆盖全值域，索引就退化成"总是返回整表"**。常见来源：

- 补录/回填历史数据（时间戳远早于现有数据）。
- 消息队列重平衡、多写入端乱序到达。
- 非 HOT 的 UPDATE 把新行版本写到堆的其他位置（列值不变时摘要不受影响，但若更新的是被索引列就会）。

对照实验：把上面那张相关性为 -1 的表按乱序重建，correlation 掉到接近 0：

```sql
CREATE TABLE brin_shuffled AS SELECT * FROM brin_events ORDER BY md5(random()::text);
CREATE INDEX brin_shuffled_ts_idx ON brin_shuffled USING brin (ts);
ANALYZE brin_shuffled;

SELECT correlation FROM pg_stats WHERE tablename = 'brin_shuffled' AND attname = 'ts';
--  correlation
-- --------------
--  0.0062408457
```

此时 BRIN 仍存在、仍会被选中，但每个查询都要 recheck 几乎所有页，收益归零。对策：写入端按时间排序（Kafka 单分区有序、批量导入前 `ORDER BY`）；已知会有离群值时用 `minmax_multi_ops`；乱序严重时放弃 BRIN 或定期重建索引。

## 时序场景与分区表配合

时序负载的常见组合拳：**按时间分区 + 每个分区建 BRIN**。分区裁剪先砍掉时间范围外的分区，分区内的 BRIN 再按 min/max 跳页，两层裁剪叠加：

```sql
CREATE TABLE metrics (
    ts timestamptz NOT NULL,
    value numeric
) PARTITION BY RANGE (ts);

CREATE TABLE metrics_2026_10 PARTITION OF metrics
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE INDEX ON metrics_2026_10 USING brin (ts);
```

BRIN 不适合替代每个分区上的常规索引，而是与它们互补：热点列用 B-tree，时间列用 BRIN 控制存储成本。分区设计见 [分区表设计](/zh/database-design/table-inheritance-and-partitioning-design)，裁剪机制见 [分区裁剪](/zh/performance/partition-pruning)；托管时序方案见 [TimescaleDB](/zh/ecosystem/timescaledb)。

## 参考资料

- [PostgreSQL 官方文档 · Chapter 11. Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL 官方文档 · 11.2. Index Types](https://www.postgresql.org/docs/current/indexes-types.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [分区表设计](/zh/database-design/table-inheritance-and-partitioning-design)
- [分区裁剪](/zh/performance/partition-pruning)
- [索引选型决策树](/zh/indexing/index-selection-decision-tree)
- [B-tree 结构与原则](/zh/indexing/btree-structure)
- [index-selection-decision-tree](/zh/indexing/index-selection-decision-tree)
- [index](/zh/indexing/index)