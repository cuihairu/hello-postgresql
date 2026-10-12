# 集群初始化与目录布局

PostgreSQL 里的「集群」（cluster）指一组共享同一数据目录（PGDATA）的服务进程与数据，不是多台机器组成的集群。一台机器上可以并存多个集群（不同版本、不同端口、不同数据目录）。理解 `initdb` 初始化了什么、PGDATA 里每个子目录放什么，是排查启动失败、规划磁盘、做备份迁移的前提。

> 本文以 PostgreSQL 16/17 为准；包路径分别以 Debian/Ubuntu（`/usr/lib/postgresql/<版本>`）和 RHEL 系（`/usr/pgsql-<版本>`）为例。

## initdb 的关键参数

`initdb` 在一个空目录上创建初始集群：生成模板库与系统目录、创建初始角色 `postgres`、写出初始配置文件。它只在集群生命周期开始时执行一次，而编码、locale 这类「建了就改不动」的选项必须一次定对。

```bash
sudo -u postgres initdb -D /var/lib/postgresql/17/main \
  --encoding=UTF8 \
  --locale=C.UTF-8 \
  --auth-local=peer \
  --auth-host=scram-sha-256 \
  --data-checksums \
  --wal-segsize=64 \
  --pwfile=/tmp/pgpass
```

| 参数 | 作用与注意 |
| --- | --- |
| `-D` | 数据目录（PGDATA）。必须为空，属主必须是运行 postgres 的系统用户，且不能用 root 执行 |
| `--encoding` | 新建库的默认编码，集群级默认值事后不可改（单库建库时可单独指定） |
| `--locale` | 影响排序与大小写比较。libc locale 下建好的索引依赖排序规则，改 locale 意味着重建索引；不确定就用 `C` 或 `C.UTF-8` |
| `--auth-local` / `--auth-host` | 生成 `pg_hba.conf` 中本地/远程认证的初值，生产建议 `peer` + `scram-sha-256` |
| `--data-checksums` | 数据页校验和，用于发现存储层损坏。默认关闭，事后只能停机用 `pg_checksums` 补开（PG 12+）；PG 18 起新建集群默认开启 |
| `--wal-segsize` | WAL 段大小，默认 16MB；写量大的实例调大可减少段切换（PG 11+，取 1~1024 的 2 的幂，单位 MB） |
| `--pwfile` | 非交互式给 `postgres` 用户设置初始密码，脚本化初始化必备 |

PG 15+ 还可用 `--locale-provider=icu` 改用 ICU 排序规则，跨平台行为更一致。

## PGDATA 目录结构

```plaintext
PGDATA/
├── PG_VERSION            # 主版本号（内容就是 "17"），版本不对拒绝启动
├── postgresql.conf       # 主配置（Debian 包挪到 /etc，见下文）
├── postgresql.auto.conf  # ALTER SYSTEM 的落点，最后加载、优先级最高
├── pg_hba.conf           # 客户端认证规则
├── postmaster.pid        # 实例运行中才存在：PID、端口、启动时间
├── base/                 # 每个数据库一个子目录（目录名 = 库 OID），表和索引文件在里面
├── global/               # 集群级共享元数据（pg_database、pg_authid 等）
├── pg_wal/               # WAL 段文件，崩溃恢复与复制的命脉
├── pg_xact/              # 事务提交状态（PG 10 前叫 pg_clog）
├── pg_stat/              # 统计信息持久化文件；旁边 pg_stat_tmp/ 是运行时临时统计
├── pg_replslot/          # 复制槽元数据，每个槽一个目录
├── pg_tblspc/            # 表空间符号链接，指向 PGDATA 之外的实际目录
└── pg_multixact/、pg_subtrans/ 等
```

几个要点：

- `base/<库OID>/<relfilenode>` 是表与索引的物理文件，单个文件超过 1GB 会拆成带后缀的多个段文件。查某张表实际落盘位置：

```sql
SELECT pg_relation_filepath('orders');
```

- `pg_wal` 要预留充足空间或单独挂盘：复制槽失联、WAL 归档卡住导致 `pg_wal` 无限增长，是最常见的磁盘满原因。
- 直接 `cp` 一个运行中的 PGDATA 得到的副本不可用；目录级的完整复制必须走物理备份 + WAL 归档，见 [物理备份与 PITR](./physical-backup-and-pitr)。
- 备份 PGDATA 本身就是物理备份的思路，但手工拷贝代替不了归档，理由同上。

## 多版本共存与包布局

Debian/Ubuntu 通过 postgresql-common 管理多版本，每版本可有多个「集群实例」（默认实例名 `main`）：

