# 连接管理

PostgreSQL 的每个连接对应一个独立的后端进程，连接数是真实的资源开销而不只是一个参数。应用直连数据库、每个请求开短连接、或者几百个实例各持一个池，都会把数据库压垮。这一页讲 `max_connections` 怎么定、为什么中间要加连接池，以及 PgBouncer 三种池模式各自能干什么、不能干什么。

## max_connections 与每连接内存成本

- **进程模型**：每连接一个进程（见 [进程架构](../internals/process-architecture)），空闲时也有数 MB 基线内存（栈、目录缓存），活动时每个排序/哈希算子还会按 `work_mem` 再申请。
- **建立成本高**：fork + 认证 + 初始化，一次几十毫秒量级；短连接高并发下，CPU 大量消耗在进程创建上。
- **调大的代价**：内存超卖、上下文切换变多、锁管理器与各处数据结构随连接数线性增长。几百连接是常见的健康上限，更多连接靠池化解决，而不是把参数一路调大。

```sql
SHOW max_connections;
-- 当前连接分布：按状态、按用户/应用分组
SELECT state, count(*) FROM pg_stat_activity GROUP BY 1 ORDER BY 2 DESC;
SELECT usename, application_name, client_addr, count(*)
  FROM pg_stat_activity WHERE backend_type = 'client backend'
  GROUP BY 1,2,3 ORDER BY 4 DESC;
```

```plaintext
# conf.d 片段
max_connections = 200                 # 实际并发由连接池控制
superuser_reserved_connections = 3    # 给运维/监控留通道，默认 3
```

## PgBouncer 三种池模式

PgBouncer 在应用与数据库之间维护少量真实后端连接，把大量客户端连接复用上去。三种 `pool_mode` 的区别在于「一个客户端什么时候占用一个后端连接」：

| 模式 | 占用方式 | 能做 | 不能做 |
| --- | --- | --- | --- |
| session | 客户端连上即独占，直到断开 | 一切会话级特性（`SET`、临时表、游标、advisory lock、`LISTEN/NOTIFY`） | 池化收益有限：连接没释放，后端照样占着 |
| transaction | 每个事务借一个后端，事务结束归还 | 大幅压缩后端连接数，最常用 | 会话级状态不可靠（见下）；协议级 prepared 需 PgBouncer 1.21+ |
| statement | 每条语句各借一次，语句完即还 | 极限压缩连接，适合无状态查询代理 | 不支持显式事务：`BEGIN` 后的多语句事务直接不工作 |

**transaction 模式下的经典坑**：

- **`SET` / `search_path`**：会话级 `SET` 会被下一个复用者「继承」或随归还丢失。改用事务内 `SET LOCAL`，或在连接串上带 `options='-c search_path=app,public'` 每次建后端连接时生效。
- **advisory lock / `LISTEN/NOTIFY` / 临时表 / 跨事务游标**：全是会话级概念，事务池下要么失效要么串到别的客户端，需要这些特性就走 session 模式或直连。
- **prepared statement**：JDBC 等驱动默认走协议级 prepared（pgjdbc 的 `prepareThreshold` 默认 5 次执行后切换）。老版本 PgBouncer 会直接报 `prepared statement "..." does not exist`；**PgBouncer 1.21 起支持协议级 prepared statement**，配合 `max_prepared_statements` 参数即可在 transaction 模式下正常使用。SQL 文本级的 `PREPARE/EXECUTE` 仍不支持。

## 部署位置与关键参数

部署位置两种：与应用同机的 sidecar（本机回环，延迟最小，进程级隔离故障域）或独立池化层（集中管控多应用）。无论哪种，数据库侧的 `max_connections` 都应给直连运维、监控、逻辑复制等留出余量。

```ini
;; /etc/pgbouncer/pgbouncer.ini
[databases]
appdb = host=127.0.0.1 port=5432 dbname=appdb

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = 6432
pool_mode = transaction
max_client_conn = 500          ; 客户端总连接上限，默认 100
default_pool_size = 40         ; 每对 (user, db) 的真实后端连接数，默认 20
reserve_pool_size = 5          ; 突发时借用的后备连接
reserve_pool_timeout = 3       ; 等待超过 3s 才动用后备
server_idle_timeout = 60       ; 后端空闲多久关闭
max_prepared_statements = 200  ; 1.21+ 协议级 prepared 支持
auth_type = scram-sha-256
```

