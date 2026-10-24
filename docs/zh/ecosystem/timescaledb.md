# 时序扩展 TimescaleDB

TimescaleDB 是面向时序/监控/物联网负载的 PostgreSQL 扩展：把普通表声明为 hypertable 后，按时间自动切成 chunk 管理，配套提供列式压缩、连续聚合和保留策略。它不是独立的数据库，而是「一套建在原生分区之上的自动化 + 存储优化」，因此事务、SQL、索引、生态全部不变。官方文档见 [docs.timescale.com](https://docs.timescale.com/)。

## 安装与 hypertable

```bash
# Debian/Ubuntu（需添加 Timescale 仓库）
sudo apt install timescaledb-2-postgresql-16
# 完成后按提示在 postgresql.conf 加入 shared_preload_libraries
```

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE metrics (
    time        timestamptz NOT NULL,
    device_id   text NOT NULL,
    temperature double precision NOT NULL
);

-- 声明为 hypertable：按 time 列自动分区，每个 chunk 覆盖 1 天
SELECT create_hypertable('metrics', 'time',
                         chunk_time_interval => INTERVAL '1 day');
```

chunk 间隔是核心参数：过小导致 chunk 数量膨胀（每个 chunk 都有索引与元数据开销），过大导致压缩、删除、vacuum 的粒度变粗。经验是让单个 chunk 解压后的大小在内存可容纳的范围内（官方建议 25%-50% 的可用内存对应量），监控/秒级数据通常取 1 天到 1 周。注意需要 `shared_preload_libraries = 'timescaledb'`，这是它与其他扩展安装流程的最大差别。

插入数据后可以直接观察分区：

```sql
INSERT INTO metrics
SELECT t, 'dev-' || g, 20 + random() * 10
FROM generate_series(now() - interval '7 days', now(), interval '1 minute') AS t,
     generate_series(1, 20) AS g;

SELECT show_chunks('metrics');
```

## 压缩：segmentby 与 orderby

TimescaleDB 的压缩是按 chunk 做的列式压缩，官方口径的压缩率普遍在 90% 以上（10 倍量级），实际取决于数据规整程度：

```sql
ALTER TABLE metrics SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'device_id',
    timescaledb.compress_orderby   = 'time DESC'
);

-- 7 天前的 chunk 自动压缩
SELECT add_compression_policy('metrics', INTERVAL '7 days');
```

两个参数决定数据怎么被切批压缩：

- **segmentby**：按这些列的值把行分组，同组连续行压进一个批次。应选「查询时经常等值过滤」的列（如设备 ID），过滤时能整批跳过。
- **orderby**：组内的排序键。时序数据按时间排序后，相邻值高度相似，delta 与 dictionary 编码的压缩收益最大。

压缩后的 chunk 仍可查询（自动解压需要的批次），但大量随机点查会变慢，所以策略通常是「热数据不压、N 天后自动压」。

## 连续聚合：自动物化的时序聚合

连续聚合（continuous aggregate）是对 `time_bucket` 聚合的自动物化视图：新数据到达后由后台按策略增量刷新，查询时可以叠加原始数据实时部分：

```sql
CREATE MATERIALIZED VIEW metrics_hourly
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', time) AS bucket,
       device_id,
       avg(temperature) AS avg_temp,
       max(temperature) AS max_temp
FROM metrics
GROUP BY bucket, device_id
WITH NO DATA;

-- 每半小时刷新「3 小时前 ~ 1 小时前」的窗口
SELECT add_continuous_aggregate_policy('metrics_hourly',
    start_offset      => INTERVAL '3 hours',
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '30 minutes');

-- 查询与普通表一样
SELECT bucket, device_id, avg_temp
FROM metrics_hourly
WHERE bucket > now() - interval '1 day'
ORDER BY bucket;
```

默认设置下查询的是「物化结果 + 未物化的实时数据」的组合（实时聚合），不想要实时部分（例如只需要历史报表）可设 `WITH (timescaledb.materialized_only = true)`。它与手工维护 [物化视图](/zh/database-design/materialized-views) 的差别在于：不用自己写刷新脚本，且刷新是按窗口增量的，不会整块重算。

## 保留策略：drop_chunks

时序数据最常见的清理动作是「只留 N 天」， TimescaleDB 用策略自动完成：

```sql
-- 手动删除 90 天前的 chunk（按 chunk 整块 DROP，不产生大量死元组）
SELECT drop_chunks(INTERVAL '90 days', 'metrics');

-- 或挂成策略每天自动执行
SELECT add_retention_policy('metrics', INTERVAL '90 days');
```

按 chunk 整体删除比 `DELETE` 便宜得多：没有死元组、没有 vacuum 压力，磁盘空间立即归还。这也是时序场景优先用 hypertable 而非手工 `DELETE` 清理数据的理由，与 [vacuum 与 HOT](/zh/internals/vacuum-and-hot) 中讨论的删除代价直接相关。

## 与原生分区表的对比

PostgreSQL 原生声明式分区（原理见 [分区表设计](/zh/database-design/table-inheritance-and-partitioning-design)）在时序场景够用的情况：

- 分区数量在几十到几百级，分区创建/清理可以用简单脚本或 pg_partman 管理；
- 不需要列式压缩，磁盘成本可接受；
- 没有自动增量物化聚合的需求，或可以用普通物化视图 + 定时刷新凑合；
- 环境不允许安装扩展（托管白名单限制、许可顾虑）。

TimescaleDB 的增量价值集中在：chunk 自动创建与参数自适应、高压缩比、连续聚合、保留策略一体化、对高并发写入路径的专门优化。判断标准很朴素：如果原生分区 + cron 脚本能满足需求，就不必引入扩展；一旦数据量到 TB 级或需要压缩省成本，扩展的自动化才开始划算。

## 许可与常见坑

许可方面，TimescaleDB 采用双许可：hypertable 等核心为 Apache 2 开源，压缩、连续聚合等功能属于 Timescale License（免费可用，但不是 OSI 开源许可，不允许作为数据库服务再分发），商用集成前应核对官方许可页与所用托管平台的扩展白名单。

常见坑：忘记配置 `shared_preload_libraries` 导致建扩展失败；chunk 间隔设得过小（几秒/几分钟）造成数万个 chunk，元数据开销拖垮规划；压缩策略覆盖了还在被高频写入的时间段；把 `time_bucket` 窗口建得比查询粒度细太多导致连续聚合体积失控。选型时也可以对照 [选型问答](/zh/ecosystem/when-to-choose-postgresql)。

## 参考资料

- [wiki.postgresql.org/wiki/Foreign_data_wrappers](https://wiki.postgresql.org/wiki/Foreign_data_wrappers)
- [GitHub · pgvector/pgvector](https://github.com/pgvector/pgvector)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [分区表设计](/zh/database-design/table-inheritance-and-partitioning-design)
- [分区裁剪](/zh/performance/partition-pruning)
- [时间建模](/zh/database-design/time-modeling)
- [扩展管理](/zh/ecosystem/extension-management)
- [time-modeling](/zh/database-design/time-modeling)
- [index](/zh/ecosystem/index)
- [brin](/zh/indexing/brin)
- [knowledge](/zh/knowledge)