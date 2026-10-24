# Architecture & Operations

The full operations chain from initializing a data directory to high availability, backup and recovery, PITR, version upgrades, and monitoring and alerting.

- [Cluster Initialization and Directory Layout](cluster-init-and-layout.md) — initdb, the data directory, running multiple versions side by side.
- [Connection Management](connection-management.md) — pgbouncer pooling semantics, transaction-pool limits.
- [High-Availability Architecture](high-availability-architecture.md) — patroni/etcd, failover, arbitration and split-brain.
- [Setting Up Streaming Replication](streaming-replication-setup.md) — primary/standby, replication slots, monitoring.
- [Operating Logical Replication](logical-replication-ops.md) — publications/subscriptions, DDL boundaries, conflicts.
- [Backup Strategy](backup-strategy.md) — pg_dump/pg_dumpall, parallelism, logical backup limits.
- [Physical Backup and PITR](physical-backup-and-pitr.md) — WAL archiving, pg_basebackup, point-in-time recovery.
- [Version Upgrades](version-upgrade.md) — pg_upgrade --link, extension compatibility, rolling upgrades.
- [Cloud Native and Containers](cloud-native-and-containers.md) — Docker images, StatefulSet essentials, persistent volumes.
- [Monitoring and Alerting](monitoring-and-alerting.md) — key metrics, exporters, disk/latency/transaction age.
- [Disaster-Recovery Drills](disaster-recovery-drills.md) — primary outage, disk full, table bloat, replication outage.
- [Operations SOP](ops-sop.md) — daily patrol, index maintenance, vacuum monitoring, retention policy.

---

- [Internals](../internals/) — the underlying logic of replication and crash recovery.

<!-- BACKLINKS-AUTO -->
## Related Pages

- [index](/security/index.md)
