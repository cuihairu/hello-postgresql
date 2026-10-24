# 内核机制

进程模型、MVCC、WAL、锁、TOAST、执行器与优化器——理解 PostgreSQL「为什么这样跑」的部分。

- [进程架构](/zh/internals/process-architecture) —— postmaster、backend、autovacuum、background worker。
- [MVCC 与多版本](/zh/internals/mvcc-and-multi-version) —— 元组头、xmin/xmax、快照。
- [事务与隔离级别](/zh/internals/transactions-and-isolation) —— READ COMMITTED 默认、RR/SSI、读现象对照。
- [VACUUM 与 HOT](/zh/internals/vacuum-and-hot) —— 死元组、可见性映射、HOT 更新、fillfactor。
- [autovacuum 调优](/zh/internals/autovacuum-tuning) —— 阈值与比例因子、cost delay、卡住排查。
- [WAL 机制](/zh/internals/wal-mechanism) —— WAL 记录、LSN、崩溃恢复。
- [checkpoint 与 buffer](/zh/internals/checkpoint-and-buffer) —— shared_buffers、bgwriter/checkpointer。
- [锁系统](/zh/internals/lock-system) —— 表锁模式、行锁 FOR UPDATE、咨询锁。
- [锁冲突排查](/zh/internals/lock-conflict-troubleshooting) —— pg_locks、pg_blocking_pids、死锁重试。
- [TOAST](/zh/internals/toast) —— 大字段外置与压缩、对 DML 的行为影响。
- [快照与可见性判定](/zh/internals/snapshot-and-visibility) —— 命令 id、clog、事务状态。
- [查询执行管道](/zh/internals/query-execution-pipeline) —— parse→rewrite→plan→execute。
- [优化器代价模型](/zh/internals/optimizer-cost-model) —— cost 估算、pg_statistic、直方图。
- [join 实现](/zh/internals/join-implementations) —— nested loop/merge/hash 的选择依据。
- [并行查询](/zh/internals/parallel-query) —— parallel worker、代价阈值、不能并行的场景。
- [计划缓存与 generic plan](/zh/internals/plan-cache-and-generic-plan) —— prepared statement 计划漂移。
- [逻辑复制底层](/zh/internals/logical-replication-internals) —— wal_level、逻辑解码、publication/subscription。
- [流复制与同步](/zh/internals/streaming-replication-and-sync) —— primary/standby、synchronous_commit。
- [体系结构与内存](/zh/internals/architecture-and-memory) —— work_mem、maintenance_work_mem、OOM 风险。
- [pg_stat 观测](/zh/internals/pg-stat-observation) —— stat_activity、stat_statements、stat_io。

---

- [索引体系](/zh/indexing/index) · [查询调优与性能](/zh/performance/index) —— 内核知识的应用面。

<!-- BACKLINKS-AUTO -->
## 相关页面

- [index](/zh/operations/index)
- [index](/zh/performance/index)
