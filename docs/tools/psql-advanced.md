# psql 高阶

入门篇讲过 `\d`、`\l`、`\copy` 这些基础元命令（见 [psql 入门](../basics/psql-getting-started)）。这一页讲让 psql 从"查询工具"变成"自动化工具"的几件武器：变量、`\gexec`、`\watch`。它们全部在 psql 客户端实现，不需要在服务器上装任何东西。

## 变量：\set 与 ：var

psql 维护一张客户端侧的变量表，`SELECT` 结果、连接参数、自定义值都可以放进去，再以 `:var` 形式替换回 SQL 文本：

```sql
-- 定义与使用（值是纯文本，不需要引号）
\set env 'prod'
\set page_size 50
SELECT * FROM orders ORDER BY id LIMIT :page_size;
\unset page_size          -- 删除变量

-- 变量替换进字符串或标识符时，必须用带引号的形式
-- :'var'  展开为带单引号的字符串字面量（自动转义内部引号，安全）
-- :"var"  展开为带双引号的标识符
SELECT * FROM :"schema_name".users WHERE note = :'env';
```

`:'var'` 会做正确的引号转义，因此把外部输入（文件名、筛选词）存进变量再引用是安全的；直接写 `:var` 则是原样替换，只适合数字和标识符。内置变量如 `:USER`、`:DBName`、`:PORT` 在连接后自动可用。

### \gset：把查询结果赋给变量

`\gset` 把**单行**查询结果按列名写入变量，这是构造"参数化脚本"的关键：

```sql
-- 取分页游标：下一页从哪个 id 开始
SELECT max(id) AS last_id FROM orders WHERE created_at < now() - interval '1 day' \gset

\echo 下一页起点: :last_id
SELECT * FROM orders WHERE id > :last_id ORDER BY id LIMIT 50;

-- 计算值也能进变量
SELECT count(*) AS total, pg_size_pretty(pg_total_relation_size('orders')) AS size \gset
```

查询返回 0 行时变量不会被赋值；返回多行只取第一行。配合 `\gset` 与 `:'var'`，一个 psql 脚本就能完成"查一步、算一步、再执行"的流程，不必写 Python。

## \gexec：把查询结果当 SQL 执行

`\gexec` 把当前查询结果的**每一行**作为一条命令发送执行。这是 psql 里做批量 DDL 的标准姿势——先用 SQL 写出要执行的语句列表，再交给 psql 执行：

```sql
-- 例 1：回收 business schema 下所有表的写权限
SELECT format('REVOKE INSERT, UPDATE, DELETE ON TABLE %I FROM app_write', tablename)
FROM pg_tables
WHERE schemaname = 'business' \gexec

-- 例 2：给所有外键列补索引（FK 列缺索引的经典排查动作）
SELECT format('CREATE INDEX IF NOT EXISTS idx_%s_%s ON %I(%I)',
              relname, attname, relname, attname)
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
JOIN pg_class r ON r.oid = c.conrelid
JOIN pg_namespace n ON n.oid = r.relnamespace
WHERE c.contype = 'f' AND n.nspname = 'business'
  AND NOT EXISTS (SELECT 1 FROM pg_index i
                  WHERE i.indrelid = c.conrelid AND a.attnum = ANY(i.indkey::int2[]))
\gexec
```

安全用法是**两段式**：先把同样的生成查询跑一遍（普通 `\g` 或直接回车执行），肉眼确认每一行都是想执行的语句，再补上 `\gexec` 重跑。`\gexec` 执行出错会立即停止后续行，可以配合 `\set ON_ERROR_STOP on` 让脚本整体失败。

## \watch：锚定观察一个查询

`\watch` 让 psql 周期性地重发当前查询缓冲并刷新结果，适合盯现场——观察锁队列、复制延迟、某条长查询的进度：

```sql
SELECT pid, state, wait_event_type, wait_event,
       now() - query_start AS runtime, left(query, 60) AS query
FROM pg_stat_activity
WHERE state <> 'idle' AND backend_type = 'client backend'
\watch i=2 c=30
```

