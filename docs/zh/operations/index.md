# 架构与部署

从初始化目录到高可用、备份恢复、PITR、版本升级与监控告警的运维全链路。

- [集群初始化与目录布局](/zh/operations/cluster-init-and-layout) —— initdb、data 目录、多版本共存。
- [连接管理](/zh/operations/connection-management) —— pgbouncer 池化语义、事务池限制。
- [高可用架构](/zh/operations/high-availability-architecture) —— patroni/etcd、故障切换、仲裁与脑裂。
- [流复制搭建](/zh/operations/streaming-replication-setup) —— primary/standby、复制槽、监控。
- [逻辑复制运维](/zh/operations/logical-replication-ops) —— publication/subscription、DDL 边界、冲突。
- [备份策略](/zh/operations/backup-strategy) —— pg_dump/pg_dumpall、并行、逻辑备份边界。
- [物理备份与 PITR](/zh/operations/physical-backup-and-pitr) —— WAL 归档、pg_basebackup、时间点恢复。
- [版本升级](/zh/operations/version-upgrade) —— pg_upgrade --link、扩展兼容、滚动升级。
- [云原生与容器](/zh/operations/cloud-native-and-containers) —— Docker 镜像、StatefulSet 要点、持久卷。
- [监控告警](/zh/operations/monitoring-and-alerting) —— 关键指标、exporter、磁盘/延迟/事务年龄。
- [故障演练清单](/zh/operations/disaster-recovery-drills) —— 主库宕机、磁盘满、表膨胀、复制中断。
- [运维 SOP](/zh/operations/ops-sop) —— 日常巡检、索引维护、vacuum 监控、保留策略。

---

- [内核机制](/zh/internals/index) —— 复制与崩溃恢复的底层逻辑。

<!-- BACKLINKS-AUTO -->
## 相关页面

- [index](/zh/security/index)
