# 高可用架构

高可用的目标不是「数据库不挂」，而是主库挂了以后自动选出新主、客户端跟着切过去，并且尽量不丢已确认的提交。PostgreSQL 自身只提供流复制这条数据通道，不提供选主——自动故障转移必须靠外部组件。这一页以目前社区使用最广泛的 Patroni 为例，梳理组件分工、切换流程、丢失窗口的权衡和客户端侧的配合。

## 组件图：Patroni + DCS + 流复制

```plaintext
                etcd / Consul（3 或 5 节点，DCS 共识层）
                        ▲  leader key + 租约 + 集群状态
        ┌───────────────┼───────────────┐
        │               │               │
     patroni         patroni         patroni
     postgres        postgres        postgres
      (主, 可写) ──流复制──▶ (备1)          (备2)
        ▲               ▲               ▲
        └──── HAProxy / VIP，按角色分发流量 ────┘
              (REST API :8008 做健康探测)
```

三层职责分开看：流复制负责搬数据（WAL）；Patroni 负责决策（谁当主、什么时候切换）；DCS（分布式配置存储）负责共识（谁有权当主）。缺了共识层，任何「自动选主」都挡不住脑裂。

## Patroni 做什么

- **选主与租约**：主库持续续写 DCS 里的 leader key，租约 TTL 内续不上即视为失联，备库竞争当选（默认 `loop_wait=10s`、`ttl=30s`、`retry_timeout=10s`）。
- **托管 postgres 进程**：启动、停止、提升、跟随都由 Patroni 包装执行——**不要绕过它直接 `pg_ctl start`**，否则实例会被判为状态异常。
- **REST API**（默认 8008 端口）：对外暴露 `/primary`、`/replica`、`/health` 等端点，既是 `patronictl` 的操作入口，也是 HAProxy 做角色探测的后端。
- **动态配置管理**：部分参数存在 DCS 中，`patronictl edit-config` 修改后滚动生效，直接改 `postgresql.conf` 里被托管的项会被覆盖。
- **同步复制管理**：开 `synchronous_mode` 后动态维护 `synchronous_standby_names`，把确认责任交给存活的备库。
- **watchdog 集成**：为 fencing 提供内核级兜底（见下文）。

```bash
patronictl -c /etc/patroni.yml list                # 集群成员与角色一览
patronictl -c /etc/patroni.yml switchover pgcluster \
  --leader pg1 --candidate pg2                     # 计划内切换
patronictl -c /etc/patroni.yml edit-config         # 修改动态参数
```

## 故障切换流程与丢失窗口

自动切换流程：主库进程崩溃或节点失联 → 其 leader key 租约到期 → 各备库竞选（比较 timeline、回放 LSN、priority）→ 当选者 promote → 其余备库用 `pg_rewind` 或重新 basebackup 后跟随新主。

- **RTO**：默认参数下典型在 15~30 秒量级（TTL 等待 + promote + 客户端重连）， tuned 后可更低，但压到秒级不现实。
- **数据丢失窗口**：异步复制下，主库宕机瞬间尚未传到备库的 WAL 会导致**已确认的提交丢失**，上限约等于主备回放延迟（看 `pg_stat_replication` 的 `replay_lag`）。这是异步 + 自动切换的固有代价。
- **消除丢失**的代价是写入可用性，按业务取舍：

| 方案 | 提交延迟 | 主库故障时 | 备库故障时 |
| --- | --- | --- | --- |
| 异步（默认） | 无额外 | 可能丢最近提交 | 无影响 |
| `synchronous_commit = on` + 单同步备 | 每次提交多一次网络往返 | 不丢已确认提交 | 同步备不可用时写入阻塞 |
| 法定人数 `ANY 1 (备1, 备2)` | 同上 | 不丢 | 容忍一个备库故障 |

```plaintext
# conf.d：法定人数同步，任意 1 个备库落盘确认即可提交
synchronous_commit = on
synchronous_standby_names = 'ANY 1 (pg2, pg3)'
```

各档位的语义细节见 [流复制与同步](../internals/streaming-replication-and-sync)。

## 仲裁与脑裂：Fencing

