# 安装与首次连接

安装 PostgreSQL 的目标是：跑起一个**集群**（一组进程 + 一个数据目录），建一个库，然后用 psql 连上去执行第一条 SQL。不同操作系统的安装路径差别主要在"软件包从哪来"和"服务怎么起"，概念本身是一致的。

> 本文示例以 PostgreSQL 16 / 17 为主，语法和目录结构跨版本基本一致。

## 三个安装渠道

各平台安装方式官方汇总见 [PostgreSQL Downloads](https://www.postgresql.org/download/)，Linux 上建议优先用 PGDG 源拿新版本，而不是发行版自带的旧版。

- **发行版源（Debian/Ubuntu）**：`apt install postgresql-16` 会装上服务端与客户端，并自动创建 `postgres` 系统用户、注册 systemd 服务。注意 Ubuntu 22.04 / Debian 12 的官方源通常带 14 或 15，要 16+ 建议用 PGDG 源。
- **PGDG 源（RHEL / Rocky / Fedora）**：PostgreSQL 官方维护的仓库（https://yum.postgresql.org/），rpm 包路径统一为 `/usr/pgsql-16/bin`。
- **Homebrew / Windows 安装器**：macOS 与 Windows 各自一键装好，Windows 安装器会替你跑完 `initdb`。

## Debian / Ubuntu（apt）

```bash
# 添加 PGDG 源（以 Debian 12 / PG16 为例，可换 bookworm → noble、postgresql-16 → 17）
sudo apt install -y curl ca-certificates
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
  | sudo tee /etc/apt/sources.list.d/pgdg.list

sudo apt update
sudo apt install -y postgresql-16

# 服务由 systemd 托管（Debian/Ubuntu 包默认注册好）
sudo systemctl enable --now postgresql
sudo systemctl status postgresql
```

## RHEL / Rocky / Fedora（dnf）

```bash
# 安装 PGDG 仓库 rpm（以 Rocky 9 / PG16 为例）
sudo dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm

# 启用仓库并安装
sudo dnf module disable -y postgresql
sudo dnf install -y postgresql16-server postgresql16-contrib

# RHEL 系包不会自动初始化，必须手动跑一次
sudo /usr/pgsql-16/bin/postgresql-16-setup initdb
sudo systemctl enable --now postgresql-16
```

## macOS（Homebrew）

```bash
brew install postgresql@16

# 让命令行工具进入 PATH（Apple Silicon 路径为 /opt/homebrew，Intel 为 /usr/local）
echo 'export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# Homebrew 通常会在安装时自动 initdb 到 $(brew --prefix)/var/postgresql@16；
# 若目录不存在或想自建，手动初始化一次：
initdb -D "$(brew --prefix)/var/postgresql@16" -E UTF8

# 启动为常驻服务
brew services start postgresql@16
```

## Windows（官方安装器）

到 https://www.postgresql.org/download/windows/ 下载 EDB 图形安装器，一路 Next 即可。安装器会完成三件事：

1. 把程序装到 `C:\Program Files\PostgreSQL\16`；
2. 用 `initdb` 初始化数据目录（默认 `C:\Program Files\PostgreSQL\16\data`）；
3. 注册并启动名为 `postgresql-x64-16` 的 Windows 服务。

记下安装时设置的 `postgres` 超级用户密码，后面 `psql` 连本机会用到。

## 集群、initdb 与启停

**集群（database cluster）** 是 PG 特有的术语：指 `initdb` 初始化出来的一个**独立数据目录**，包含若干数据库，由一组后台进程共同服务。一个服务器上可以存在多个集群（版本或端口不同），通过 `PGDATA` 或 `-D` 指定。`initdb` 与 `pg_ctl` 的完整参数见官方文档 [initdb](https://www.postgresql.org/docs/current/app-initdb.html) 与 [pg_ctl](https://www.postgresql.org/docs/current/app-pg-ctl.html)。

**数据目录内容**（以 PG16 为例）：

```text
/var/lib/postgresql/16/main/     # PGDATA
├── postgresql.conf              # 主配置文件
├── pg_hba.conf                  # 客户端认证规则
├── PG_VERSION                   # 版本标识
├── base/                        # 用户数据文件
├── global/                      # 全局系统表
└── postmaster.pid               # 运行时 pid 文件
```

`initdb` 只会建三个系统库：`postgres`（默认连接库）、`template0`（干净模板）、`template1`（默认 CREATE DATABASE 的模板）。

```bash
# 以 postgres 用户初始化（不要用 root）
sudo -u postgres /usr/lib/postgresql/16/bin/initdb \
  -D /var/lib/postgresql/16/main -E UTF8 --locale=C.UTF-8
```

**启停集群**：

```bash
# 直接控制（适合排障）
pg_ctl -D /var/lib/postgresql/16/main -l /tmp/pg.log start
pg_ctl -D /var/lib/postgresql/16/main stop -m fast

# 生产环境交给 systemd（推荐）
sudo systemctl start postgresql      # Debian/Ubuntu 包名
sudo systemctl start postgresql-16   # PGDG 包名
```

停止模式 `-m` 三档：`fast`（默认，等客户端断开）、`immediate`（直接杀，下次要恢复）、`smart`（等所有会话结束）。日常维护用 `fast` 即可。

## 建库建用户与第一条 SQL

装好服务后，默认只有 `postgres` 超级用户。生产上建议另建业务账号；本地试跑时可直接用 `postgres` 即可。

```bash
# 在 Debian/Ubuntu 上，postgres 用户的 peer 认证要求系统用户同名
sudo -u postgres psql
```

```sql
-- 建用户与库（超级用户身份执行）
CREATE ROLE app LOGIN PASSWORD 'secret';
CREATE DATABASE appdb OWNER app;

-- 连进新库（另开终端，或在 psql 里 \c appdb）
-- psql -U app -d appdb

-- 第一条 SQL：建表、插数据、查询
CREATE TABLE users (
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name  text        NOT NULL,
    email text        UNIQUE NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO users (name, email) VALUES
    ('张三', 'zhangsan@example.com'),
    ('李四', 'lisi@example.com');

SELECT id, name, created_at FROM users ORDER BY id;
```

看到两行数据返回，说明整条链路（安装 → 初始化 → 建库 → 建表 → 查询）已经跑通。

## 注意事项与常见坑

- **不要用 root 运行 postgres**：官方会拒绝以 root 身份启动，必须用专门的系统用户（Debian 系的 `postgres` 用户、PGDG 安装时也一样）。
- **数据目录不能直接拷走再启动**：跨主机的迁移要走 PITR / 逻辑备份（详见 [备份策略](/zh/operations/backup-strategy)），拷文件只在同版本同架构时勉强可行。
- **端口与监听地址**：默认 5432，只监听 `localhost`；`listen_addresses` 与 `pg_hba.conf` 决定谁能连，改完要 `reload` 或重启。
- **`createdb` / `createuser` 是命令行快捷方式**：本质是封装的 SQL，等价于 `CREATE DATABASE` / `CREATE ROLE`，适合脚本化建库。
- **忘记密码时**：`pg_hba.conf` 临时把本地认证改成 `trust`，reload 后用 `psql -U postgres` 进去改密码，再改回原规则，别忘 reload。

## 参考资料

- [postgresql.org/media/keys/ACCC4CF8.asc](https://www.postgresql.org/media/keys/ACCC4CF8.asc)
- [apt.postgresql.org/pub/repos/apt](https://apt.postgresql.org/pub/repos/apt)
- [download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm](https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm)
- [postgresql.org/download/windows](https://www.postgresql.org/download/windows/)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [什么是 PostgreSQL](/zh/basics/what-is-postgresql)
- [psql 常用操作](/zh/basics/psql-getting-started)
- [连接管理](/zh/operations/connection-management)
- [版本升级](/zh/operations/version-upgrade)
- [index](/zh/basics/index)
- [psql-getting-started](/zh/basics/psql-getting-started)
- [what-is-postgresql](/zh/basics/what-is-postgresql)
- [cluster-init-and-layout](/zh/operations/cluster-init-and-layout)
- [local-dev-environment](/zh/tools/local-dev-environment)