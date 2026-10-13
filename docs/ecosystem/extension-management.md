# 扩展管理

扩展（extension）是 PostgreSQL 生态的装载机制：一组打包好的 SQL 对象（类型、函数、操作符、索引方法）加上 C 代码，用一条 `CREATE EXTENSION` 整体安装。pgvector、PostGIS、TimescaleDB、pg_stat_statements 都以扩展形式交付，掌握扩展的安装、升级与版本管理，是运维 PG 环境的基本功。

## 基本操作

```sql
-- 安装（前提：扩展的二进制已装到服务器上，见下文）
CREATE EXTENSION pg_trgm;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 装到指定 schema（要求扩展可重定位），便于统一管理
CREATE SCHEMA IF NOT EXISTS ext;
CREATE EXTENSION pg_trgm WITH SCHEMA ext;

-- 查看已安装与可用版本
SELECT extname, extversion FROM pg_extension;

-- 升级到最新可用版本 / 指定版本
ALTER EXTENSION pg_trgm UPDATE;
ALTER EXTENSION pg_trgm UPDATE TO '1.6';

-- 卸载；CASCADE 会连带删除扩展提供的对象，谨慎使用
DROP EXTENSION pg_trgm;
```

注意 `CREATE EXTENSION` 是库级操作：`template1` 里装过的扩展会自动出现在之后新建的库里；对已存在的库要逐库执行。安装报 `could not open extension control file` 说明服务端没装二进制包，`CREATE EXTENSION` 只注册元数据，不下载代码。

## 查看可用扩展

```sql
SELECT name, default_version, installed_version, trusted
FROM pg_available_extensions
WHERE name IN ('pg_trgm', 'vector', 'postgis', 'pg_stat_statements');

SELECT version FROM pg_available_extension_versions WHERE name = 'postgis';
```

这两个视图来自系统目录（参见 [系统目录与元数据](../basics/system-catalogs-and-metadata)），「二进制已装但未启用」与「服务器上根本没有」一眼可分。

## control 文件与 trusted 扩展

每个扩展在服务端有一份控制文件，如 `/usr/share/postgresql/16/extension/pg_trgm.control`：

```plaintext
comment = 'text similarity measurement and index searching based on trigrams'
default_version = '1.6'
relocatable = true
trusted = true
```

- `default_version`：`CREATE EXTENSION` 不指定 `VERSION` 时安装的版本。
- `relocatable`：为 true 时可用 `WITH SCHEMA` 放进任意 schema。
- `trusted`：**PG 13 引入**。标记为 trusted 的扩展（pg_trgm、citext、btree_gin、pgcrypto 等）允许数据库 owner 或有 CREATE 权限的普通用户自行安装，不再要求超级用户。这在托管环境（只能拿到库级权限）里尤其有用；非 trusted 的扩展（PostGIS、TimescaleDB 这类带 C 库的）仍需要超级用户安装。授权模型见 [角色与权限](../security/roles-and-permissions)。

## 从哪里装：发行版包、PGXN、源码

```bash
# 1) 发行版/PGDG 包：最推荐，随 PG 版本对齐命名
sudo apt install postgresql-16-postgis-3     # PostGIS
sudo apt install postgresql-16-pgvector      # pgvector

# 2) PGXN：社区扩展仓库，需要 pgxn 客户端
pip install pgxnclient
pgxn install pgvector

# 3) 源码编译：需要 PG 开发头文件
sudo apt install postgresql-server-dev-16
git clone https://github.com/pgvector/pgvector && cd pgvector
make && sudo make install    # 装入 pg_config --pkglibdir 与 --sharedir
```

装完二进制后回到 psql 执行 `CREATE EXTENSION`。原则是：生产环境优先用发行版包（和 PG 本体同源升级、依赖清晰），PGXN/源码用于没有现成包或需要新版本的情况。

## 扩展与版本升级

PG 大版本升级时扩展是主要摩擦点，流程上要记住顺序：

1. **升级前**：在新版本的安装目录装齐**所有**扩展的二进制包（`pg_upgrade` 和逻辑导出都只迁移元数据，不会替你编译 C 库）；
2. **升级**：`pg_upgrade` 会带着 `pg_extension` 目录一起搬，外表、索引等对象随库迁移；
3. **升级后**：逐个检查并更新扩展自身的 SQL 定义（PostGIS、pgvector 等在新 PG 版本里常有配套小版本）：

```sql
SELECT extname, extversion FROM pg_extension;

ALTER EXTENSION postgis UPDATE;
ALTER EXTENSION pg_trgm  UPDATE;
```

PostGIS 这类扩展还要跑它自带的 `postgis_upgrade` 脚本，且建议先在演练环境验证升级路径。完整升级流程见 [版本升级](../operations/version-upgrade)。

## 常用扩展清单

| 扩展 | 用途 | 备注 |
| --- | --- | --- |
| pg_stat_statements | SQL 耗时统计，慢查询治理的起点 | 需 `shared_preload_libraries` |
| pg_trgm | 三元组模糊匹配，LIKE 加速与相似搜索 | trusted，GIN 索引常用 |
| pgvector | 向量类型与 ANN 检索 | 见 [向量检索 pgvector](./pgvector) |
| PostGIS | 空间类型与空间函数 | 需超级用户，配套包多 |
| pgcrypto | 加密/哈希函数（AES、pgp） | trusted |
| pgaudit | 会话/对象级审计日志 | 需 `shared_preload_libraries` |
| pg_partman | 声明式分区的自动管理 | 常与原生分区表配合 |
| pg_repack | 在线整理表/索引膨胀 | 配套客户端命令使用 |
| postgres_fdw / file_fdw | 访问远端 PG / 本地文件 | 内置 contrib |
| unaccent | 去除重音符号的文本规范化 | 全文检索常用 |
| btree_gin | 让 GIN 索引支持普通标量列组合 | 多列混合过滤索引 |

这份清单与各扩展的深入用法贯穿全书：监控见 [pg_stat_statements](../performance/pg-stat-statements) 与 [审计](../security/audit)，文本匹配见 [全文检索](../advanced-sql/full-text-search)。

## 参考资料

- [GitHub · pgvector/pgvector](https://github.com/pgvector/pgvector)
- [wiki.postgresql.org/wiki/Foreign_data_wrappers](https://wiki.postgresql.org/wiki/Foreign_data_wrappers)

<!-- BACKLINKS-AUTO -->
## 相关页面

- 子树总纲：[第9部分：生态与新特性](/ecosystem/)

- [系统目录与元数据](../basics/system-catalogs-and-metadata)
- [版本升级](../operations/version-upgrade)
- [向量检索 pgvector](./pgvector)
- [角色与权限](../security/roles-and-permissions)
- [fdw-and-foreign-data](fdw-and-foreign-data.md)
- [index](index.md)
- [pgvector](pgvector.md)
- [postgis](postgis.md)
- [timescaledb](timescaledb.md)
- [knowledge](/knowledge.md)