分布式系统的 FLP 不可能性结论说明：异步网络下无法同时保证一致性与可用性，任何系统都必须显式选边。Patroni 选一致性，具体手段：

- **租约即生杀大权**：主库必须持续续租；续不上（网络分区、进程假死）就要自我终止 postgres，哪怕自己「感觉良好」。这牺牲了一点可用性，换来不会出现双主。
- **watchdog 兜底**：Patroni 支持 Linux 内核 watchdog（常用 `softdog` 模块）。若 Patroni 自身卡死无法喂狗，内核会直接重启机器——防止「Patroni 挂了但 postgres 还活着还接写」这种最危险的脑裂形态。
- **DCS 部署要求**：3 或 5 个节点、跨故障域放置，保证选举有仲裁。DCS 整体不可用时 Patroni 不做主动切换，已运行的实例继续工作（退化但不脑裂）。

## 其他方案一句话

- **repmgr**：复制管理 + 切换工具，部署轻，但没有 DCS 级强共识，自动切换的防脑裂能力弱于 Patroni，适合能接受人工兜底的场景。
- **云托管**（RDS / Aurora / Cloud SQL 等）：HA 交给厂商，省心但换来锁定与版本受限。
- **keepalived + VIP + 手动 promote**：结构最简单，适合允许分钟级人工介入的小系统。

## 客户端故障转移

服务端切换做得再好，客户端连不上旧主就等于故障。PG 10+ 的 libpq 连接串支持多主机，逐个尝试直到找到满足条件的节点：

```bash
psql "postgres://app:***@pg1,pg2,pg3:5432/appdb?target_session_attrs=read-write&connect_timeout=3"
```

- `target_session_attrs` 取值：`any`（默认）、`read-write`、`read-only`（PG 10+）、`primary`、`standby`、`prefer-standby`（PG 12+）。写流量用 `read-write` 或 `primary`。
- JDBC 对应写法：`jdbc:postgresql://pg1,pg2,pg3:5432/appdb?targetServerType=primary&connectTimeout=3`。
- 切换期间正在执行的事务会以错误结束，业务层必须有重试逻辑（幂等写 + 有限次重试），这是 HA 方案的一部分而不是可选项。

## 注意事项与常见坑

- **绕过 Patroni 直接操作 postgres** 是运维事故高发点：重启、切主一律走 `patronictl` 或 `systemctl restart patroni`。
- **「异步复制 + 自动切换」宣传成零丢失** 是常见误导，对外承诺丢失窗口前先看 `replay_lag` 的实际分布。
- **客户端没配多主机与重试**，服务端 HA 等于白做。
- **`pg_rewind` 的前提**：主库开了 `wal_log_hints=on` 或数据页校验和，否则 timeline 分叉后退选的备库只能全量重建，RTO 大幅拉长。
- **DCS 与数据库同机混合部署**（3 台机器各跑 etcd + postgres）在小规模下可行，但要注意资源竞争与升级顺序，别把 DCS 和 DB 一起停。
- **计划内切换先演练**：switchover 流程与故障切换路径不同，上线前用 `patronictl switchover` 验证一次，见 [灾备演练](./disaster-recovery-drills)。

## 参考资料

- [PostgreSQL 官方文档 · Chapter 25. Backup and Restore](https://www.postgresql.org/docs/current/backup.html)
- [PostgreSQL 官方文档 · Chapter 19. Server Configuration](https://www.postgresql.org/docs/current/runtime-config.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [流复制搭建](./streaming-replication-setup)
- [流复制与同步](../internals/streaming-replication-and-sync)
- [备份策略](./backup-strategy)
- [灾备演练](./disaster-recovery-drills)
- [streaming-replication-and-sync](/internals/streaming-replication-and-sync.md)
- [knowledge](/knowledge.md)
- [cloud-native-and-containers](cloud-native-and-containers.md)
- [connection-management](connection-management.md)
- [disaster-recovery-drills](disaster-recovery-drills.md)
- [index](index.md)
- [streaming-replication-setup](streaming-replication-setup.md)
- [version-upgrade](version-upgrade.md)
- [capacity-and-scaling-limits](/performance/capacity-and-scaling-limits.md)