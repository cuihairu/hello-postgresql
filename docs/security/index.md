# 安全

角色权限、行级安全、认证与加密、审计与加固清单。

- [角色与权限模型](roles-and-permissions.md) —— ROLE/GRANT/REVOKE、NOLOGIN/SUPERUSER 属性。
- [对象授权层级](object-grant-hierarchy.md) —— 库/schema/表/列授权、默认权限。
- [行级安全 RLS](row-level-security.md) —— policy、USING/FOR CHECK、与角色组合。
- [pg_hba 与认证](pg-hba-and-authentication.md) —— method 顺序、hostssl、scram、拒绝排查。
- [SSL 与传输加密](ssl-and-transport-encryption.md) —— 配置、证书、强制加密。
- [数据静态加密](data-encryption-at-rest.md) —— pgcrypto、密钥管理、备份加密。
- [审计](audit.md) —— pgaudit、日志开关、statement 归档。
- [加固清单](hardening-checklist.md) —— 最小权限、禁超级用户应用连接、扩展白名单。

---

- [架构与部署](../operations/) —— 网络与部署面的安全配套。
