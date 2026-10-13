# 数据静态加密

静态加密回答的问题是：磁盘被拿走（或云盘快照、备份文件被拖走）时，里面的数据文件、WAL、临时文件、备份是否可读。它与传输加密（[SSL 与传输加密](./ssl-and-transport-encryption)）互不替代：一个管"落盘"，一个管"在途"。

## 现状：内核没有内建 TDE

PostgreSQL 内核至今没有内建的透明数据加密（TDE）：数据文件与 WAL 均以明文落盘。社区围绕集群级 TDE 的讨论和补丁持续了很多年（密钥管理、性能、与复制/工具链的兼容是主要难点），官方内建方案截至撰写时仍无落地时间表。这决定了选型思路：

- **字段层加密**（pgcrypto）：精确、密文跟着数据走，但侵入应用、检索受限，适合少量高敏感列。
- **存储层加密**（LUKS / 云盘 KMS）：对数据库完全透明、覆盖全量文件，但只防"介质离开"，防不了拿到 OS root 的攻击者。

两者按威胁模型选，也可以叠加。云厂商提供的"数据库透明加密"托付的是平台侧密钥体系，本质是存储层方案。

## 字段级加密：pgcrypto

`pgcrypto` 扩展提供 OpenPGP 对称加密函数，适合身份证号、银行卡号这类列级敏感数据：

```sql
CREATE EXTENSION pgcrypto;

CREATE TABLE payment_cards (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  holder  text NOT NULL,
  card_no bytea NOT NULL      -- 密文是二进制，用 bytea 存
);

-- 写入：密钥经会话 GUC 注入，见下一节
INSERT INTO payment_cards (holder, card_no)
VALUES ('alice', pgp_sym_encrypt('6222 0000 1234 5678', current_setting('app.enc_key')));

-- 读取
SELECT holder,
       pgp_sym_decrypt(card_no, current_setting('app.enc_key')) AS card_no
FROM payment_cards
WHERE id = 1;
```

代价要想清楚：密文列上的普通索引对"按卡号查询"无效（等值条件必须先解密才能比较），`LIKE`、范围查询同理。需要按密文字段检索时，常见做法是另存一列 HMAC（带密钥的哈希）建索引做等值查找。所以 pgcrypto 适合"写多读少、按主键取"的少量敏感列，不适合整表加密。

## 密钥从哪来：不写进库，不进 SQL 文本

原则：密钥不落数据库（否则磁盘被拖走时密文和钥匙在一起），也不硬编码在 SQL 或代码里。常用做法是应用从 KMS / 密钥服务取密钥，通过会话 GUC 注入：

```sql
-- 连接建立后、业务查询前，由驱动或连接池钩子执行（参数绑定，密钥不进 SQL 文本）
SELECT set_config('app.enc_key', $1, true);   -- true = 仅当前事务，随事务结束消失
```

之后所有加解密封装统一走 `current_setting('app.enc_key')` 取值。密钥不出现在业务 SQL 文本里，`pg_stat_statements`、慢查询日志、审计日志里也就看不到它。更完整的封装是把加解密做成 `SECURITY DEFINER` 函数，应用只见明文接口、不接触密钥；密钥服务不可用时让注入失败，查询自然失败——失败方向要设计成"安全失败"。

## 存储层加密：文件系统与云盘

| 方案 | 覆盖范围 | 特点 | 局限 |
| --- | --- | --- | --- |
| LUKS / dm-crypt | 整块盘（数据目录、WAL、临时文件全在内） | 数据库完全无感；`cryptsetup` 配置一次 | 需 OS 运维配合；解密口令的管理同样要严谨 |
| ZFS 原生加密 | 数据集级 | 与快照/复制整合好 | 依赖 ZFS 生态 |
| 云盘加密（KMS） | EBS / Persistent Disk 等块设备 | 开关即用，性能影响小 | 防不了拿到 OS root 的攻击者；密钥操作受云平台控制 |

共同点：数据库进程看到的是明文，加密在块层完成，现代 CPU 有 AES-NI，性能损失通常很低。共同局限：**只要有 OS root 权限就能读到明文**——它防的是介质丢失、快照泄露、离线拖盘，不防入侵后的横向移动。

## 备份与 WAL 的加密

数据文件加密了，WAL 与备份的落点必须同样覆盖，否则备份服务器就是最容易被拖走的明文副本：

```bash
# 逻辑备份：导出即加密
pg_dump -Fc appdb | gpg --encrypt --recipient dba@corp.example > appdb.dump.gpg

# 恢复
gpg --decrypt appdb.dump.gpg | pg_restore -d appdb
```

物理备份与 WAL 归档建议直接写到加密存储：S3 类对象存储开启 SSE-KMS，或用支持加密的备份工具（WAL-G、pgBackRest 均支持客户端加密）。做 PITR 恢复演练（见 [灾难恢复演练](../operations/disaster-recovery-drills)）时，把"能否用现有密钥完成恢复"列入检查项——密钥丢了，加密备份等于数据丢了。

## 密钥轮换思路

- 字段级：密文行加 `key_version int` 列；轮换时新写入用新版本密钥，后台任务批量重加密旧数据，过渡期新旧两把密钥都可解密，完成后下线旧密钥。KMS 的密钥版本机制天然支撑这个流程。
- 存储层：LUKS 支持 `cryptsetup reencrypt` 在线重加密；云盘换 KMS 密钥通常要走"新盘 + 数据迁移"，低频但工作量大。
- WAL 无法事后重加密，依赖存储层密钥轮换，或用较短的归档保留期收缩暴露窗口。
- 任何轮换完成后都要用新密钥完整演练一次恢复，再废弃旧密钥。

## 注意事项与常见坑

- 把密钥拼接进 SQL 字符串会将其写进日志与 `pg_stat_statements`，务必用绑定参数或会话 GUC 注入。
- 密文列用 `text` 存会踩编码坑，用 `bytea`；解密函数对损坏的密文直接报错，读取路径要有异常处理。
- "盘加密了、备份没加密"是高频遗漏，把备份纳入同一个加密策略。
- pgcrypto 还有 `digest` / `hmac` / `crypt` 等函数：密码哈希存储用 `crypt + gen_salt('bf')`，不要用 `md5()` 函数族。
- 加密不等于审计：谁在什么时候解密过哪些数据，要靠 [审计](./audit)回答。

## 参考资料

- [PostgreSQL 官方文档 · 5.9. Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [PostgreSQL 官方文档 · 20.3. Authentication Methods](https://www.postgresql.org/docs/current/auth-methods.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [SSL 与传输加密](./ssl-and-transport-encryption)
- [备份策略](../operations/backup-strategy)
- [灾难恢复演练](../operations/disaster-recovery-drills)
- [加固清单](./hardening-checklist)
- [hardening-checklist](hardening-checklist.md)
- [index](index.md)
- [ssl-and-transport-encryption](ssl-and-transport-encryption.md)
官方文档：[pgcrypto](https://www.postgresql.org/docs/current/pgcrypto.html)、[加密选项](https://www.postgresql.org/docs/current/encryption-options.html)。
