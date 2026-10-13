# pg_hba 与认证

`pg_hba.conf` 是连接准入的第一道闸：每条连接进来，PostgreSQL 按文件里的记录**从上到下逐条匹配**，第一条命中的记录决定用什么方式验证，验证不过就拒绝，不会再往下找。因此顺序写错（宽规则在前）会让后面的收紧规则完全失效。认证管的是"你是谁"，登录后能访问什么由 [角色与权限模型](./roles-and-permissions)决定，传输是否加密见 [SSL 与传输加密](./ssl-and-transport-encryption)。

## 记录格式与匹配顺序

每条记录由五个字段组成：

```plaintext
# 类型     数据库     用户      来源地址         认证方法
hostssl   app       app_rw    10.0.1.0/24      scram-sha-256
host      all       all       0.0.0.0/0        reject
local     all       all                        peer
```

匹配规则：按文件顺序逐条比较"连接类型 + 目标数据库 + 用户名 + 来源地址"，**第一条全部匹配的记录生效**。数据库名可写 `all`、`sameuser`、`replication` 或逗号分隔的清单；用户名同理，`+组角色名` 表示该组的所有成员。修改后执行 `SELECT pg_reload_conf();`（或 `pg_ctl reload`）即生效，无需重启。

## 认证方法一览

| 方法 | 行为 | 适用场景 |
| --- | --- | --- |
| `trust` | 无条件放行，不验密码 | 仅限本机开发环境，生产禁用 |
| `reject` | 无条件拒绝 | 做黑名单、默认拒绝收尾 |
| `peer` | 仅本地 socket，校验 OS 用户名与数据库用户名一致 | 本机运维（postgres 用户） |
| `scram-sha-256` | SCRAM 挑战应答，密码不以明文过网络 | 生产网络认证首选 |
| `md5` | MD5 挑战应答，比明文强但算法已过时 | 兼容旧客户端 |
| `cert` | 校验客户端证书，CN 需匹配数据库用户 | 有成熟 PKI 的环境 |
| `gssapi` | Kerberos 票据认证 | 企业内网统一登录 |
| `password` | 密码明文传输 | 无正当理由不要出现 |

版本注意：`scram-sha-256` 自 PG 10 引入，PG 14 起新设密码默认按 SCRAM 哈希存储（此前默认 md5）。`md5` 与 `scram` 方法都要求服务端存有**对应形式**的密码哈希——这是最常见的坑，见下文排查一节。

## 本地 socket 与 peer：容器里身份对不上怎么办

`local` 记录只匹配 Unix domain socket 连接。`peer` 方法读取客户端进程的**操作系统用户名**（Linux 上通过 SO_PEERCRED），要求它与请求的数据库用户名相同——`postgres` 系统用户免密切换数据库 postgres 用户，其他 OS 用户则被拒，也可用 `map=` 选项配合 `pg_ident.conf` 做 OS 用户到数据库用户的映射。

容器场景常见错位：官方镜像里进程以 `postgres` 运行，本机 socket 连接没问题；但应用容器通过 TCP 连接，根本不走 `local` 记录。反过来，想在容器里用 `psql -U app` 直连 socket 时，容器内 OS 用户往往是 root，peer 直接失败。此时要么在容器里切到对应的 OS 用户，要么为该来源单独配 TCP + 密码认证的记录——不要图省事把 `local` 改成 `trust`。

## 地址写法与 hostssl / hostnossl

连接类型四种：`local`（socket）、`host`（TCP，加密与否都匹配）、`hostssl`（仅 TLS 连接）、`hostnossl`（仅非 TLS 连接）。地址用 CIDR 写法：`127.0.0.1/32`、`10.0.0.0/8`；IPv6 用 `::1/128`；`hostssl` 搭配服务端 `ssl=on` 是生产环境的标准写法，强制"这条规则只对加密连接生效"。

```plaintext
# 生产示例：本机 peer + 内网加密 + 复制专用 + 其余拒绝
local   all          postgres    peer
hostssl app          app_rw      10.0.1.0/24    scram-sha-256
hostssl replication  repl_user   10.0.1.20/32   scram-sha-256
host    all          all         0.0.0.0/0      reject
```

