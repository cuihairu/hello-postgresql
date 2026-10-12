# VACUUM 与 HOT

MVCC 让 UPDATE/DELETE 留下旧版本而不是就地覆盖（见 [MVCC 与多版本](./mvcc-and-multi-version)），旧版本在不再被任何事务需要后就成为死元组。VACUUM 负责回收死元组占用的空间；HOT（Heap-Only Tuple）更新则从源头减负：满足条件的更新完全不碰索引，显著减少写放大与索引膨胀。

## 死元组从哪来

- 每个 UPDATE 都把旧版本变成死元组——PostgreSQL 的 UPDATE 本质是「插入新版本 + 标记旧版本」；
- DELETE 标记的行，在删除事务提交且不再有事务需要看到它们后成为死元组；
- 回滚事务写入的版本同样不可见，也是清理对象；
- 只要还有快照可能读到某个版本（长事务、未释放的复制槽、备库 hot_standby_feedback），它就不能被清。

## VACUUM 做什么

普通 VACUUM（lazy vacuum）一轮做的事：

1. 扫描堆页，移除不再可见的死元组：行指针标记为空闲，页内空间整理复用；
2. 更新 FSM（空闲空间映射），让后续 INSERT/UPDATE 找得到页内空隙；
3. 更新 VM（可见性映射），把全可见页打标——这是 index-only scan 能跳过堆访问的前提，也是下一轮 VACUUM 跳过干净页的依据；
4. 冻结足够老的元组（把 xmin 换成特殊冻结标记），推进事务 ID 回卷防御；
5. 若表尾部连续多页已全空，截断文件把空间还给操作系统。

关键认知：**普通 VACUUM 把回收的空间留在表内部复用，表文件不缩小**（尾部截断除外）。文件已经膨胀后再跑 VACUUM，缩小的是「死元组计数」，不是磁盘占用。

## HOT 更新：不碰索引的更新

UPDATE 同时满足两个条件时走 HOT：

- 没有修改任何被索引引用的列（包括表达式索引的表达式、部分索引的 WHERE 用到的列）；
- 新版本能放进旧版本所在的同一页（页内有足够空闲空间）。

HOT 的收益：

- 所有索引都不动：不为新版本插入任何索引项，索引不因此膨胀，更新代价大幅下降；
- 新旧版本在页内构成 HOT 链，顺着旧版本的 ctid 就能找到新版本；
- 页内积攒的 HOT 死元组可以被轻量的页级修剪（page pruning）提前回收，不必等 VACUUM。

第二个条件解释了 fillfactor 的意义：默认 `fillfactor = 100` 的表页会被插满，之后更新只能跨页放新版本、走不了 HOT。对更新频繁的表把 fillfactor 降到 70~90，给页内留出 HOT 空间，通常能明显提高 HOT 比例。

```sql
-- 只对之后写入的页生效；已写满的存量页要靠重写（VACUUM FULL/CLUSTER）才按新值重排
ALTER TABLE orders SET (fillfactor = 80);
```

## 观察 dead tuple 与 HOT 比例

```sql
SELECT relname, n_tup_upd, n_tup_hot_upd,
       round(100.0 * n_tup_hot_upd / nullif(n_tup_upd, 0), 1) AS hot_pct,
       n_dead_tup, last_vacuum, last_autovacuum
FROM pg_stat_user_tables
ORDER BY n_tup_upd DESC
LIMIT 10;
```

`hot_pct` 长期偏低的更新型表：先确认更新是否真的绕开了所有索引列，再考虑降 fillfactor。统计是累计值，`pg_stat_reset()` 后观察一个完整业务周期更准。

```sql
-- 正在运行的 VACUUM 进度（阶段与已扫描/清理的页数）
SELECT v.pid, p.query, v.phase,
       v.heap_blks_total, v.heap_blks_scanned, v.heap_blks_vacuumed
FROM pg_stat_progress_vacuum v
JOIN pg_stat_activity p ON p.pid = v.pid;
```

手动触发并看详细输出（对照上面两列统计）：

```sql
VACUUM (VERBOSE, ANALYZE) orders;
```

## 膨胀之后的治理：VACUUM FULL 的代价

表文件已经远大于活数据时，普通 VACUUM 无能为力，可选方案：

- `VACUUM (FULL)`：重写整表和全部索引，空间归还操作系统。代价：全程持有 ACCESS EXCLUSIVE 锁（读写全阻塞），需要约等于表大小的临时磁盘，大表耗时长；
- `CLUSTER`：按索引顺序重写整表，效果类似且附带物理聚簇，锁与磁盘代价相同；
- 在线重写工具（pg_repack 等）不阻塞读写，代价是额外磁盘和触发器开销。

治理的核心是预防：控制死元组产生速度（走 HOT、减少无效更新）并让 autovacuum 跟得上，见 [autovacuum 调优](./autovacuum-tuning)。

## 注意事项与常见坑

- `n_dead_tup` 是统计估算值，判断膨胀程度要结合表文件大小与活数据量对比，精确测量用 pgstattuple 扩展，见 [索引膨胀与维护](../indexing/index-bloat-and-maintenance)。
- HOT 帮不了「更新了索引列」的更新；宽表上索引越多，HOT 比例越低，建索引前权衡写入代价，见 [复合索引设计](../indexing/composite-index-design)。
- 长事务是死元组清理的最大敌人：VACUUM 只能清理「所有快照都看不见」的元组，一个忘提交的事务能让整库膨胀。

## 相关页面

- [autovacuum 调优](./autovacuum-tuning)——让自动清理跟得上更新速度。
- [MVCC 与多版本](./mvcc-and-multi-version)——死元组的来源。
- [索引膨胀与维护](../indexing/index-bloat-and-maintenance)——REINDEX 与膨胀测量。
- [VACUUM 停顿与性能](../performance/vacuum-stall-and-performance)——vacuum 影响业务的场景与对策。

官方文档：<https://www.postgresql.org/docs/current/routine-vacuuming.html> 与 <https://www.postgresql.org/docs/current/storage-hot.html>
