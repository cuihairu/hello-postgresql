# pgAdmin 4

pgAdmin 4 是 PostgreSQL 官方生态里的图形化管理工具，Web 架构（浏览器访问，服务端可跑在任意机器上），覆盖查询、对象管理、备份恢复、活动监控。写代码的人未必天天用它，但 DBA 值班和给业务同学演示时经常要用。

## Docker 部署

pgAdmin 官方提供容器镜像 `dpage/pgadmin4`，一条命令跑起来：

```bash
docker run -d --name pgadmin \
  -p 5050:80 \
  -e PGADMIN_DEFAULT_EMAIL=admin@example.com \
  -e PGADMIN_DEFAULT_PASSWORD='change-me' \
  dpage/pgadmin4
```

浏览器访问 `http://localhost:5050`，用上面的邮箱和密码登录。首次登录后在 Servers 里 Register → Server，填目标库的 Host、Port、Username、Password——注意这里的连接是 pgAdmin 服务端发起的，容器里填 `localhost` 指的是容器自己；要连宿主机上的库用 `host.docker.internal`（Windows/macOS）或宿主机内网 IP。

生产环境建议把 pgAdmin 放内网、加访问控制，它保存着到各环境的数据库凭证。

## Query Tool 与 EXPLAIN 可视化

Query Tool 是主战场。选中一段 SQL 按 `F5` 执行，结果在下方数据网格展示。它对 `EXPLAIN` 的加成在于**图形化执行计划**：执行 `EXPLAIN ANALYZE ...` 后切到 Explan 图表页，计划树会按节点耗时、行数渲染成条形图，扫一眼就能找到最贵节点，比读文本计划快得多。

两个要知道的点：

- Query Tool 里执行 `EXPLAIN (ANALYZE)` 同样会**真实执行**语句，改数据前想清楚；
- 结果网格默认截断长文本、限制抓取行数，看到"截断"提示不代表数据只有这些，精确核对行数用 `SELECT count(*)`；
- 区分 **Execute**（把选中的语句交给服务端按普通 SQL 执行）与 **Execute as SQL script**（把整段当脚本批量发），写函数、存储过程时用后者才能带事务与多语句一次过。

## 连接失败的排查顺序

```plaintext
Authentication failed for user      → 密码错误，或该用户在 pg_hba 里没有匹配允许行
no pg_hba.conf entry for ...        → 来源地址不在 pg_hba.conf 里，先加规则再连
SSL error: certificate verify failed → SSL 模式设为 verify-ca/verify-full 而证书链不全，
                                        要么改 require，要么补上 CA 证书
timeout / connection refused         → 端口没监听或防火墙没放行，先 nc -vz host 5432
```

pgAdmin 在服务器注册界面可以单独设置 SSL 模式（Preferences → Servers → SSL），语义与命令行驱动的 `sslmode` 一致，认证规则与允许来源的判定逻辑见[pg_hba 与认证](../security/pg-hba-and-authentication)。

## Dashboard 与活动监控

选中一个 Server，右侧 Dashboard 面板给出三块信息：连接活动图（每秒事务数、元组读写）、Server Activity（当前会话列表、锁、预定义的"长事务""空闲连接"视图）。排查"数据库突然变慢"时，先在这里确认活跃会话数和有没有跑了几十分钟的事务，再切 psql 用 [pg_stat_activity](./troubleshooting-toolbox) 抓细节。Dashboard 的数据就是 `pg_stat_activity` 等系统视图的图形化，刷新间隔可在 File → Preferences 里调。

## 对象维护与查询历史

右键对象（数据库、schema、表）可以调出 **Maintenance** 对话框，对数据库执行 VACUUM、对表执行 ANALYZE，不必手写命令行；适合给刚建好索引的表立刻跑一次 `ANALYZE` 让优化器拿到统计信息。

会锁写、需要占空间的 `VACUUM FULL`、`REINDEX` 不在界面里做，要自己在命令行执行并挑低峰时段，见[vacuum 与死元组](../internals/vacuum-and-hot)。

Query Tool 会把历史查询保留在本地，排障时可以翻出上次跑过的语句接着改，比从零重写快。

## 备份与恢复界面

右键任意对象（库、schema、表）→ Backup/Restore，底层调用的是 `pg_dump`/`pg_restore`/`psql`，界面上选格式与选项：

- 备份 Format 选 **Custom**，恢复时可选择性还原单个对象，且支持并行；
- 恢复前确认目标对象的处理方式（Data-only / Schema-only / 是否清理已有对象）；
- 界面左下角会显示实际执行的命令行，复杂场景直接照抄到服务器上跑更稳。

网页界面备份大库受浏览器与 pgAdmin 服务端限制，大库备份建议在服务器上直接跑 `pg_dump`。

## 常用设置与坑

- **Auto commit**：Query Tool 默认自动提交，单条 DML 立即生效；关掉它之后记得手动点 Commit，否则事务一直挂着，数据库里留下 `idle in transaction` 会话。
- **查询超时**：pgAdmin 本身不限制语句执行时长，超时要靠数据库侧控制——会话里 `SET statement_timeout = '30s'`，或对角色 `ALTER ROLE analyst SET statement_timeout = '30s'`。
- **只读需求**：pgAdmin 没有"只读模式"开关，给分析同学用的连接应该直接用只读角色（只授予 SELECT 权限，或设置 `default_transaction_read_only = on`），见 [角色与权限](../security/roles-and-permissions)。
- **误操作防线**：Preferences → Query Tool 里可以打开"确认关闭有未提交事务的标签页"，对习惯手动提交的人值得开。
- **中文乱码**：先看会话编码 `SHOW client_encoding;` 是否为 UTF8；客户端与数据库编码不一致时导出 CSV 会出现乱码，改连接设置而不是改数据。

pgAdmin 的定位是"图形管理台"：建表、看依赖、跑备份、值班排查都顺手；高频写 SQL 的开发流程用 IDE 插件或 DBeaver 更轻快（见 [DBeaver 与 VS Code 插件](./dbeaver-and-vscode)）。

## 参考资料

- [PostgreSQL 官方文档 · psql](https://www.postgresql.org/docs/current/app-psql.html)
- [PostgreSQL 官方文档 · F.32. pg_stat_statements — track statistics of SQL planning and execution](https://www.postgresql.org/docs/current/pgstatstatements.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [psql 高阶](./psql-advanced)
- [DBeaver 与 VS Code 插件](./dbeaver-and-vscode)
- [排障工具箱](./troubleshooting-toolbox)
- [角色与权限](../security/roles-and-permissions)
- [dbeaver-and-vscode](dbeaver-and-vscode.md)
- [index](index.md)
官方文档：[pgAdmin 4 文档](https://www.pgadmin.org/docs/pgadmin4/latest/)。
