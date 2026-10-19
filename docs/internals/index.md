# 内核机制

进程模型、MVCC、WAL、锁、TOAST、执行器与优化器——理解 PostgreSQL「为什么这样跑」的部分。

- [进程架构](process-architecture.md) —— postmaster、backend、autovacuum、background worker。
- [MVCC 与多版本](mvcc-and-multi-version.md) —— 元组头、xmin/xmax、快照。
- [事务与隔离级别](transactions-and-isolation.md) —— READ COMMITTED 默认、RR/SSI、读现象对照。
- [VACUUM 与 HOT](vacuum-and-hot.md) —— 死元组、可见性映射、HOT 更新、fillfactor。
- [autovacuum 调优](autovacuum-tuning.md) —— 阈值与比例因子、cost delay、卡住排查。
- [WAL 机制](wal-mechanism.md) —— WAL 记录、LSN、崩溃恢复。
- [checkpoint 与 buffer](checkpoint-and-buffer.md) —— shared_buffers、bgwriter/checkpointer。
- [锁系统](lock-system.md) —— 表锁模式、行锁 FOR UPDATE、咨询锁。
- [锁冲突排查](lock-conflict-troubleshooting.md) —— pg_locks、pg_blocking_pids、死锁重试。
- [TOAST](toast.md) —— 大字段外置与压缩、对 DML 的行为影响。
- [快照与可见性判定](snapshot-and-visibility.md) —— 命令 id、clog、事务状态。
- [查询执行管道](query-execution-pipeline.md) —— parse→rewrite→plan→execute。
- [优化器代价模型](optimizer-cost-model.md) —— cost 估算、pg_statistic、直方图。
- [join 实现](join-implementations.md) —— nested loop/merge/hash 的选择依据。
- [并行查询](parallel-query.md) —— parallel worker、代价阈值、不能并行的场景。
- [计划缓存与 generic plan](plan-cache-and-generic-plan.md) —— prepared statement 计划漂移。
- [逻辑复制底层](logical-replication-internals.md) —— wal_level、逻辑解码、publication/subscription。
- [流复制与同步](streaming-replication-and-sync.md) —— primary/standby、synchronous_commit。
- [体系结构与内存](architecture-and-memory.md) —— work_mem、maintenance_work_mem、OOM 风险。
- [pg_stat 观测](pg-stat-observation.md) —— stat_activity、stat_statements、stat_io。

---

- [索引体系](../indexing/) · [查询调优与性能](../performance/) —— 内核知识的应用面。

<!-- BACKLINKS-AUTO -->
## 相关页面

- [index](/operations/index.md)
- [index](/performance/index.md)
