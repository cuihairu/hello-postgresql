# 索引膨胀与维护

索引是持续写入的有序结构：UPDATE 留下旧版本条目、DELETE 留下死条目、页分裂留下半满页。vacuum 能把死条目标记为可复用，但不会把文件缩小，长期运行的表上索引实际占用的空间会明显大于有效数据所需的规模——这就是索引膨胀（bloat）。膨胀的直接影响是同样的查询要读更多的索引页，IOS 收益流失、缓存效率下降。这里整理怎么量化膨胀、怎么安全重建、以及怎么处理重复索引和没人用的索引。

## 膨胀从哪来

- **UPDATE 的双倍写入**：MVCC 下 UPDATE 在堆里写新版本；若 HOT 优化不适用（更新了索引列、或新版本落到别的页），每个索引都要追加一条新条目，旧条目等 vacuum 回收（机制见 [VACUUM 与 HOT](/zh/internals/vacuum-and-hot)）。
- **删除与空间复用**：vacuum 把死条目标记为可复用并把空间登记回页内空闲空间，但文件大小不变；只有页内再插入相近键值的行时空间才被重新利用。键值分布随时间漂移（如自增 id 的高值区不断插入、旧键区只删不插）时，空洞很难被复用。
- **页分裂**：顺序插入后乱序删除、或随机键值的插入，让叶子页长期处于低密度状态。
- **批量回滚、大事务**之后的索引垃圾也会集中出现。

一句话判断风险：更新/删除越频繁、索引越多、越宽，膨胀越快。追加型表（只有 INSERT）几乎不膨胀。

## 观测：pgstattuple 与估算 SQL

`pgstattuple` 扩展提供精确数字：

```sql
CREATE EXTENSION IF NOT EXISTS pgstattuple;

-- B-tree 内部结构：叶页密度、碎片率
SELECT * FROM pgstatindex('idx_ios_flag');
```

关键字段：

```plaintext
 leaf_pages         | 90
 avg_leaf_density   | 90.16    -- 叶页平均填充率，健康值 90 左右
 leaf_fragmentation | 0.00     -- 越高说明物理顺序越乱
```

`avg_leaf_density` 降到 50% 上下就意味着一半的索引页在装空气。全库粗筛可以用统计视图估算：索引尺寸远大于「行数 × 每行索引宽度」、或与近似重建后的尺寸差距悬殊的，是重建候选：

```sql
SELECT s.schemaname, s.relname AS table_name, s.indexrelname,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size,
       s.idx_scan,
       n_live_tup, n_dead_tup, last_autovacuum
FROM pg_stat_user_indexes s
JOIN pg_stat_user_tables t USING (relid)
ORDER BY pg_relation_size(s.indexrelid) DESC
LIMIT 20;
```

精确估算要靠对每个索引跑 `pgstatindex` 汇总 `avg_leaf_density`，代价是扫描整个索引，只在维护窗口对重点表执行。

## REINDEX 与 REINDEX CONCURRENTLY

重建把索引按当前数据重新写一遍，文件直接回到紧凑状态：

```sql
-- 普通重建：对所重建的索引加排他锁，期间该索引不可用、相关写入被阻塞
REINDEX INDEX idx_ios_flag;

-- 在线重建：PG 12 起支持 CONCURRENTLY，不阻塞读写
REINDEX INDEX CONCURRENTLY idx_ios_flag;

-- 批量：按表或整个库
REINDEX TABLE CONCURRENTLY orders_p;
REINDEX DATABASE CONCURRENTLY mydb;
```

要点：

- **PG 12 是分水岭**：`REINDEX CONCURRENTLY` 从 PG 12 才可用（系统目录重建此前不支持）；更老版本只能用 `CREATE INDEX CONCURRENTLY` 新索引 + 旧索引改名 + 删旧的这一套换名流程。
- `REINDEX CONCURRENTLY` 不能在事务块里执行；耗时约为普通重建的两倍（要建影子索引、两次表扫描、等待事务收尾）。
- **中断会留下 INVALID 索引**：进程被杀或报错后，可能残留 `pg_index.indisvalid = false` 的半成品，它们继续吃写放大却不服务查询，必须清理：

  ```sql
  SELECT indexrelid::regclass
  FROM pg_index
  WHERE NOT indisvalid;

  -- 确认后：先再试一次 REINDEX CONCURRENTLY，失败则删除
  DROP INDEX CONCURRENTLY 半成品索引名;
  ```

- 什么时候重建：`avg_leaf_density` 明显偏低且该索引服务高频查询；vacuum 无法回收的极端场景；升级大版本或改了 collation 之后。低频查询的小索引不值得为几个 MB 停机重建。

## 发现并处理重复与未用索引

每个索引都在给所有写入加税，冗余索引是纯支出。两步筛查：

