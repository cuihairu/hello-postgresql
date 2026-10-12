# psql 入门

psql 是 PostgreSQL 自带的官方命令行客户端，装完服务端或单独装 `postgresql-client` 即可用。写 SQL 之外，它还提供一组以反斜杠开头的**元命令**（meta-command）用来查元数据、切换库、控制输出格式。后端开发者每天打交道的对象、索引、执行计划，都靠它顺手查看。本文只挑高频用法，完整参考见官方 [psql 手册](https://www.postgresql.org/docs/current/app-psql.html)与站内 [psql 元命令速查](../appendix/psql-meta-command-reference)。

## 连接方式

psql 需要知道四件事：主机、端口、用户、数据库。四条途径按优先级覆盖：命令行参数 > 环境变量 > 默认值。

```bash
# 1) 短参数：-h 主机  -p 端口  -U 用户  -d 数据库
psql -h localhost -p 5432 -U postgres -d postgres
psql -h 10.0.0.8 -p 5432 -U app -d appdb

# 2) 连接串（URI / key=value 均可）
psql "postgresql://app:secret@10.0.0.8:5432/appdb"
psql "host=10.0.0.8 port=5432 dbname=appdb user=app password=secret"

# 3) 环境变量（适合脚本与会话级默认）
export PGHOST=localhost PGPORT=5432 PGUSER=postgres PGDATABASE=postgres
psql      # 直接进入，等价于上面四个变量拼起来
```

不传 `-h` 时，本地连接默认走 Unix socket，认证方式由 `pg_hba.conf` 的 `local` 行决定（Debian/Ubuntu 上是 peer，要求系统用户与数据库用户同名，所以常写 `sudo -u postgres psql`）。连上后提示符形如 `postgres=#`，`#` 表示超级用户。

## 核心元命令

```sql
\l                 -- 列出所有数据库（大小、owner、编码）
\c appdb           -- 切换到另一个数据库
\dt                -- 列出当前 schema 下的表
\d users           -- 查看表结构：列、类型、约束、索引、外键
\d+ users          -- 更详细：存储、压缩、注释等
\dn                -- 列出 schema
\di                -- 列出索引
\di users_pkey     -- 查看具体索引定义
\timing            -- 打开/关闭 SQL 执行耗时显示
\x                 -- 切换扩展显示（行转竖排，宽表必用）
\q                 -- 退出 psql
```

`\d` 后面可以跟不同字母看不同对象：`\dt` 表、`\dv` 视图、`\ds` 序列、`\df` 函数、`\du` 用户/角色、`\dx` 扩展。`\d+`、`\l+` 会追加存储细节与注释。

一个典型会话：

```text
appdb=> \timing
Timing is on.
appdb=> \x
Expanded display is on.
appdb=> SELECT * FROM users LIMIT 1;
-[ RECORD 1 ]+---------------------------
id           | 1
name         | 张三
email        | zhangsan@example.com
created_at   | 2026-10-12 08:00:00+08
```

## 求助：\? 与 \h

- `\?` 列出**所有元命令**的帮助，忘掉 `\copy` 参数时在这里翻；
- `\h` 列出**SQL 命令**的语法，`\h INSERT`、`\h CREATE TABLE` 会给出对应语法骨架，比翻文档快。

两者是纯客户端帮助，不连服务端也能用。

## 输出格式：\pset

`\pset` 控制查询结果的呈现，常用的几组：

```sql
\pset null '(null)'     -- 让 NULL 显示为 (null)，避免和空串混淆
\pset format aligned    -- 默认对齐格式；可选 unaligned / csv / html
\pset border 2          -- 边框样式
\pset pager off         -- 关闭分页器（少条数时省事）
\pset tuples_only on    -- 只输出数据行，不要表头和行数统计
```

`\pset` 只对当前会话生效；要持久化就写进 `~/.psqlrc`（见下节）。`psql -c "..."` 配合 `\pset format csv` 或 `\copy` 也是导出数据的常用组合。

## 历史与 ~/.psqlrc

psql 用 GNU readline 保存命令历史：上下方向键翻历史、`Ctrl-R` 反向搜索，历史文件默认在 `~/.psql_history`，可用 `PSQL_HISTORY` 环境变量改位置。

`~/.psqlrc` 在每次 psql 启动时执行，适合放个性化设置：

```text
-- ~/.psqlrc：每次启动自动生效
\set PROMPT1 '%n@%/%R%# '
\pset null '(null)'
\pset pager off
\timing on
\set ON_ERROR_STOP on
```

- `\set ON_ERROR_STOP on` 让脚本在第一条出错语句处停下，避免迁移脚本错一半；
- `\set PROMPT1` 定制提示符，`%n` 用户、`%` 数据库、`%#` 超级用户显示 `#`；
- Windows 下对应文件是 `%APPDATA%\postgresql\psqlrc.conf`。

注意 `~/.psqlrc` 里的内容必须是合法 psql 输入（SQL 或元命令），写错会导致每次启动报一行错。

## 数据导入导出：\copy

`\copy` 是 psql 客户端侧的命令：数据流经 psql 进程读写本地文件，因此**不需要服务端文件权限**，比服务端的 `COPY` 命令更常用于日常导入导出：

```sql
\copy users TO '/tmp/users.csv' WITH (FORMAT csv, HEADER true)
\copy users FROM '/tmp/users.csv' WITH (FORMAT csv, HEADER true)
```

服务端的 `COPY ... TO '/path'` 要求 postgres 系统用户对目标路径有写权限，还默认受 `superuser` 限制；`\copy` 以当前系统用户身份读写文件，权限模型更友好。大批量装载的性能对比见 [psql 进阶](../tools/psql-advanced)。

## 注意事项与常见坑

- **元命令不能跨行**：`\d users` 必须一行写完；SQL 语句以分号结束，元命令以换行结束。
- **`\dt` 默认只看 search_path 里的 schema**：看不到其它 schema 的表时，先 `SET search_path` 或用 `\dt schema.*`。
- **`\timing` 计的是客户端往返时间**：包含网络与渲染开销，做性能分析要用 `EXPLAIN ANALYZE`（见 [EXPLAIN 基础](../performance/explain-basics)）。
- **`\x` 只影响显示**：不改变数据本身，复制粘贴结果时注意别把竖排格式当表结构。

## 相关页面

- [安装与快速上手](./install-and-quickstart)
- [数据库与 schema 对象](./database-and-schema-objects)
- [psql 进阶用法](../tools/psql-advanced)
- [psql 元命令速查](../appendix/psql-meta-command-reference)
