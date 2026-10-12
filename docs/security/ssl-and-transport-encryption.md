# SSL 与传输加密

默认情况下客户端与服务端之间的协议流量是明文：查询、参数、乃至认证协商过程都可能被链路上的设备看到。打开 TLS 后，传输加密由 OpenSSL 承担，服务端配置集中在 `postgresql.conf` 的 `ssl_*` 参数与 pg_hba 的 `hostssl` 记录两处；客户端怎么验证服务端身份，由 `sslmode` 的档位决定——只加密不验证，防不住中间人。

## 快速起步：生成证书并打开 ssl

测试或内网自签场景，一条 openssl 生成自签证书（生产建议用内部 CA 或受信证书）：

```bash
openssl req -new -x509 -days 365 -nodes -subj "/CN=db.internal" \
  -addext "subjectAltName=DNS:db.internal" \
  -keyout server.key -out server.crt
```

```plaintext
# postgresql.conf
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
ssl_min_protocol_version = 'TLSv1.2'
```

私钥属主必须是运行 postgres 的系统用户且权限 `0600`，否则启动报 `private key file has group or world access`。重启后用 `psql "host=db.internal sslmode=verify-full"` 验证，`\conninfo` 会显示当前连接是否加密及证书校验情况。

## ssl_min_protocol_version

PG 12 起默认 `TLSv1.2`（更早版本默认 TLSv1，老协议不应再开）。没有历史包袱建议直接卡在 `TLSv1.2`；确有旧客户端时先放低、再逐步迁移，并用 pg_hba 把旧客户端隔离到独立规则。对应的 `ssl_max_protocol_version` 默认为空（不设上限），一般不动。

## 在 pg_hba 里强制加密：hostssl

`ssl=on` 只是"允许"加密，客户端仍可走明文（`sslmode=prefer` 首选加密但失败会退回明文）。强制加密靠 pg_hba：所有业务规则写 `hostssl`，末尾用一条 `host all all 0.0.0.0/0 reject` 收尾，明文连接直接被拒。记录写法与顺序规则见 [pg_hba 与认证](./pg-hba-and-authentication)。

## 客户端 sslmode 六档语义

| sslmode | 加密 | 验证服务端证书 | 防中间人 |
| --- | --- | --- | --- |
| `disable` | 否 | — | 否 |
| `allow` | 先明文，失败再用 TLS | 否 | 否 |
| `prefer`（默认） | 先 TLS，失败退回明文 | 否 | 否 |
| `require` | 是 | 否 | 弱：不验证身份，中间人可出示自签证书 |
| `verify-ca` | 是 | 验证 CA 链 | 中：证书可信但不核对主机名 |
| `verify-full` | 是 | 验证 CA 链 + 主机名匹配 | 是 |

关键结论：`require` 只保证"这条连接加密了"，不确认对面是谁——攻击者出示自己的自签证书同样能建立加密连接并截获数据。生产环境的客户端应统一 `verify-full` 并分发受信 CA：`sslrootcert` 参数指定 CA 文件，PG 16 起支持 `sslrootcert=system` 直接使用操作系统的证书库，省去手动分发。

PG 17 给握手加了一个优化：libpq 新增连接参数 `sslnegotiation=direct`，客户端可在 TCP 连接上直接发起 TLS 握手，省掉传统方式里一次"先探询支不支持 SSL"的明文往返（需要两端 OpenSSL 3.2+ 的 ALPN 支持）。这是性能优化，与证书校验档位无关。

## 证书轮换：reload 即可，不必重启

服务端证书、私钥、CA 与吊销列表在**启动和每次 reload 配置时重新读取**，PG 10 起轮换证书无需重启：

```bash
cp new-server.crt $PGDATA/server.crt
cp new-server.key $PGDATA/server.key
chown postgres:postgres $PGDATA/server.*
chmod 600 $PGDATA/server.key
psql -U postgres -c "SELECT pg_reload_conf();"   # 新连接用新证书，已建立的连接不受影响
```

私钥带口令保护时，配合 `ssl_passphrase_command` 从密钥管理服务取口令，避免重启时无人值守卡在交互输入上。

## 观测连接加密状态：pg_stat_ssl

```sql
SELECT a.pid, a.usename, a.application_name, a.client_addr,
       s.ssl, s.version, s.cipher, s.bits
FROM pg_stat_activity a
JOIN pg_stat_ssl s USING (pid)
WHERE a.datname IS NOT NULL;
```

`ssl = f` 的行就是未加密的连接——按 `application_name` 和 `client_addr` 找到来源，把它的连接串补上 `verify-full`。这条查询适合作为安全巡检的固定项，纳入 [监控与告警](../operations/monitoring-and-alerting)定期执行。

## 注意事项与常见坑

- libpq 默认 `sslmode=prefer`：没配证书的集群开了 `ssl=on` 后，客户端多半已默认走 TLS，但"失败退明文"的语义仍然存在，要强制就用 `hostssl` + reject 收尾。
- 自签证书 + `sslmode=require` 只加密、不验证身份；要用 `verify-full` 就必须把证书的 SAN（subjectAltName）写成客户端实际连接的主机名，否则校验报错。
- 客户端证书认证（双向 TLS）是另一层：pg_hba 方法配 `cert`，客户端带 `sslcert`/`sslkey`，证书 CN 与数据库用户名匹配。
- 云数据库的 TLS 常在代理层终结，`pg_stat_ssl` 里的信息可能不反映完整链路，以云厂商文档为准。
- TLS 的性能开销通常在个位数百分比以内，配合连接池复用长连接后基本可忽略，不要为性能关闭加密。
- 证书过期忘记轮换会导致所有新连接失败，把到期时间纳入证书管理或用 cert-manager 之类自动签发。

## 相关页面

- [pg_hba 与认证](./pg-hba-and-authentication)
- [数据静态加密](./data-encryption-at-rest)
- [加固清单](./hardening-checklist)
- [监控与告警](../operations/monitoring-and-alerting)

官方文档：[SSL/TLS 支持](https://www.postgresql.org/docs/current/ssl-tcp.html)、[libpq SSL 支持](https://www.postgresql.org/docs/current/libpq-ssl.html)、[pg_stat_ssl](https://www.postgresql.org/docs/current/monitoring-stats.html)。
