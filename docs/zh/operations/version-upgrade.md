# 版本升级

PostgreSQL 的小版本（bug 修复）升级只需换二进制；跨大版本（如 15 → 16）数据文件格式不兼容，必须把数据从旧实例搬进新实例。搬法主要有三条路：逻辑导出导入、`pg_upgrade` 原地升级、逻辑复制切换。选哪条取决于停机窗口有多长、库有多大、能不能接受切换期间的双跑。

## 三条路径对比

| 路径 | 停机时长 | 大致成本 | 适用场景 |
| --- | --- | --- | --- |
| pg_dumpall / pg_dump 导出再导入 | 与库大小成正比，几十 GB 起就要小时级 | 操作简单，脚本成熟 | 小库、停机窗口宽裕、还能顺带整理表膨胀 |
| pg_upgrade --link 原地升级 | 分钟级（主要是检查 + analyze） | 需要新旧两份二进制与磁盘空间，硬链接复用文件 | 中大库、能接受短暂只读窗口 |
| 逻辑复制切换（双跑） | 秒级切换 | 要搭一套新实例并等待追赶，DDL 受限 | 要求 RTO 接近零、不能长时间停写 |

选择顺序的经验法则：库不大就 dump/restore，能停几分钟就 pg_upgrade，要求业务无感知就走逻辑复制切换。

## pg_upgrade：--check 与原地升级

前提是新旧两个大版本的二进制都装好（例如 `postgresql-15` 与 `postgresql-17` 共存，见 [集群初始化与目录布局](/zh/operations/cluster-init-and-layout)）。

```bash
# 0. 停掉新旧两个实例
pg_ctl -D /var/lib/postgresql/15/main stop
pg_ctl -D /var/lib/postgresql/17/main stop

# 1. 先跑 --check 干跑，只检查不改动
/usr/lib/postgresql/17/bin/pg_upgrade \
  --old-datadir /var/lib/postgresql/15/main \
  --new-datadir /var/lib/postgresql/17/main \
  --old-bindir /usr/lib/postgresql/15/bin \
  --new-bindir /usr/lib/postgresql/17/bin \
  --link --check

# 2. 检查通过后正式执行；--link 用硬链接复用旧数据文件，空间和时间都省
/usr/lib/postgresql/17/bin/pg_upgrade \
  --old-datadir /var/lib/postgresql/15/main \
  --new-datadir /var/lib/postgresql/17/main \
  --old-bindir /usr/lib/postgresql/15/bin \
  --new-bindir /usr/lib/postgresql/17/bin \
  --link
```

几个硬性要求：

- **两个实例都要先 stop**，pg_upgrade 不支持在线升级。
- 新集群的 `initdb` 使用的 locale、encoding 要和旧集群一致，否则检查阶段会失败。
- **扩展要先在新集群里装好**（`CREATE EXTENSION`，版本号要匹配新版），否则 pg_upgrade 报错退出。`postgis`、`pgvector` 这类带 C 代码的扩展尤其要先装对应新版本的 so。
- `--link` 模式完成后旧数据目录不可再用（硬链接共享 inode），升级完成后旧目录只能整目录归档或删除，不能再起来当回退。

升级完成后立刻对新集群跑 `ANALYZE`（pg_upgrade 已经会提示），否则统计信息为空，执行计划会离谱。

## 升级前检查清单

- 扩展兼容：列出新集群要装的扩展及目标版本，确认有新版 so。
- 弃用参数：对照 release notes 检查 `postgresql.conf` 里被移除或改名的 GUC（例如 PG 12 移除 `recovery.conf`，PG 14 改名 `wal_keep_size`）。
- 认证方式：`pg_hba.conf` 的方法在新版是否仍受支持（如 `md5` 在 PG 18 起被废弃为默认不推荐）。
- 备份：升级前必须完成一次成功的基础备份 + 归档（见 [物理备份与 PITR](/zh/operations/physical-backup-and-pitr)）。
- 磁盘：非 `--link` 模式要有旧库 1.2 倍以上的空闲空间做新目录；`--link` 模式也要留出临时文件的余量。
- 统计重建：升级完成后第一时间跑 `vacuumdb --all --analyze-in-stages`，分阶段把统计信息铺开。

## 滚动切换：逻辑复制双跑

不停机的路子是先建一套新版本实例，用逻辑复制把数据同步过去，窗口期只做一次切换。

```sql
-- 旧库（发布端，PG 10+）
CREATE PUBLICATION app_pub FOR ALL TABLES;

-- 新库（订阅端）
CREATE SUBSCRIPTION app_sub
  CONNECTION 'host=old-host dbname=app user=repl'
  PUBLICATION app_pub WITH (copy_data = true);
```

