# 第7部分：架构与部署

从初始化目录到高可用、备份恢复、PITR、版本升级与监控告警的运维全链路。

- [集群初始化与目录布局](cluster-init-and-layout.md) —— initdb、data 目录、多版本共存。
- [连接管理](connection-management.md) —— pgbouncer 池化语义、事务池限制。
- [高可用架构](high-availability-architecture.md) —— patroni/etcd、故障切换、仲裁与脑裂。
- [流复制搭建](streaming-replication-setup.md) —— primary/standby、复制槽、监控。
- [逻辑复制运维](logical-replication-ops.md) —— publication/subscription、DDL 边界、冲突。
- [备份策略](backup-strategy.md) —— pg_dump/pg_dumpall、并行、逻辑备份边界。
- [物理备份与 PITR](physical-backup-and-pitr.md) —— WAL 归档、pg_basebackup、时间点恢复。
- [版本升级](version-upgrade.md) —— pg_upgrade --link、扩展兼容、滚动升级。
- [云原生与容器](cloud-native-and-containers.md) —— Docker 镜像、StatefulSet 要点、持久卷。
- [监控告警](monitoring-and-alerting.md) —— 关键指标、exporter、磁盘/延迟/事务年龄。
- [故障演练清单](disaster-recovery-drills.md) —— 主库宕机、磁盘满、表膨胀、复制中断。
- [运维 SOP](ops-sop.md) —— 日常巡检、索引维护、vacuum 监控、保留策略。

---

- [内核机制](../internals/README.md) —— 复制与崩溃恢复的底层逻辑。
