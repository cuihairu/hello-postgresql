# 参考书与官方文档索引

写文档、查问题、深入原理时常用的资源入口。官方资源以 PostgreSQL 官方站点为主；社区与书目只列长期维护、广为人知的来源。

官方手册按版本组织：`docs/current` 永远指向最新稳定版，需要与线上版本严格一致时把 URL 中的 `current` 换成具体版本号（如 `docs/16/`）。

## 按场景查

| 场景 | 去哪查 |
| --- | --- |
| 查某条 SQL 的语法与语义 | [SQL 命令参考](https://www.postgresql.org/docs/current/sql-commands.html) |
| 查报错对应的错误码含义 | [错误码附录](https://www.postgresql.org/docs/current/errcodes-appendix.html) |
| 查某个 GUC 参数的含义与默认值 | [配置参考](https://www.postgresql.org/docs/current/runtime-config.html) |
| 查 pg_stat_* 视图字段 | [监控视图](https://www.postgresql.org/docs/current/monitoring-stats.html) |
| 查 psql 元命令与参数 | [psql 手册](https://www.postgresql.org/docs/current/app-psql.html) |
| 查某版本改了什么 | [Release Notes](https://www.postgresql.org/docs/current/release.html) |

## 官方资源

| 资源 | 链接 | 定位 |
| --- | --- | --- |
| PostgreSQL 官方手册 | [postgresql.org/docs/current](https://www.postgresql.org/docs/current/) | 按版本组织的完整参考，查语法、配置、系统视图的第一入口 |
| SQL 命令参考 | [sql-commands.html](https://www.postgresql.org/docs/current/sql-commands.html) | 全部 SQL 命令的语法与语义索引 |
| psql 手册 | [app-psql.html](https://www.postgresql.org/docs/current/app-psql.html) | 命令行客户端的参数、元命令与变量 |
| 错误码附录 | [errcodes-appendix.html](https://www.postgresql.org/docs/current/errcodes-appendix.html) | 每条 SQLSTATE 错误码的含义与触发场景 |
| Release Notes | [release.html](https://www.postgresql.org/docs/current/release.html) | 各版本行为变化、新增功能与不兼容点 |
| 官方 Wiki | [wiki.postgresql.org](https://wiki.postgresql.org/) | 社区维护的 HOWTO、迁移与运维经验合集 |
| 官方教程 | [tutorial.html](https://www.postgresql.org/docs/current/tutorial.html) | 从建库到查询的入门教程 |
| 性能 Tips | [performance-tips.html](https://www.postgresql.org/docs/current/performance-tips.html) | 官方给出的查询与配置调优建议 |
| 监控视图 | [monitoring-stats.html](https://www.postgresql.org/docs/current/monitoring-stats.html) | pg_stat_* 系列视图的字段说明 |
| 配置参考 | [runtime-config.html](https://www.postgresql.org/docs/current/runtime-config.html) | 全部 GUC 参数的取值与含义 |
| 备份与恢复 | [backup.html](https://www.postgresql.org/docs/current/backup.html) | 物理备份、逻辑备份与时点恢复的官方说明 |

## 驱动与客户端文档

| 资源 | 链接 | 定位 |
| --- | --- | --- |
| pgjdbc | [jdbc.postgresql.org](https://jdbc.postgresql.org/) | Java 官方驱动 |
| psycopg | [psycopg.org](https://www.psycopg.org/) | Python 主流驱动（psycopg 2 与 3） |
| node-postgres | [node-postgres.com](https://node-postgres.com/) | Node.js 主流驱动 |
| Npgsql | [npgsql.org](https://www.npgsql.org/) | .NET 驱动 |

## 社区资源

| 资源 | 链接 | 定位 |
| --- | --- | --- |
| PostgreSQL Weekly | [postgresweekly.com](https://postgresweekly.com/) | 每周邮件周刊，跟踪社区动态与新版本发布 |
| Planet PostgreSQL | [planet.postgresql.org](https://planet.postgresql.org/) | 全球 PostgreSQL 相关博客的聚合 |
| depesz 博客 | [depesz.com](https://www.depesz.com/) | Hubert Lubaczewski 的 PostgreSQL 深度文章 |
| explain.depesz.com | [explain.depesz.com](https://explain.depesz.com/) | 在线 EXPLAIN 计划可视化工具 |
| pganalyze 博客 | [pganalyze.com/blog](https://pganalyze.com/blog) | 查询性能、索引与执行计划分析文章 |
| Use The Index, Luke | [use-the-index-luke.com](https://use-the-index-luke.com/) | 数据库索引原理与调优，多数据库通用 |
| PostgreSQL 社区 | [postgresql.org/community](https://www.postgresql.org/community/) | 邮件列表、IRC 与各地用户组的入口 |

## 中文资源

| 资源 | 链接 | 定位 |
| --- | --- | --- |
| PostgreSQL 中文社区 | [postgres.cn](https://www.postgres.cn/) | 中文社区门户，含官方手册中文译本、活动与问答 |

## 书目

| 书名 | 作者 | 定位 |
| --- | --- | --- |
| PostgreSQL 14 Internals | Egor Rogov | Postgres Professional 出品，官方免费 PDF，系统讲 MVCC、WAL、锁与查询执行 |
| The Internals of PostgreSQL | Hironobu Suzuki | 免费在线（interdb.jp），按子系统讲源码级原理 |
| The Art of PostgreSQL | Dimitri Fontaine | 面向应用开发者，把 SQL 与数据库设计写好的实践书 |
| PostgreSQL: Up and Running | Regina Obe、Leo Hsu | O'Reilly 入门到管理的速成手册 |

## 怎么用这份索引

- 刚入门：官方教程 + The Art of PostgreSQL，先把建库、CRUD 与约束走通。
- 日常排障：先在[错误码附录](https://www.postgresql.org/docs/current/errcodes-appendix.html)查 SQLSTATE，再对照站内[常见错误与排查对照表](./common-errors-and-troubleshooting)。
- 索引与慢查询：Use The Index, Luke 与 pganalyze 博客，配合 `EXPLAIN ANALYZE` 与 explain.depesz.com 看计划。
- 深入原理：两本 Internals 对照读，官方 MVCC、WAL 章节当锚点。
- 跟踪版本：Release Notes 与 PostgreSQL Weekly，升级前必看。

## 相关页面

- [术语表](./glossary)
- [SQL 命令速查](./sql-command-reference)
- [psql 元命令速查](./psql-meta-command-reference)
- [常见错误与排查对照表](./common-errors-and-troubleshooting)
