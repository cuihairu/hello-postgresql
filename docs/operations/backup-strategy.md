# 备份策略

备份分两派：逻辑备份（pg_dump 系工具，导出 SQL 级数据）与物理备份（复制数据目录 + WAL 归档，见 [物理备份与 PITR](./physical-backup-and-pitr)）。逻辑备份恢复慢、没有时间点恢复能力，但跨版本、跨平台、可按表选择性恢复，适合中小库的日常备份、跨版本迁移兜底和给测试环境造数据。这里记录工具用法与边界，以及怎么组合成分级策略。

## pg_dump：单库逻辑备份

```bash
# 自定义格式 -Fc：压缩、支持并行恢复与选择性恢复，日常备份首选
pg_dump -h 127.0.0.1 -U postgres -Fc -f appdb-$(date +%F).dump appdb

# 目录格式 -Fd：唯一支持并行导出的格式（-j 才生效）
pg_dump -Fd -j 4 -f appdb_dir appdb

# 结构与数据分开导出（--section 三段：pre-data / data / post-data）
pg_dump -Fc --section=pre-data --section=post-data -f appdb-schema.dump appdb
pg_dump -Fc --section=data -f appdb-data.dump appdb

# 单表
pg_dump -Fc -t orders -f orders.dump appdb
```

要点：

- **格式选择**：纯文本输出（默认）只能整文件喂给 psql；`-Fc`/`-Fd` 归档格式才能配合 pg_restore 做并行与选择性恢复。
- **--section** 的分工：`pre-data` 是表结构，`post-data` 是索引、约束、触发器、视图。这个顺序意味着恢复时可以先建表、灌数据、最后建索引——pg_restore 的并行恢复自动按此优化。
- **跨环境恢复**常用 `--no-owner --no-privileges`：不带属主与授权信息，避免目标库角色不存在导致失败。
- `-Z 0~9` 控制压缩级别，默认适中；CPU 富余可调高换更小文件。

## pg_dumpall：全局对象

角色、表空间等集群级对象不属于任何库，`pg_dump` 备不到，必须单独留一份：

```bash
pg_dumpall --globals-only -f globals.sql    # 角色/口令哈希/表空间/权限
# 恢复：psql -f globals.sql（通常在目标集群恢复业务库之前先执行）
```

`pg_dumpall` 不带参数时会导出全实例所有库，但输出是纯文本、单连接、不可并行，大库不建议作为常规备份手段——日常备份用 pg_dump 分库做，全局对象用 `--globals-only` 补。

## pg_restore：恢复

```bash
# 并行恢复（-Fc/-Fd 均支持），-j 是最大的提速手段
pg_restore -h target -U postgres -j 4 -d appdb appdb.dump

# 恢复进一个新建库（归档里含 CREATE DATABASE 语句）
pg_restore -C -d postgres appdb.dump

# 覆盖已有对象前先清理（危险操作，确认目标库可重建）
pg_restore --clean --if-exists -d appdb appdb.dump
```

单表恢复是归档格式的核心优势——生成目录清单、筛出目标表再恢复：

```bash
pg_restore -l appdb.dump > toc.list        # 生成目录清单
# 编辑 toc.list：删除不需要的条目行（以分号开头的行是注释，保留与否无所谓）
pg_restore -j 2 -L toc.list -d appdb appdb.dump
```

## 逻辑备份的边界

- **速度**：受 SQL 层导出/导入限制，TB 级库动辄小时到天级；`-Fd -j` 并行导出、`pg_restore -j` 并行恢复能压不少，但仍慢于物理恢复一个基础备份 + 追 WAL。
- **没有 PITR**：恢复点就是备份完成那一刻，两次备份之间的增量恢复不了，需要时间点恢复就得靠 WAL 归档。
- **版本兼容方向**：旧版本导出的 dump 可以恢复进新版本——这是官方支持的大版本升级路径之一；反方向（新导旧）不支持。`pg_dump` 客户端版本必须不低于被备份的服务器版本，工具链升级时注意。
- **不含集群级对象**：角色与表空间靠 `pg_dumpall --globals-only` 单独备份，漏掉这一份是恢复时最常踩的坑。
- **运行影响**：逻辑备份不阻塞 DML，但大库导出会拉高 IO 与缓存压力，放在业务低峰执行。

## 分级备份策略

单一种备份覆盖不了所有故障场景，生产上按「恢复目标」组合：

