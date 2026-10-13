# psql 元命令速查

psql 里以反斜杠开头的命令是元命令，不走 SQL 解析器，直接操作客户端、连接与输出。记不全时用 `\?` 列出全部元命令，`\h 命令` 查某条 SQL 的语法帮助。以下按用途分五组，每条一句话。

## 连接与切换

| 元命令 | 用途 |
| --- | --- |
| `\c[onnect] db [user]` | 切换数据库，可同时换用户与连接串，如 `\c appdb app` |
| `\l[+]` | 列出全部数据库，`+` 追加编码、大小、表空间 |
| `\conninfo` | 显示当前连接的主机、端口、用户、数据库 |
| `\encoding [name]` | 查看或设置客户端编码 |
| `\password [user]` | 交互式修改角色密码 |
| `\q` | 退出 psql |

## 查看对象

| 元命令 | 用途 |
| --- | --- |
| `\d [name]` | 无参数列出当前库的关系（表、视图、物化视图、序列）；带参数显示该对象结构 |
| `\d+ [name]` | 同 `\d` 但追加存储、压缩、注释等细节 |
| `\dt[S+] [pattern]` | 列出表（`S` 含系统表） |
| `\di[S+] [pattern]` | 列出索引；`\di idx_name` 可看具体索引定义 |
| `\dv[S+] [pattern]` | 列出视图 |
| `\ds[S+] [pattern]` | 列出序列 |
| `\df[S+] [pattern]` | 列出函数，`+` 显示参数与定义位置 |
| `\dn[S+] [pattern]` | 列出 schema |
| `\du[S+] [pattern]` | 列出角色与属性 |
| `\dp [pattern]` / `\z` | 列出对象的访问权限（授权情况） |
| `\dx [pattern]` | 列出已安装扩展 |
| `\sf func_name` | 显示函数的完整定义 |

`\d` 后面跟不同字母即查看不同对象，pattern 支持 `schema.*` 这样的过滤：

```text
postgres=> \d+ users
                              Table "public.users"
   Column   |            Type             | Nullable | Default
------------+-----------------------------+----------+---------
 id         | bigint                         | not null| nextval(...)
 name       | text                        | not null|
Indexes:
    "users_pkey" PRIMARY KEY, btree (id)
```

## 输出与格式

| 元命令 | 用途 |
| --- | --- |
| `\x [on\|off\|auto]` | 扩展显示切换：宽表转竖排显示，只影响显示不影响数据 |
| `\timing [on\|off]` | 打开/关闭每条 SQL 的执行耗时 |
| `\pset option [value]` | 设置输出格式，如 `\pset pager off`、`\pset null '(null)'` |
| `\o [file]` | 把后续查询结果重定向到文件或管道 |
| `\copy ... {from\|to} ...` | 客户端侧的数据导入导出，权限模型比服务端 COPY 友好 |
| `\g [file\|command]` | 执行当前查询缓冲，结果可写入文件或管道 |

## 编辑与历史

| 元命令 | 用途 |
| --- | --- |
| `\e [file]` | 用 `EDITOR` 编辑器编辑查询缓冲（无参数）或指定文件 |
| `\watch [seconds]` | 周期性重复执行当前查询缓冲，默认 2 秒一次，适合盯 `pg_stat_activity` |
| `\p` | 打印当前查询缓冲内容 |
| `\r` | 清空（重置）当前查询缓冲 |
| `\s [file]` | 查看或保存命令历史 |
| `\w file` | 把当前查询缓冲写入文件 |

## 变量与执行

| 元命令 | 用途 |
| --- | --- |
| `\set name [value]` | 设置 psql 变量，SQL 中用 `:name` 或 `:'name'` 引用 |
| `\unset name` | 取消变量 |
| `\gset [prefix]` | 把单行查询结果存入 psql 变量，可指定前缀 |
| `\gexec` | 把查询结果的每一行当作一条新 SQL 发给服务器执行 |
| `\echo text` | 输出文本到 psql，调试脚本时常用 |
| `\warn text` | 输出文本到标准错误，脚本里做告警 |

`\gexec` 适合按查询结果批量建索引、改权限这类重复操作：

```text
postgres=> SELECT format('CREATE INDEX ON t (c%1$s)', i) FROM generate_series(1, 3) i \gexec
CREATE INDEX
CREATE INDEX
CREATE INDEX
```

`\copy` 与 `COPY` 的分工：`COPY` 由服务端读写文件（受 `superuser` 与目录权限限制），`\copy` 用当前系统用户身份在客户端侧读写：

```text
postgres=> \copy users TO '/tmp/users.csv' WITH (FORMAT csv, HEADER)
COPY 120
postgres=> \copy users FROM '/tmp/users_new.csv' WITH (FORMAT csv, HEADER)
COPY 5
```

## 快速排查组合

**登录即看版本与连接**（新环境先确认版本，很多语法与行为按版本不同）：

```bash
psql -h localhost -p 5432 -U postgres -d appdb -c "SELECT version();" -c "SELECT current_user, current_database();"
```

**找表与表结构**（确认表在哪、索引对不对）：

```text
appdb=> \dt+ public.*
appdb=> \d+ users
appdb=> \di users*
```

**看谁在跑、谁占着资源**（先分清 idle、idle in transaction 与 active）：

```sql
SELECT pid, state, wait_event_type, wait_event,
       now() - xact_start AS xact_age, left(query, 60) AS query
FROM pg_stat_activity
WHERE datname = current_database()
ORDER BY state, xact_start;
-- 需要干预时：SELECT pg_cancel_backend(pid);  取消该查询
-- 仍不退出：     SELECT pg_terminate_backend(pid);  断开该连接
```

## 参考资料

- [PostgreSQL 官方文档 · psql](https://www.postgresql.org/docs/current/app-psql.html)
- [PostgreSQL 官方文档 · SQL Commands](https://www.postgresql.org/docs/current/sql-commands.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [psql 入门](../basics/psql-getting-started)
- [psql 进阶用法](../tools/psql-advanced)
- [常见错误与排查对照表](./common-errors-and-troubleshooting)
- [监控与告警](../operations/monitoring-and-alerting)
- [index](index.md)
- [references-and-docs](references-and-docs.md)
- [psql-getting-started](/basics/psql-getting-started.md)
- [system-catalogs-and-metadata](/basics/system-catalogs-and-metadata.md)
官方文档：[psql 手册](https://www.postgresql.org/docs/current/app-psql.html)