```sql
-- 1) 功能重叠：A 的键列是 B 键列的前缀（或两者完全相同），A 即冗余候选
SELECT r.indexrelid::regclass AS redundant_index,
       c.indexrelid::regclass AS covering_index,
       r.indrelid::regclass   AS table_name
FROM pg_index r
JOIN pg_index c
  ON c.indrelid = r.indrelid
 AND c.indexrelid <> r.indexrelid
 AND c.indisunique = false                      -- 覆盖者自身不承载唯一约束
 AND (c.indkey::text = r.indkey::text           -- 键列完全重复
   OR c.indkey::text LIKE r.indkey::text || ' %'); -- r 是 c 的键前缀

-- 2) 零使用：自统计重置以来从未被扫描
SELECT s.schemaname, s.indexrelname,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size,
       s.idx_scan
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0
  AND NOT i.indisunique
  AND NOT i.indisprimary
ORDER BY pg_relation_size(s.indexrelid) DESC;
```

第一个查询利用了最左前缀原则：组合索引 `(a, b)` 可以完全接管单列索引 `(a)` 的等值/范围查找，两列同时建就是重复纳税。它的输出只是候选名单，没有比对 opclass、表达式与部分索引谓词的差异，删除前必须逐条人工确认。删除要按流程走：

1. **记录定义**：`SELECT pg_get_indexdef('索引名'::regclass);` 存档，含 INCLUDE、谓词、opclass 全部细节。
2. **观察期**：`idx_scan` 统计至少覆盖一个完整业务周期（月结、季度报表这类低频查询会漏报）。`stats_reset` 时间用 `pg_stat_statements_reset` 的时间线或 `pg_stat_database.stats_reset` 对照。可以先把索引重命名为 `zz_unused_xxx` 观察一段时间——改名不影响功能，回滚只需改回。
3. **低峰删除**：`DROP INDEX CONCURRENTLY 索引名;` 不阻塞读写。主键与唯一约束索引不能这样删（它们承载约束），也几乎不该删。
4. **回滚预案**：把第 1 步的定义作为一键重建脚本留在变更单里。

注意事项：从库与主库跑的查询集合不同，主库没用的索引在从库可能高频使用；`idx_scan` 在实例重启、`crash`、手动 reset 后归零，别拿刚重置的统计下结论。

## 维护窗口策略

- **常态**：一律 `REINDEX ... CONCURRENTLY`，挑业务低峰、错开备份与大批量 ETL 的时间段；一次重建一个索引，观察 I/O 与复制延迟（复制延迟见 [流复制与同步](/zh/internals/streaming-replication-and-sync)）。
- **专用窗口**：小索引、或可以短暂阻塞写入的表，普通 `REINDEX` 更快更省资源。
- **不能停写也不能等窗口**：外部扩展 `pg_repack` 可以在线整理表和索引（重建为新文件后换名），适合膨胀严重、CONCURRENTLY 又解决不了的整表场景。
- **自动巡检**：把「INVALID 索引数」「avg_leaf_density 低于阈值的索引数」纳入监控告警（对接方式见 [监控与告警](/zh/operations/monitoring-and-alerting)），膨胀是慢性病，靠巡检而不是等查询变慢才想起来。

## 参考资料

- [PostgreSQL 官方文档 · Chapter 11. Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL 官方文档 · 11.2. Index Types](https://www.postgresql.org/docs/current/indexes-types.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [composite-index-design](/zh/indexing/composite-index-design)
- [gin](/zh/indexing/gin)
- [index-only-scans](/zh/indexing/index-only-scans)
- [index](/zh/indexing/index)
- [autovacuum-tuning](/zh/internals/autovacuum-tuning)
- [mvcc-and-multi-version](/zh/internals/mvcc-and-multi-version)
- [vacuum-and-hot](/zh/internals/vacuum-and-hot)
- [disaster-recovery-drills](/zh/operations/disaster-recovery-drills)
- [ops-sop](/zh/operations/ops-sop)
- [vacuum-stall-and-performance](/zh/performance/vacuum-stall-and-performance)- [仅索引扫描](/zh/indexing/index-only-scans) —— 膨胀如何直接削弱 IOS 收益。
- [VACUUM 与 HOT](/zh/internals/vacuum-and-hot) —— 死条目的产生与回收机制。
- [B-tree 结构与原则](/zh/indexing/btree-structure) —— 页分裂与叶页密度的结构背景。
- [autovacuum 调优](/zh/internals/autovacuum-tuning) —— 让清理追上写入的上游手段。

官方文档：[REINDEX](https://www.postgresql.org/docs/current/sql-reindex.html)、[pgstattuple](https://www.postgresql.org/docs/current/pgstattuple.html)、[索引日常维护](https://www.postgresql.org/docs/current/indexes.html)。