| 层级 | 手段 | 覆盖场景 | 保留期参考 |
| --- | --- | --- | --- |
| 每日逻辑备份 | `pg_dump -Fc` 分库 | 误删单表/单库、跨版本兜底、造测试数据 | 7~30 天 |
| 每周物理基础备份 + 持续 WAL 归档 | pgBackRest / Barman / WAL-G | 误删整库后的时间点恢复（PITR）、整机故障 | 14~30 天 |
| 全局对象 | `pg_dumpall --globals-only` 每日 | 新环境重建角色权限 | 与逻辑备份同步 |

配套原则：

- **3-2-1**：至少 3 份副本、2 种介质、1 份异地（对象存储或另一机房）。
- **备份与数据库不同机**：备份文件和数据目录放同一块盘，机器没了备份也没了。
- 保留期按合规要求与存储成本定，到期清理旧的 basebackup 与归档 WAL。
- 生产环境建议用 pgBackRest 或 WAL-G 替代裸 cron 脚本：并发、压缩、校验、S3 兼容存储支持都是现成的。

```bash
# 简单场景的 cron 示例（每日逻辑备份 + 保留 14 天）
0 2 * * * pg_dump -h 127.0.0.1 -U postgres -Fc \
  -f /backup/appdb-$(date +\%F).dump appdb \
  && find /backup -name 'appdb-*.dump' -mtime +14 -delete
```

## 备份必须演练恢复

没有验证过恢复流程的备份不能算备份——文件损坏、参数缺失、全局对象遗漏都只会在真恢复时暴露。演练要回答三个数：**能恢复到什么时间点（RPO）、恢复要多久（RTO）、数据对不对**。

```bash
# 月度演练：在隔离环境（测试机/容器）恢复并核对
pg_restore -C -h localhost -d postgres appdb-2026-10-01.dump
psql -d appdb -c "SELECT count(*) FROM orders;"          # 行数核对
psql -d appdb -c "SELECT max(updated_at) FROM orders;"   # 数据新鲜度核对
```

- 把演练脚本化，记录每次实测 RTO；恢复时间超过业务容忍度就要调整层级（比如加大物理备份频率或改用增量）。
- 物理备份的恢复演练（PITR 到指定时间点）步骤更多，单独见 [灾备演练](./disaster-recovery-drills)。
- 演练环境版本尽量与生产一致：跨大版本恢复属于升级场景，走 [版本升级](./version-upgrade) 的路径验证。

## 注意事项与常见坑

- **只备了业务库、漏了 globals**：恢复后用户和权限全缺，应用连不上。
- **`pg_dumpall` 全量文本当唯一备份**：大库恢复时间不可接受，且没有 PITR。
- **`--clean --if-exists` 用错环境**：它会先 DROP 目标库里的同名对象，指向生产库就是事故。
- **单表恢复时忘记配套**：只恢复一张表的数据，可能因外键约束在 post-data 阶段失败，评估好恢复顺序。
- **逻辑复制/迁移场景的序列值**：dump-restore 会恢复序列，但逻辑复制不搬序列，切换前手动 `setval` 对齐。
- **备份本身没有监控**：备份任务失败一周没人发现，等于裸奔——对备份文件的存在性、大小和新鲜度设告警。

## 参考资料

- [PostgreSQL 官方文档 · Chapter 25. Backup and Restore](https://www.postgresql.org/docs/current/backup.html)
- [PostgreSQL 官方文档 · Chapter 19. Server Configuration](https://www.postgresql.org/docs/current/runtime-config.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [物理备份与 PITR](./physical-backup-and-pitr)
- [灾备演练](./disaster-recovery-drills)
- [版本升级](./version-upgrade)
- [集群初始化与目录布局](./cluster-init-and-layout)
- [common-beginner-mistakes](/basics/common-beginner-mistakes.md)
- [install-and-quickstart](/basics/install-and-quickstart.md)
- [multi-tenant-modeling](/database-design/multi-tenant-modeling.md)
- [soft-delete-and-tombstone](/database-design/soft-delete-and-tombstone.md)
- [postgresql-17-features](/ecosystem/postgresql-17-features.md)
- [when-to-choose-postgresql](/ecosystem/when-to-choose-postgresql.md)
- [knowledge](/knowledge.md)
- [cloud-native-and-containers](cloud-native-and-containers.md)
- [disaster-recovery-drills](disaster-recovery-drills.md)
- [high-availability-architecture](high-availability-architecture.md)
- [index](index.md)
- [logical-replication-ops](logical-replication-ops.md)
- [ops-sop](ops-sop.md)
- [physical-backup-and-pitr](physical-backup-and-pitr.md)
- [data-encryption-at-rest](/security/data-encryption-at-rest.md)