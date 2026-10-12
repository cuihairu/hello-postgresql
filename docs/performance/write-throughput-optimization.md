# 写入吞吐优化

写入吞吐的瓶颈通常不在执行 INSERT 的 CPU 时间，而在每笔事务的 WAL 落盘等待和客户端往返。优化思路按收益排序：先减少事务数量（攒批），再换更快的通道（COPY），然后才考虑放宽提交保证（synchronous_commit、unlogged 表），最后为大批量导入做专项准备。前三步改动小、风险低，日常业务就该用；专项准备只针对一次性的数据装载。

## 单条 INSERT 慢在哪

autocommit 下每条 INSERT 都是一个独立事务：写 WAL 记录、等 WAL 刷盘、更新提交状态、可能触发 WAL 全页镜像。1000 条单条 INSERT = 1000 次 fsync 等待 + 1000 次客户端往返，行数据本身的 WAL 量反而是次要开销。

```sql
-- 反面示例：每行一个事务，每行一次网络往返
INSERT INTO events(payload) VALUES ('a');
INSERT INTO events(payload) VALUES ('b');

-- 多值 INSERT：一次解析、一次事务、WAL 连续
INSERT INTO events(payload) VALUES ('a'), ('b'), ('c');

-- 应用侧最常见的形态：攒一批，一个事务提交
BEGIN;
INSERT INTO events(payload)
SELECT unnest(ARRAY['a', 'b', 'c']);
COMMIT;
```

批量写入摊薄的是每笔事务的固定成本：commit 记录与 fsync、页头变更、解析与规划开销、网络 RTT。批量与单条的「行数据 WAL 量」相近，不要指望批量减少 WAL 字节数。

## COPY：最快的导入通道

COPY 走专用的解析与协议路径，跳过 SQL 解析器，官方文档明确推荐大批量数据用 COPY，速度通常是多值 INSERT 的数倍：

```sql
-- psql 客户端文件导入（\copy 在客户端进程读文件，不需要服务端文件权限）
\copy events FROM '/tmp/events.csv' WITH (FORMAT csv, HEADER true)

-- 应用侧流式写入：数据从客户端边生成边发
COPY events(payload) FROM STDIN WITH (FORMAT text);
```

COPY 产生的行数据 WAL 与 INSERT 相同，提交语义也相同——它快在解析和协议开销，不会绕过 fsync 等待。所以 COPY 仍建议包在事务里或靠其自身单事务语义（COPY 本身就是一个事务），并在下面第 5 点权衡提交保证。

## synchronous_commit=off：用丢失窗口换吞吐

默认 `synchronous_commit = on` 时，commit 要等 WAL 刷到磁盘才返回。设为 off 后，commit 只需把 WAL 送到 OS 缓存即返回，由 walwriter 按节奏（每 `wal_writer_delay`，默认 200ms）异步刷盘，省掉了每笔事务的 fsync 等待：

```sql
-- 按会话开启
SET synchronous_commit = off;

-- 更常见的做法：只对高写入、可容忍少量丢失的角色开启
ALTER ROLE metrics_writer SET synchronous_commit = off;
```

关键事实，按官方文档口径：

- 丢失窗口约 3 × `wal_writer_delay`（默认约 600ms），且**只发生在操作系统崩溃或断电**时；PG 进程自身崩溃不丢已提交事务（数据还在 OS 缓存里），正常关闭也不丢。
- **不会出现部分提交或数据损坏**：丢的是窗口内的整个事务，事务边界完好。这是 PG 自身的事务保证，它兜不住的只有硬件/OS 级故障。
- 该设置不减少 WAL 字节数，只改变「何时等待」；WAL 带宽成为瓶颈时它帮不上忙。

适用：监控采样、点赞数、IoT 上报这类丢半秒无所谓的写入。不适用：订单、支付、账务。

## unlogged 表：免 WAL 的 staging 表

`UNLOGGED` 表不写 WAL（仅记录少量元数据 WAL），写入明显更快。代价有两条：数据库崩溃恢复后该表被清空；数据不复制到流复制副本，从库上读不到。

```sql
CREATE UNLOGGED TABLE staging_events (
  id bigint GENERATED ALWAYS AS IDENTITY,
  payload jsonb
);

-- PG 15 起可在普通表与 unlogged 间切换
ALTER TABLE staging_events SET UNLOGGED;
```

定位是 ETL 中转、临时聚合结果、可重跑的 staging 数据——本质上是「会话级/作业级临时数据」，崩了重跑就行。任何丢了要命的数据不要放这里；主从架构下要意识到它的数据在副本上不存在。

## commit_delay

`commit_delay`（微秒）让组内第一个到达提交点的后端稍等片刻，凑更多事务一起做一次 fsync（组提交），需满足 `commit_siblings` 个并发事务。默认 0（不启用）；小事务极多、核心数很多的实例偶有收益，一般保持默认，优先用前面的手段。

## 大批量导入 Checklist

按顺序执行，收益从大到小：

```plaintext
1. 用 COPY 而不是 INSERT，而不是一行行发 SQL；
2. 先删索引和触发器，导完再建——重建索引是排序操作，
   比逐行维护索引快一个数量级；
3. 导入会话调大 maintenance_work_mem（如 1GB），
   重建索引和排序都吃这块内存；
4. 加大 max_wal_size（如 4~8GB），避免导入途中反复 checkpoint、
   反复把同一批页刷盘；
5. 可接受丢失窗口的话，导入会话 SET synchronous_commit = off；
6. 导完后执行 VACUUM ANALYZE，让可见性映射和统计信息跟上；
7. 空库初始化装载可临时 wal_level = minimal（需重启，且
   max_wal_senders = 0 时才生效），配合 COPY 省掉近一半 WAL；
8. 一次性导入期间，可对目标表 ALTER TABLE ... SET (autovacuum_enabled = off)，
   导完记得改回来。
```

## 注意事项与常见坑

- 攒批不是越大越好：单事务过大意味着长事务持 xmin、锁持有时间变长、WAL 峰值集中。从每批 1000~10000 行起步压测找拐点，见 [批量写入与写入模式](../advanced-sql/batch-and-write)。
- `synchronous_commit = off` 与 `fsync = off` 是两回事：后者关闭 WAL fsync 本身，崩溃可能损坏数据库，生产环境禁用。
- unlogged 表当成缓存对待：写监控告警脚本时别把关键数据算进去。
- 导入后如果查询变慢，先怀疑统计信息没刷新，先 ANALYZE 再谈别的。

## 相关页面

- [WAL 机制](../internals/wal-mechanism)——为什么 commit 要等 fsync，WAL 量从哪来。
- [checkpoint 与 buffer](../internals/checkpoint-and-buffer)——max_wal_size 与刷盘节奏的关系。
- [参数调优](./parameter-tuning)——maintenance_work_mem、max_wal_size 的取值。
- [基准工具](./benchmark-tools)——用 pgbench 量化上面每一步的实际收益。

官方文档：<https://www.postgresql.org/docs/current/populate.html> 与 <https://www.postgresql.org/docs/current/wal-async-commit.html>