注意复制连接的数据库字段必须写关键字 `replication`，不能写具体库名。

## 改完先验证再 reload

```sql
-- 语法/格式错误不会阻止 reload，只会让坏记录被静默忽略
SELECT line_number, type, database, user_name, address, auth_method, error
FROM pg_hba_file_rules
WHERE error IS NOT NULL;

SELECT pg_reload_conf();
```

`pg_hba_file_rules` 视图解析的是**磁盘上的文件**而非当前生效的配置。新增记录后先查 `error IS NOT NULL` 再 reload，能避开"改了没反应"的一整类问题。

## 连接被拒的排查路径

两类典型报错，排查方向不同：

**1. `FATAL: no pg_hba.conf entry for host "x.x.x.x", user "...", database "..."`** —— 没有任何记录命中。按顺序检查：来源地址写法（掩码是否写对，`10.0.1.2` 少了 `/32` 会解析异常）、记录顺序（是否被前面的宽规则或 reject 提前命中）、连接类型（TCP 连接却只配了 `local`）。用 `pg_hba_file_rules` 视图核对每条记录实际解析成了什么。

**2. `FATAL: password authentication failed for user "..."`** —— 记录命中了，但密码验证失败。最常见的坑是**认证方法与密码哈希不一致**：pg_hba 写了 `scram-sha-256`，而账号密码还是 md5 时代的哈希（PG 14 升级后存量账号不会自动转换）。确认方法：

```sql
SELECT rolname, left(rolpassword, 12) AS hash_head
FROM pg_authid
WHERE rolname = 'app_rw';   -- SCRAM-SHA-256$ 开头 = scram；md5 开头 = 旧哈希
```

修复：让 `password_encryption` 与 pg_hba 方法一致后重设密码 `ALTER ROLE app_rw PASSWORD '...';` 再重试。密码本身没问题的话，打开 `log_connections` 复查服务端日志里该连接命中的记录与失败原因；老客户端驱动（PG 10 之前的 libpq 或未升级的第三方驱动）不支持 scram，也会以同样的报错表现出来。

## 注意事项与常见坑

- 宽规则排在前面会让后面所有收紧规则失效；文件末尾放一条 `host all all 0.0.0.0/0 reject` 收尾是最稳的结构。
- 残留的 `trust`（哪怕只对 127.0.0.1）可能被同主机的其他进程或容器"借用"，清理只需要一条 grep。
- pg_hba 只决定"怎么验证身份"，与对象权限无关；登录成功后能看什么，交给角色与授权体系。
- 每条连接都要完整跑一遍认证，pg_hba 记录过多或频繁 reload 有轻微开销，一般可忽略，但不要把 pg_hba 当业务限流用。
- 改文件不 reload 就生效不了，reload 了坏记录又被静默跳过——把 `pg_hba_file_rules` 检查固化进变更流程。

## 参考资料

- [PostgreSQL 官方文档 · 5.9. Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [PostgreSQL 官方文档 · 20.3. Authentication Methods](https://www.postgresql.org/docs/current/auth-methods.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [SSL 与传输加密](./ssl-and-transport-encryption)
- [角色与权限模型](./roles-and-permissions)
- [加固清单](./hardening-checklist)
- [常见报错与排查](../appendix/common-errors-and-troubleshooting)
- [knowledge](/knowledge.md)
- [audit](audit.md)
- [hardening-checklist](hardening-checklist.md)
- [index](index.md)
- [roles-and-permissions](roles-and-permissions.md)
- [row-level-security](row-level-security.md)
- [ssl-and-transport-encryption](ssl-and-transport-encryption.md)
- [dbeaver-and-vscode](/tools/dbeaver-and-vscode.md)
- [pgadmin-4](/tools/pgadmin-4.md)
官方文档：[pg_hba.conf 文件](https://www.postgresql.org/docs/current/auth-pg-hba-conf.html)、[认证方法](https://www.postgresql.org/docs/current/auth-methods.html)、[用户名映射](https://www.postgresql.org/docs/current/auth-username-maps.html)。
