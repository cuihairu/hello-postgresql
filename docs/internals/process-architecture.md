# 进程架构

PostgreSQL 采用「一个连接一个进程」的模型：postmaster 主进程监听端口，客户端完成认证后由它 fork 出一个独立的 backend 进程为该连接服务，连接断开进程即退出。进程之间只通过共享内存和信号交互，没有共享的堆内存，这决定了 PostgreSQL 在隔离性、稳定性和连接成本上的基本面貌。

## postmaster 与 backend

postmaster（就是以主进程身份运行的 postgres 可执行文件）只做三件事：

- 监听 TCP 端口与 Unix socket，认证通过后为每个新连接 fork 一个 backend 进程；
- 管理全部子进程的生命周期：某个 backend 崩溃时，postmaster 会终止其余所有进程并进入崩溃恢复（重放 WAL）；
- 不参与 SQL 的解析、规划与执行。

每个 backend 独立完成自己会话的全部工作：解析、优化、执行、返回结果。进程隔离的好处是单个连接的内存错误难以直接污染其他连接；代价是进程创建与上下文切换比线程重，连接数大了之后内存和调度压力明显。

## 与 MySQL「一连接一线程」的对比

| 维度 | PostgreSQL | MySQL（InnoDB） |
| --- | --- | --- |
| 连接载体 | 每个连接一个独立 OS 进程 | 每个连接一个线程，共享同一进程地址空间 |
| 建连成本 | fork 较重，空闲 backend 也占数 MB 内存 | 线程创建轻，栈内存可控 |
| 隔离方式 | 进程级隔离，靠共享内存交换数据 | 线程共享堆内存，靠统一的执行器管理 |
| 崩溃影响 | 任一 backend 崩溃导致整个实例重启 | 普通查询错误不影响其他连接，致命错误同样重启实例 |

结论是一致的：连接本身很贵，生产环境两类数据库都应该用连接池，而不是让每个请求新建连接。

## 辅助进程清单

实例启动后，postmaster 会 fork 出一组常驻辅助进程。`pg_stat_activity.backend_type` 可以把它们和客户端连接区分开：

| 进程 | 职责 |
| --- | --- |
| checkpointer | 执行 checkpoint，批量写出脏页并推进恢复起点，见 [checkpoint 与 buffer](./checkpoint-and-buffer) |
| background writer | 在两次 checkpoint 之间提前写出脏缓冲区，平滑 IO |
| walwriter | 把 WAL 缓冲刷盘，摊平提交路径的刷写压力 |
| autovacuum launcher / worker | launcher 周期调度，worker 实际执行清理，见 [autovacuum 调优](./autovacuum-tuning) |
| WAL sender | 每个流复制 / 逻辑复制的下游对应一个 walsender 进程 |
| archiver | 把写满的 WAL 段复制到归档位置（archive_command / archive_library） |
| logical replication launcher / worker | 逻辑复制订阅端的调度与 apply 进程 |
| stats collector | 收集运行统计；**PG 15 起该进程被移除**，统计改为直接写入共享内存 |

## backend 的私有内存

每个 backend 进程独享一块私有内存区，主要包括：

- `work_mem`：排序、哈希连接、聚合等节点的工作内存。注意一个查询里可能有多个节点各自申请，并行时 worker 也各自有一份；
- `maintenance_work_mem`：VACUUM、CREATE INDEX、ALTER TABLE 等维护操作使用；autovacuum worker 另受 `autovacuum_work_mem`（默认 -1，取 maintenance_work_mem）约束；
- `temp_buffers`：临时表页的缓冲；
- relcache / catcache：系统目录（pg_class、pg_attribute 等）的进程内缓存，首次访问后驻留——这也是长连接通常比每次新建连接快的原因之一。

所有进程共享的则是 shared_buffers、WAL buffers、锁表、事务状态（clog）缓存等共享内存区，完整的内存图景见 [架构与内存](./architecture-and-memory)。

## 连接为什么贵，连接池为什么必要

- 每个 backend 是独立进程：fork、页表复制、初始化目录缓存都发生在建连时，短连接风暴下这些成本反复支付；
- 每个连接常驻数 MB 到数十 MB 内存（缓存随使用增长），上千个空闲连接就可能吃掉数 GB；
- 活跃连接过多会加剧进程调度、锁表和快照管理的开销；`max_connections`（默认 100）远没到机器的承载极限时，性能往往先崩了。

所以标准做法是部署连接池（PgBouncer 或带会话池化的驱动/网关），用几十上百个真实 backend 服务数千客户端会话。事务级池化模式下，会话级特性（prepared statement、advisory lock、SET 会话变量）需要额外处理。详见 [连接管理](../operations/connection-management)。

## 观测 SQL

```sql
-- 当前实例里全部服务端进程及角色分布
SELECT backend_type, count(*)
FROM pg_stat_activity
GROUP BY backend_type
ORDER BY backend_type;
```

```sql
-- 客户端连接明细：谁、从哪来、在等什么、事务开了多久
SELECT pid, usename, datname, client_addr, state,
       wait_event_type, wait_event,
       now() - xact_start AS xact_age, query
FROM pg_stat_activity
WHERE backend_type = 'client backend'
ORDER BY backend_start;
```

```sql
-- 当前会话对应的 backend 进程号，可用来和 ps / top 里的进程对上
SELECT pg_backend_pid();
```

在操作系统侧可以直接看进程树：

```plaintext
# $PGDATA 指向数据目录
pstree -p $(head -1 $PGDATA/postmaster.pid)
```

## 注意事项与常见坑

- 不要用调大 `max_connections` 来扛连接风暴，先上连接池；backend 的内存与调度成本是实打实的，盲目调大只会把问题推迟到 OOM。
- 单个 backend 的 OOM 或断言失败会拖垮整个实例并触发崩溃恢复——共享内存机制决定的，不能当成"一个连接坏了"。排查时先看实例日志，再看是否是某个大查询/连接池配置导致的。
- `pg_stat_activity` 只反映当下快照，历史问题要结合实例日志和 [pg_stat_statements](../performance/pg-stat-statements)。

## 相关页面

- [架构与内存](./architecture-and-memory)——共享内存与私有内存的完整布局。
- [连接管理](../operations/connection-management)——连接数控制与池化实践。
- [pg_stat 观测](./pg-stat-observation)——pg_stat 系列视图的系统用法。

官方文档：<https://www.postgresql.org/docs/current/tutorial-architecture.html> 与 <https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-STATS-ACTIVITY-VIEW>
