# 加固清单

本页把安全部分散在各页的要点收成一份可执行的清单：每条给出操作命令，适合新环境上线前过一遍，也可以作为存量实例的季度巡检依据。条目背后的原理与完整说明见对应页面，这里只保留"做什么、怎么做"。

## 网络：缩小暴露面

**绑定内网地址，不监听 `0.0.0.0`**（纯本机应用只监听 localhost）：

```plaintext
# postgresql.conf
listen_addresses = '10.0.1.10'    # 内网 IP；仅本机用 'localhost'
```

**pg_hba 最小化**：删掉所有 `trust` 和过宽的网段规则，末尾默认拒绝：

```bash
grep -n "trust" "$(psql -U postgres -tAc 'SHOW hba_file')"   # 找出残留 trust
```

```plaintext
# pg_hba.conf 目标形态：精确网段 + 强制加密 + 默认拒绝
hostssl  app  app_rw  10.0.1.0/24  scram-sha-256
host     all  all      0.0.0.0/0    reject
```

**主机防火墙只对应用网段开放 5432**：

```bash
ufw allow from 10.0.1.0/24 to any port 5432 proto tcp
```

## 账号：不用超级用户跑应用

**禁止超级用户从网络登录**——超级用户绕过一切权限检查，GRANT/REVOKE 对它无效，只能靠 pg_hba 拦：

```plaintext
# pg_hba.conf：postgres 只允许本机 peer
local  all  postgres  peer
host   all  postgres  0.0.0.0/0  reject
```

**应用使用专用最小角色**，禁止直连 owner 或超级用户（角色拆分见 [角色与权限模型](./roles-and-permissions)）：

```sql
CREATE ROLE app_svc LOGIN PASSWORD '...' IN ROLE app_rw;
```

**密码走 SCRAM 并设置有效期**，复杂度用扩展兜底：

```sql
SET password_encryption = 'scram-sha-256';
ALTER ROLE app_svc PASSWORD '...' VALID UNTIL '2027-06-30';
```

```plaintext
# 弱密码直接拒绝：passwordcheck 扩展（需重启）
shared_preload_libraries = 'passwordcheck'
```

## 权限：从 PUBLIC 手里收回默认授权

**收回数据库连接与 public schema 的默认授权**（PG 15 之前的版本需手动补，PG 15 起 schema 的 CREATE 已默认收回，见 [对象授权层级](./object-grant-hierarchy)）：

```sql
REVOKE CONNECT ON DATABASE app FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

**敏感函数收回 PUBLIC 的 EXECUTE**：

```sql
REVOKE EXECUTE ON FUNCTION gen_token(text) FROM PUBLIC;
```

**用 DEFAULT PRIVILEGES 覆盖未来新建的对象**，避免新表裸奔：

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
```

**巡检业务角色不应持有的属性**（结果应为空）：

```sql
SELECT rolname, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
FROM pg_roles
WHERE rolcanlogin AND (rolcreatedb OR rolcreaterole
      OR rolreplication OR rolbypassrls OR rolsuper)
  AND rolname NOT IN ('postgres');
```

## 传输：强制 TLS

**服务端打开 ssl、下限 TLSv1.2，pg_hba 业务规则全部用 `hostssl`**（证书生成与轮换见 [SSL 与传输加密](./ssl-and-transport-encryption)）：

```plaintext
ssl = on
ssl_min_protocol_version = 'TLSv1.2'
```

**客户端连接串统一 `sslmode=verify-full`**，CA 用 `sslrootcert` 分发（PG 16+ 可用 `sslrootcert=system`），不允许回退到 `require` 及以下。

**巡检未加密连接并清零**（结果应为空）：

```sql
SELECT a.pid, a.usename, a.application_name, a.client_addr
FROM pg_stat_activity a
JOIN pg_stat_ssl s USING (pid)
WHERE a.datname IS NOT NULL AND NOT s.ssl;
```

## 数据：按敏感度选加密层

- 高敏感列用 pgcrypto 字段级加密，密钥经 KMS 注入，不落库不进日志（见 [数据静态加密](./data-encryption-at-rest)）。
- 数据目录所在卷启用 LUKS 或云盘加密，覆盖数据文件、WAL 与临时文件。
- 备份与 WAL 归档落加密存储，逻辑备份导出即加密：

```bash
pg_dump -Fc appdb | gpg --encrypt --recipient dba@corp.example > appdb.dump.gpg
```

## 配置：超时、日志与可加载库

**给业务角色设语句与事务超时**，防失控查询拖垮实例：

```sql
ALTER ROLE app_rw SET statement_timeout = '30s';
ALTER ROLE app_rw SET idle_in_transaction_session_timeout = '5min';
```

**打开基础审计参数并接入远端采集**（组合建议见 [审计](./audit)）：

```plaintext
log_connections = on
log_min_duration_statement = 500ms
```

**限制可加载库**：非超级用户只能加载 `local_preload_libraries` 白名单中、位于 `$libdir/plugins` 目录下的库——把允许普通用户会话加载的扩展收进该目录，其余一律拒绝，堵住第三方函数库的注入面。

**确认默认扩展面**：`available_extensions` 里多出来的不装、`pg_extension` 里没有的 不开，按需安装。

## 升级与漏洞跟踪

**订阅安全公告并跟踪版本**：[PostgreSQL 安全信息页](https://www.postgresql.org/support/security/) 与安全公告邮件列表，新 CVE 发布后通常几天内就有小版本。

**小版本（含 CVE 修复）及时打**：小版本升级不涉及数据格式转换，停机窗口通常只有一次重启的时间：

```bash
apt-get update && apt-get install --only-upgrade postgresql-17
systemctl restart postgresql
```

**巡检当前版本是否属于已知漏洞版本**：

```sql
SELECT version();   -- 对照安全公告核对具体小版本号
```

## 相关页面

- [角色与权限模型](./roles-and-permissions)
- [pg_hba 与认证](./pg-hba-and-authentication)
- [SSL 与传输加密](./ssl-and-transport-encryption)
- [审计](./audit)

官方文档：[服务端配置](https://www.postgresql.org/docs/current/runtime-config.html)、[安全公告](https://www.postgresql.org/support/security/)。