参数形式 `i=` 间隔秒、`c=` 次数（PG 16 起），PG 17 又加了 `m=`（结果行数少于该值即停止，适合"等待某事件出现就退出"的场景）。`Ctrl-C` 随时中断；`:auto` 之类的变量不受影响，`\watch` 间隔小于查询耗时会出现查询排队，间隔别设得过小。

## \copy 与大对象

`\copy`（客户端侧导出导入）的权限模型和用法在 [psql 入门](../basics/psql-getting-started)讲过，这里补一个查询级导出的形式——导出的不是整张表而是任意结果集：

```sql
\copy (SELECT id, user_id, amount FROM orders WHERE created_at >= '2026-01-01')
      TO '/tmp/orders_2026.csv' WITH (FORMAT csv, HEADER true)
```

二进制大对象（LOB）有专门的元命令族，图片、PDF 这类文件可以存进 `pg_largeobject` 并在客户端与服务器间搬运：

```sql
\lo_import '/tmp/manual.pdf' '产品手册 v2'   -- 导入，返回 oid，可附注释
\lo_list                                     -- 列出现有大对象
\lo_export 16420 '/tmp/manual.pdf'           -- 按 oid 导出到本地
```

大对象写入要在事务里提交，单文件超过 1GB 时优先考虑 bytea 分片或对象存储，别把数据库当文件服务器。

## 输出控制：\timing、\x、\pset

三个开关覆盖日常输出的所有场景：

```sql
\timing on                -- 每条语句显示客户端往返耗时
\x auto                   -- 扩展显示：auto 模式下宽表自动转竖排
\pset null '(null)'       -- NULL 显示为 (null)，与空串区分
\pset format csv          -- 输出 CSV，方便贴给其他程序
\pset pager off           -- 关闭分页器，脚本里必备
\pset linestyle unicode   -- 表格线用 Unicode 字符，可读性更好
```

`-c` 一次性执行时，`\pset format csv` 加 `\g` 的组合可以直接产出管道友好的输出：`psql -c '\pset format csv' -c 'SELECT ...'`。`\timing` 计的是含网络往返的总时间，分析执行细节仍要用 `EXPLAIN (ANALYZE)`（见 [EXPLAIN 基础](../performance/explain-basics)）。

## psqlrc 启动文件

psql 每次启动会执行 `~/.psqlrc`（Windows 为 `%APPDATA%\postgresql\psqlrc.conf`），把上面这些开关固化进去：

```text
-- ~/.psqlrc
\set ON_ERROR_STOP on
\pset null '(null)'
\pset pager off
\timing on
\set PROMPT1 '%n@%/> '
```

运维脚本、CI 里跑 SQL 时要跳过它，加 `-X` 参数：`psql -X -f job.sql`——psqlrc 里任何输出性设置都会污染脚本输出，这是自动化场景的常见事故源。反过来，交互体验需要的别名、提示符都放 psqlrc，两者分清用途即可。

## 参考资料

- [PostgreSQL 官方文档 · psql](https://www.postgresql.org/docs/current/app-psql.html)
- [PostgreSQL 官方文档 · F.32. pg_stat_statements — track statistics of SQL planning and execution](https://www.postgresql.org/docs/current/pgstatstatements.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [psql 入门](../basics/psql-getting-started)
- [排障工具箱](./troubleshooting-toolbox)
- [本地开发环境](./local-dev-environment)
- [EXPLAIN 基础](../performance/explain-basics)
- [batch-and-write](/advanced-sql/batch-and-write.md)
- [psql-meta-command-reference](/appendix/psql-meta-command-reference.md)
- [psql-getting-started](/basics/psql-getting-started.md)
- [plan-cache-and-generic-plan](/internals/plan-cache-and-generic-plan.md)
- [dbeaver-and-vscode](dbeaver-and-vscode.md)
- [index](index.md)
- [local-dev-environment](local-dev-environment.md)
- [pgadmin-4](pgadmin-4.md)
- [troubleshooting-toolbox](troubleshooting-toolbox.md)
官方文档：[psql 命令参考](https://www.postgresql.org/docs/current/app-psql.html)、[大对象](https://www.postgresql.org/docs/current/largeobjects.html)。
