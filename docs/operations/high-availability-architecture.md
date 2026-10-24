# High Availability Architectures

The goal of high availability isn't "the database never goes down" — it's that after the primary dies, a new primary is elected automatically, clients follow it over, and already-acknowledged commits are lost as little as possible. PostgreSQL itself only provides streaming replication as the data channel; it provides no leader election, so automatic failover must come from an external component. This page uses Patroni, the most widely adopted solution in the community today, and walks through component responsibilities, the failover flow, the data-loss-window trade-offs, and what the client side has to do along with it.

## Component diagram: Patroni + DCS + streaming replication

```plaintext
                etcd / Consul (3 or 5 nodes, DCS consensus layer)
                        ▲  leader key + lease + cluster state
        ┌───────────────┼───────────────┐
        │               │               │
     patroni         patroni         patroni
     postgres        postgres        postgres
      (primary, writable) ──streaming replication──▶ (standby 1)          (standby 2)
        ▲               ▲               ▲
        └──── HAProxy / VIP, dispatching traffic by role ────┘
              (REST API :8008 used for health probes)
```

Look at the three layers' responsibilities separately: streaming replication moves the data (WAL); Patroni makes the decisions (who is primary, when to switch); the DCS (distributed configuration store) provides consensus (who is entitled to be primary). Without the consensus layer, no "automatic leader election" can prevent split-brain.

## What Patroni does

- **Leader election and leases**: the primary continuously renews the leader key in the DCS; if the lease can't be renewed within its TTL, the primary is considered unreachable and the standbys compete for election (defaults: `loop_wait=10s`, `ttl=30s`, `retry_timeout=10s`).
- **Manages the postgres process**: starting, stopping, promoting, and following are all executed through Patroni's wrappers — **do not bypass it with a direct `pg_ctl start`**, or the instance will be judged unhealthy.
- **REST API** (port 8008 by default): exposes endpoints such as `/primary`, `/replica`, and `/health`. It's both the operational entry point for `patronictl` and the backend HAProxy probes for role detection.
- **Dynamic configuration management**: some parameters live in the DCS; after `patronictl edit-config` they roll into effect, and any managed items edited directly in `postgresql.conf` will be overwritten.
- **Synchronous replication management**: after enabling `synchronous_mode`, it dynamically maintains `synchronous_standby_names` and hands the acknowledgement responsibility to whichever standbys are alive.
- **Watchdog integration**: provides a kernel-level backstop for fencing (see below).

```bash
patronictl -c /etc/patroni.yml list                # cluster members and roles at a glance
patronictl -c /etc/patroni.yml switchover pgcluster \
  --leader pg1 --candidate pg2                     # planned switchover
patronictl -c /etc/patroni.yml edit-config         # change dynamic parameters
```

## Failover flow and data-loss window

The automatic failover flow: the primary process crashes or the node becomes unreachable → its leader key lease expires → each standby competes (comparing timeline, replay LSN, and priority) → the winner promotes → the remaining standbys follow the new primary after `pg_rewind` or a fresh basebackup.

- **RTO**: with default parameters it's typically on the order of 15~30 seconds (TTL wait + promote + client reconnection). It can be tuned lower, but getting it down to the seconds isn't realistic.
- **Data-loss window**: under asynchronous replication, WAL that had not yet reached the standbys at the instant the primary dies causes **already-acknowledged commits to be lost**, bounded above by the primary-standby replay lag (look at `replay_lag` in `pg_stat_replication`). This is the inherent cost of asynchronous + automatic failover.
- The cost of **eliminating the loss** is write availability; choose per your business:

| Approach | Commit latency | When the primary fails | When a standby fails |
| --- | --- | --- | --- |
| Asynchronous (default) | None extra | Recent commits may be lost | No impact |
| `synchronous_commit = on` + a single synchronous standby | One extra network round trip per commit | No acknowledged commits lost | Writes block when the synchronous standby is unavailable |
| Quorum `ANY 1 (standby1, standby2)` | Same as above | No loss | Tolerates one failed standby |

```plaintext
# conf.d: quorum synchronous; commits can proceed once any one standby has flushed to disk
synchronous_commit = on
synchronous_standby_names = 'ANY 1 (pg2, pg3)'
```

See [Streaming Replication and Synchronous Replication](../internals/streaming-replication-and-sync) for the semantic details of each tier.

