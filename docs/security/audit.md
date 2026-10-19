# 审计

审计要回答的问题是：谁、在什么时候、对哪类对象做了什么。PostgreSQL 有两条实现路线：内核日志参数（零依赖、粒度粗）与 pgaudit 扩展（细粒度、输出结构化）。两者都只是"产生日志"，真正决定审计质量的是日志如何被采集和保存——这里按参数、扩展、采集、合规组合的顺序展开。

## 先分清两条路线

- **日志参数**：内核自带，`log_statement` 一开就能记录语句，但没有结构化的会话元数据、没有对象级过滤，量大时开销显著。
- **pgaudit 扩展**：按会话或对象细粒度记录，输出标准化的 AUDIT 行，便于解析归档，是合规场景的事实标准（未进内核，随各发行版打包）。

两条路线互补而不是二选一：慢查询排障用 `log_min_duration_statement`，合规审计用 pgaudit；不要为了审计把 `log_statement = all` 常年开着。

## 内置日志参数与成本

```plaintext
# postgresql.conf
log_connections = on                 # 连接建立记一行：来源 IP、用户、库
log_disconnections = on              # 断开记一行：含会话时长
log_duration = off                   # 每条语句只记耗时不含文本，噪音大，一般关
log_min_duration_statement = 500ms   # 超过阈值的语句连同文本与参数一起记录
log_statement = none                 # none / ddl / mod / all
```

`log_statement` 各档含义：`none` 只记错误；`ddl` 记 CREATE/ALTER/DROP；`mod` 额外记 INSERT/UPDATE/DELETE/TRUNCATE/COPY；`all` 记全部语句。成本依次递增，高频 OLTP 上 `all` 会明显拖慢吞吐并撑爆磁盘，且它**不记录绑定参数值**（文本里只有占位符）。`log_min_duration_statement = 0` 等效于记录所有语句（含参数），与 `log_statement = all` 同开会把语句记两遍——选一条路线即可。

## pgaudit：会话审计与对象审计

```plaintext
# postgresql.conf，改 shared_preload_libraries 需重启
shared_preload_libraries = 'pgaudit'
pgaudit.log = 'write, ddl, role'    # 写操作 + DDL + 角色变更
pgaudit.log_catalog = off           # 不记录对 pg_catalog 的访问，降噪
pgaudit.log_parameter = on          # 记录绑定参数（日志含业务数据，慎开）
```

```sql
CREATE EXTENSION pgaudit;   -- 对象级审计必须建扩展；仅会话级审计可以不建
```

会话审计按类别记录，日志行形如（示意）：

```plaintext
AUDIT: SESSION,1,1,WRITE,UPDATE,TABLE,public.orders,
  UPDATE orders SET status = 'paid' WHERE id = 42,<not logged>
```

字段依次为：审计类别（SESSION/OBJECT）、语句序号、子语句序号、命令类别、命令、对象类型、对象名、参数、语句文本。对象级审计用"授权即审计"的模式：把敏感对象授给一个专用角色，`pgaudit.role` 指向它，该对象的访问就会以 OBJECT 记录：

```sql
CREATE ROLE auditor NOLOGIN;
ALTER DATABASE appdb SET pgaudit.role = 'auditor';
GRANT SELECT ON payment_cards TO auditor;   -- 此后 payment_cards 的读取被审计
```

对象审计的价值是"只记要紧的表"，比全量 SESSION 记录低一个数量级的存储与检索成本。

## 日志格式与采集：csvlog 与 jsonlog

纯文本日志难以可靠解析，审计日志建议直接结构化输出：

```plaintext
logging_collector = on
log_destination = 'csvlog'     # PG 15+ 可用 'jsonlog'，采集管道更友好
log_directory = 'log'
log_rotation_age = 1d
log_rotation_size = 100MB
```

csvlog / jsonlog 的每行自带时间戳、会话 ID、PID、用户、数据库、客户端地址、语句文本等固定字段，filebeat / vector / fluent-bit 这类采集器可以直接映射成检索引擎的字段。**会话 ID** 能把"连接建立 → 多条语句 → 断开"串成完整轨迹，跨行追踪靠它；`log_connections`/`log_disconnections` 记录的行也带同一会话 ID。

## 合规场景的建议组合

| 场景 | 建议组合 |
| --- | --- |
| 日常巡检 / 排障 | `log_connections = on` + `log_min_duration_statement = 500ms`，不开 pgaudit |
| 等保 / ISO 27001 常规要求 | pgaudit `write, ddl, role` + `log_connections/disconnections` + 远端归档 |
| 高敏感数据（支付 / 医疗） | pgaudit 全类别 + `pgaudit.log_parameter = on` + 对象级审计覆盖敏感表 + 评估日志脱敏 |

## 保留与防篡改：交给外部归档

本机日志文件由 postgres 进程写入，实例被入侵或文件被删时保护有限。防篡改的思路是"**离开本机越快越好**"：采集器准实时（秒级）推送到远端；远端用追加写对象存储（如 S3 Object Lock / WORM）或专用日志平台保存；保留期按合规要求定（常见 6 个月到 3 年），到期删除的动作本身也要留痕。本机日志只当缓冲：确认 `log_truncate_on_rotation = on` 的同时，监控"日志文件最后上传时间"，采集断链产生的审计空洞比没有日志更危险。这部分与 [监控与告警](../operations/monitoring-and-alerting)共用同一套采集基础设施。

## 注意事项与常见坑

- `shared_preload_libraries` 改动需要重启，pgaudit 上线要安排停机窗口；只 `CREATE EXTENSION` 不预载，对象审计不工作。
- `pgaudit.log_parameter = on` 会把查询参数（可能含个人数据）写进审计日志，日志访问权限要相应收紧，或先做脱敏评估。
- `log_statement = all` 是性能与磁盘的双重陷阱，长期审计需求交给 pgaudit 或对象级方案。
- jsonlog 是 PG 15+ 才有的 `log_destination` 选项，老版本用 csvlog；两者都要求 `logging_collector = on`。
- `log_min_duration_statement` 按完成时间记录，被取消的查询不落日志，不能拿它做完整审计。
- 上线前先在测试环境跑一遍，确认审计输出内容（尤其参数与语句文本）符合预期，再定采集与脱敏策略。

## 参考资料

- [PostgreSQL 官方文档 · 5.9. Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [PostgreSQL 官方文档 · 20.3. Authentication Methods](https://www.postgresql.org/docs/current/auth-methods.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [pg_hba 与认证](./pg-hba-and-authentication)
- [加固清单](./hardening-checklist)
- [监控与告警](../operations/monitoring-and-alerting)
- [pg_stat 观测](../internals/pg-stat-observation)
- [extension-management](/ecosystem/extension-management.md)
- [data-encryption-at-rest](data-encryption-at-rest.md)
- [hardening-checklist](hardening-checklist.md)
- [index](index.md)
官方文档：[错误报告与日志](https://www.postgresql.org/docs/current/runtime-config-logging.html)、[日志文件格式（csvlog/jsonlog）](https://www.postgresql.org/docs/current/runtime-config-logging.html#RUNTIME-CONFIG-LOGGING-CSVLOG)、[pgaudit](https://github.com/pgaudit/pgaudit)。