```bash
sudo systemctl restart pgbouncer
psql -h 127.0.0.1 -p 6432 -U pgbouncer pgbouncer   # 连上管理控制台（库名固定 pgbouncer）
```

注意 `server_reset_query`（归还后端连接前执行 `DISCARD ALL`）只在 session 模式生效；transaction 模式下连接随时换主，无法安全清理，也就是说**事务池不帮你兜底会话状态**。

## 应用侧与 bouncer 侧分工

两层池化各管一件事，配置要互相匹配而不是互相打架：

- **应用侧池**（HikariCP、pgx Pool、SQLAlchemy pool 等）负责限制并发：池大小 ≈ CPU 核数 × 2~4（OLTP 经验起点），超出并发的请求在应用内排队，这是可控的。
- **bouncer 侧**负责把多应用的连接复用到 `default_pool_size` 数量的真实后端上。
- **反模式一**：应用池不设上限，指望 PgBouncer 排队——客户端连接把 `max_client_conn` 打满， PgBouncer 自身内存和文件描述符都承压。
- **反模式二**：应用池很大 + bouncer 池也很大——`default_pool_size × 池化层实例数` 要小于 `max_connections`，并且真实并发上限仍应受 CPU/IO 约束，两层排队只会让延迟更难排查。
- 长事务是事务池的天敌：一个长事务占住一个后端连接整段时间，池被少数会话掏空，`cl_waiting` 暴涨。

## 观测：管理控制台命令

连上 `pgbouncer` 管理库后执行（每条命令一个面板）：

```plaintext
SHOW POOLS;     -- cl_active/cl_waiting：客户端排队情况；sv_active/sv_idle：后端占用情况
SHOW CLIENTS;   -- 当前客户端连接来自哪里、连了多久
SHOW SERVERS;   -- 真实后端连接的状态
SHOW STATS;     -- 总 QPS、平均查询时长、收发字节数
```

健康判据：`SHOW POOLS` 里 `cl_waiting` 长期大于 0，说明 `default_pool_size` 不够或存在长事务占坑；`maxwait` 列显示队头等待秒数，持续增长要报警。

## 注意事项与常见坑

- **切到 transaction 模式前先审代码**：搜一遍 `SET`、`advisory_lock`、`LISTEN`、临时表、`PREPARE` 的使用，逐个确认改造或改走 session 模式。
- **升级 PgBouncer 到 1.21+** 是用 JDBC + 事务池的前置条件，否则预编译语句报错多半在高峰期才出现。
- **`max_client_conn` 是 PgBouncer 侧上限**，别忘了同时调系统 `ulimit -n` 与 systemd 的 `LimitNOFILE`。
- **认证透传**：`auth_type=scram-sha-256` 下密码校验方式要与 PostgreSQL 侧匹配，用 `auth_query` 时确认查询账号权限最小化。
- **监控别只看数据库**：PgBouncer 自身进程挂掉等于数据库断连，它也要纳入存活探测。
- **超级用户直连不受池化约束**，运维脚本走直连反而干净，但要给 `superuser_reserved_connections` 留位。

## 参考资料

- [PostgreSQL 官方文档 · Chapter 25. Backup and Restore](https://www.postgresql.org/docs/current/backup.html)
- [PostgreSQL 官方文档 · Chapter 19. Server Configuration](https://www.postgresql.org/docs/current/runtime-config.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [进程架构](../internals/process-architecture)
- [连接与 ORM 优化](../performance/connection-and-orm-optimization)
- [参数调优](../performance/parameter-tuning)
- [高可用架构](./high-availability-architecture)
- [install-and-quickstart](/basics/install-and-quickstart.md)
- [comparison-with-mysql](/ecosystem/comparison-with-mysql.md)
- [process-architecture](/internals/process-architecture.md)
- [knowledge](/knowledge.md)
- [index](index.md)
- [connection-and-orm-optimization](/performance/connection-and-orm-optimization.md)
- [client-drivers](/tools/client-drivers.md)