## Arbitration and split-brain: fencing

The FLP impossibility result for distributed systems states that consistency and availability cannot both be guaranteed over an asynchronous network, so any system must explicitly choose a side. Patroni chooses consistency, by these means:

- **The lease is life and death**: the primary must keep renewing its lease; if it can't (network partition, process hang), it must terminate postgres itself, even if it "feels fine." This sacrifices a little availability in exchange for never having two primaries.
- **Watchdog backstop**: Patroni supports the Linux kernel watchdog (commonly the `softdog` module). If Patroni itself hangs and can't feed the dog, the kernel restarts the machine outright — preventing the most dangerous split-brain shape, "Patroni is dead but postgres is still alive and still accepting writes."
- **DCS deployment requirements**: 3 or 5 nodes, placed across failure domains, to guarantee arbitration for elections. When the DCS is entirely unavailable, Patroni does not initiate a failover; running instances keep working (degraded, but not split-brained).

## Other approaches in one line each

- **repmgr**: replication management + a failover tool; lightweight to deploy, but without DCS-grade strong consensus, its split-brain protection for automatic failover is weaker than Patroni's. Suited to scenarios that can accept a human backstop.
- **Cloud-managed** (RDS / Aurora / Cloud SQL, etc.): hand HA to the vendor — less work, but you trade away lock-in and version constraints.
- **keepalived + VIP + manual promote**: the simplest structure; suited to small systems that can tolerate minute-scale human intervention.

## Client-side failover

No matter how well the server side switches, clients that can't reach the old primary are still down. libpq connection strings in PG 10+ support multiple hosts, trying each in turn until one meets the conditions:

```bash
psql "postgres://app:***@pg1,pg2,pg3:5432/appdb?target_session_attrs=read-write&connect_timeout=3"
```

- `target_session_attrs` values: `any` (default), `read-write`, `read-only` (PG 10+), `primary`, `standby`, `prefer-standby` (PG 12+). Use `read-write` or `primary` for write traffic.
- The JDBC equivalent: `jdbc:postgresql://pg1,pg2,pg3:5432/appdb?targetServerType=primary&connectTimeout=3`.
- Transactions in flight during a switch end with an error, so your business layer must have retry logic (idempotent writes + a bounded number of retries). This is part of an HA design, not an optional extra.

## Caveats and common pitfalls

- **Operating postgres directly, bypassing Patroni**, is a frequent source of ops incidents: always go through `patronictl` or `systemctl restart patroni` for restarts and role switches.
- **Selling "asynchronous replication + automatic failover" as zero data loss** is a common misstatement. Before promising a loss window to anyone, look at the actual distribution of `replay_lag`.
- **Clients without multi-host configuration and retries** make server-side HA pointless.
- **`pg_rewind` preconditions**: the primary needs `wal_log_hints=on` or data page checksums; otherwise a standby stepped back after a timeline divergence can only be rebuilt from scratch, and RTO balloons.
- **Co-locating DCS and database on the same hosts** (3 machines each running etcd + postgres) works at small scale, but watch for resource contention and upgrade ordering — don't stop DCS and DB together.
- **Drill planned switches first**: the switchover path differs from the failover path, so verify once with `patronictl switchover` before going live. See [Disaster Recovery Drills](./disaster-recovery-drills).

## Further reading

- [PostgreSQL official docs · Chapter 25. Backup and Restore](https://www.postgresql.org/docs/current/backup.html)
- [PostgreSQL official docs · Chapter 19. Server Configuration](https://www.postgresql.org/docs/current/runtime-config.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Setting Up Streaming Replication](./streaming-replication-setup)
- [Streaming Replication and Synchronous Replication](../internals/streaming-replication-and-sync)
- [Backup Strategy](./backup-strategy)
- [Disaster Recovery Drills](./disaster-recovery-drills)
- [streaming-replication-and-sync](/internals/streaming-replication-and-sync.md)
- [knowledge](/knowledge.md)
- [cloud-native-and-containers](cloud-native-and-containers.md)
- [connection-management](connection-management.md)
- [disaster-recovery-drills](disaster-recovery-drills.md)
- [index](index.md)
- [streaming-replication-setup](streaming-replication-setup.md)
- [version-upgrade](version-upgrade.md)
- [capacity-and-scaling-limits](/performance/capacity-and-scaling-limits.md)