```plaintext
/usr/lib/postgresql/17/bin/        # 各版本自己的二进制
/etc/postgresql/17/main/           # 配置文件（postgresql.conf、pg_hba.conf、conf.d/）
/var/lib/postgresql/17/main/       # PGDATA
/var/log/postgresql/               # 默认日志目录
```

```bash
pg_lsclusters                      # 列出所有版本与实例的状态、端口、数据目录
pg_ctlcluster 17 main start        # 按版本+实例名启停
sudo -u postgres /usr/lib/postgresql/17/bin/psql   # 直接用指定版本客户端

# /usr/bin/psql 是包装器，默认挑最新已装版本；多版本并用时注意版本匹配
psql --version
```

注意 Debian 的布局把配置从 PGDATA 拆到了 `/etc`，做流复制时 `pg_basebackup` 只拷 PGDATA，备库的 `postgresql.conf`/`pg_hba.conf` 要自行准备（`postgresql.auto.conf` 在 PGDATA 内，会随备份带过去）。

RHEL 系（PGDG 包）不拆分配置，布局更接近官方默认：

```plaintext
/usr/pgsql-17/bin/                 # 二进制，默认不在 PATH
/var/lib/pgsql/17/data/            # PGDATA，配置文件就在里面
```

服务名为 `postgresql-17`，多版本之间靠不同的服务名与端口共存。

## postgresql.conf 与 conf.d 拆分

PGDG 系发行包的 `postgresql.conf` 末尾默认有一行 `include_dir = 'conf.d'`（Debian 在 `/etc/postgresql/17/main/conf.d/`）。自己的调优建议全部放进 conf.d 下的独立文件，别直接改主文件——升级包时主文件可能被覆盖或产生冲突。

```plaintext
# /etc/postgresql/17/main/conf.d/99-tuning.conf
max_connections = 200
shared_buffers = '4GB'
effective_cache_size = '12GB'
work_mem = '32MB'
```

```bash
# 改完 reload 生效（只有 context 为 postmaster 的参数才需要重启）
sudo systemctl reload postgresql@17-main

# 确认参数当前值、来源文件与来源类型
sudo -u postgres psql -c "SELECT name, setting, source, sourcefile
  FROM pg_settings WHERE name IN ('shared_buffers','max_connections');"
```

优先级：`postgresql.auto.conf`（`ALTER SYSTEM` 写入）永远最后加载、覆盖一切 include。同名参数在 conf.d 里改了却「不生效」，多半是 `ALTER SYSTEM` 留下的旧值在压着——用上面的 `pg_settings` 查 `source` 列即可定位。

## systemd 单元与日志

```bash
# Debian/Ubuntu：每个实例一个单元，外加一个聚合单元
systemctl status postgresql@17-main
journalctl -u postgresql@17-main -n 100
tail -f /var/log/postgresql/postgresql-17-main.log   # 包默认日志文件

# RHEL 系
systemctl status postgresql-17
tail -f /var/lib/pgsql/17/data/log/postgresql-*.log  # 默认 logging_collector=on
```

生产建议明确日志出口：要么交给 journald 集中采集，要么开 `logging_collector` 落盘后由 filebeat/vector 收走；同时设置 `log_min_duration_statement`（如 `1s`）把慢查询记进日志，是后续用 `pg_stat_statements` 之外的重要补充。

## 注意事项与常见坑

- **initdb 用 root 跑会直接报错**：必须切到 postgres 系统用户（或容器内对应用户）。
- **locale 建后改动代价大**：libc locale 变更要求对所有受影响索引 `REINDEX`；出问题先查 `SELECT datcollate FROM pg_database;`。
- **校验和默认关**：`--data-checksums` 建库时不开，后面要停机补开，很多团队因此一直没开。
- **`PG_VERSION` 不是改个数字就能升级**：大版本升级要走 pg_upgrade / 逻辑复制 / dump-restore，见 [版本升级](./version-upgrade)。
- **postmaster.pid 残留**：机器掉电后目录里可能留下旧 pid 文件，正常启动会自行清理；若报「pre-existing shared memory block」，先确认真没有旧进程再处理，别上来就删文件。
- **多版本下 psql 与服务器版本不匹配**：客户端版本低于服务器会缺功能甚至行为差异，脚本里建议写全路径或用包装器确认版本。

## 相关页面

- [安装与快速上手](../basics/install-and-quickstart)
- [进程架构](../internals/process-architecture)
- [物理备份与 PITR](./physical-backup-and-pitr)
- [版本升级](./version-upgrade)