切换步骤：

1. 新订阅建好，等初始同步 + 增量追平（看 `pg_stat_subscription` 的 `latest_end_lsn` 与发布端的 LSN 差）。
2. 挑一个低峰窗口，把应用写流量短暂停住（或用只读模式锁住旧库：`ALTER SYSTEM SET default_transaction_read_only = on` 后 reload）。
3. 等订阅完全追平，在新库确认数据一致。
4. 把应用连接串切到新库（DNS、配置中心、pgbouncer 后端任选一种切法）。
5. 观察一段时间后停掉订阅；保留旧库一段时间作为回退手段，但不允许写入。

回退方式：切换后立刻发现问题，把应用连接串切回旧库即可（前提是旧库在切换后没有再被写入，所以切走之后旧库必须设为只读或停止复制方向）。切回之前要想清楚旧库上是否已经丢了切换后新库上的写入。

逻辑复制的局限要提前想清楚：DDL 不会复制，切换窗口里不能在新旧库各跑一半 DDL；大对象（`bytea` 之外的大对象类型）不复制；序列的当前值不会自动复制，切换前要在新库显式对齐（`setval` 到旧库当前值，逐个序列处理）。

## 小版本升级

同一个大版本内（例如 17.2 → 17.4）数据格式兼容，做法是换二进制：

```bash
# Debian/Ubuntu 系
apt-get update && apt-get install --only-upgrade postgresql-17
# RHEL 系
yum update postgresql17-server

# 停库 → 换包 → 起库（小版本升级必须重启实例）
pg_ctl -D $PGDATA stop
# 包管理器会替换 /usr/lib/postgresql/17/bin 下的二进制
pg_ctl -D $PGDATA start
```

要点：

- 小版本也要重启，不是「reload 一下就行」。提前安排停机窗口或依赖 HA 切换（见 [高可用架构](/zh/operations/high-availability-architecture)）。
- 只装安全修复的小版本，不要跳着升，按官方 release notes 顺序来。
- 主从架构下先升从库，再切主，最后升原主，减少整体不可写时间。

## 注意事项与常见坑

- 忘了先在新集群装扩展是最常见的 pg_upgrade 失败原因，`--check` 也会报出来，不要跳过干跑。
- `--link` 升级之后旧数据目录不能直接起来用，很多团队栽在这里做回退。要保留可回退状态就别用 `--link`，改用 `pg_dumpall` 全量导出。
- pg_upgrade 结束后统计信息是空的，首日性能会异常，必须先跑 `vacuumdb --analyze-in-stages`。
- 逻辑复制双跑期间，两边都可能有业务在写（比如忘了关的定时任务），会出现主键冲突。切换窗口要把所有写入口都纳入检查。
- 升级后的第一天重点盯 `pg_stat_statements`（见 [pg_stat_statements](/zh/performance/pg-stat-statements)）和慢查询日志，新版本优化器的代价模型变化可能让个别 SQL 选错计划，用 `plan_cache_mode` 或显式 hint 过渡。

## 参考资料

- [PostgreSQL 官方文档 · pg_upgrade](https://www.postgresql.org/docs/current/pgupgrade.html)
- [PostgreSQL 官方文档 · 18.6. Upgrading a PostgreSQL Cluster](https://www.postgresql.org/docs/current/upgrading.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [install-and-quickstart](/zh/basics/install-and-quickstart)
- [extension-management](/zh/ecosystem/extension-management)
- [postgresql-16-features](/zh/ecosystem/postgresql-16-features)
- [postgresql-17-features](/zh/ecosystem/postgresql-17-features)
- [when-to-choose-postgresql](/zh/ecosystem/when-to-choose-postgresql)
- [logical-replication-internals](/zh/internals/logical-replication-internals)
- [backup-strategy](/zh/operations/backup-strategy)
- [cloud-native-and-containers](/zh/operations/cloud-native-and-containers)
- [cluster-init-and-layout](/zh/operations/cluster-init-and-layout)
- [index](/zh/operations/index)
- [logical-replication-ops](/zh/operations/logical-replication-ops)
- [streaming-replication-setup](/zh/operations/streaming-replication-setup)- [集群初始化与目录布局](/zh/operations/cluster-init-and-layout)——多版本共存与 initdb 参数。
- [物理备份与 PITR](/zh/operations/physical-backup-and-pitr)——升级前必备的备份保障。
- [高可用架构](/zh/operations/high-availability-architecture)——用切换减少升级停机。
- [逻辑复制运维](/zh/operations/logical-replication-ops)——双跑切换的细节与冲突处理。

官方文档：<https://www.postgresql.org/docs/current/pgupgrade.html> 与 <https://www.postgresql.org/docs/current/upgrading.html>
