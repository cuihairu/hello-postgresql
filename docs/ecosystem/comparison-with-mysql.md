# 与 MySQL 对比

PostgreSQL 和 MySQL 是关系型数据库里最常见的两个开源选择，多数后端团队迟早要回答「这个业务用哪个」。两者在基本 SQL、事务、主从复制这些主干的差异其实不大，真正的分野在架构模型、SQL 能力上限和类型系统的严格程度上。这里整理一份面向工程决策的对照，不做营销式结论；选哪个的判断框架见 [选型问答](./when-to-choose-postgresql)。

## 架构与连接模型

- **PostgreSQL：每连接一个进程**。每个连接对应一个后端进程，内存开销较大（`work_mem` 等按操作分配），几千个直连就要认真对待，通常配 PgBouncer 这类连接池，见 [连接管理](../operations/connection-management)。
- **MySQL：每连接一个线程**。线程更轻，直连承载量更高，线程池作为插件提供。

由此带来的运维差异：PG 生态里「应用必须走连接池」是默认共识；MySQL 场景里连接池同样有益，但不配也能跑，迁移到 PG 时直接把 MySQL 的连接使用习惯搬过来是常见的翻车点。

**存储引擎**：MySQL 是插件式引擎，InnoDB 为主，同库内不同表可混用 MyISAM/Memory 等引擎，特性随引擎而异；PostgreSQL 是单一引擎，所有表行为一致，不存在「选错引擎」的问题，代价是没有引擎级的选择自由（它的分层灵活性由表空间、分区、FDW、扩展承担）。

## SQL 能力

| 能力 | PostgreSQL | MySQL |
| --- | --- | --- |
| 窗口函数 / CTE | 8.4 / 9.1 起支持 | 8.0（2018）起支持 |
| JSON | JSONB 二进制类型，GIN 索引、`@>` 包含查询、path 查询 | JSON 类型，函数丰富，8.0.17 起有多值索引，无等价的包含索引 |
| 数组 / 范围 / 复合类型 | 原生支持，可建 GIN 索引 | 无 |
| 物化视图 | 原生支持（手动/定时刷新） | 无（普通视图是虚拟的） |
| 部分索引（Partial Index） | 支持 | 不支持（8.0 有函数索引） |
| `RETURNING` 子句 | 支持 | 不支持，取自增 ID 需另发查询 |
| upsert | `INSERT ... ON CONFLICT` | `INSERT ... ON DUPLICATE KEY UPDATE` |
| 全文检索 | tsvector/tsquery + 分词典，可排丰富度 | FULLTEXT 索引，CJK 需 ngram 插件 |

总体规律：MySQL 8.0 之后「主干 SQL 能力」已补齐（CTE、窗口、递归查询），PostgreSQL 的优势集中在「复合类型 + 索引能力」的组合——数组、JSONB、范围类型都能进索引并被查询算子直接消费，很多应用层数据加工可以下沉到 SQL。

## 复制与高可用

- **MySQL**：binlog 复制（statement/row/mixed 三种格式），默认异步，半同步可选项，GTID 定位事务；高可用成熟方案是 Orchestrator、InnoDB Cluster（组复制）等。
- **PostgreSQL**：物理流复制基于 WAL，整个实例级复制；`synchronous_commit` 提供从异步到 `remote_apply` 的连续光谱控制同步语义，见 [流复制与同步](../internals/streaming-replication-and-sync)；逻辑复制（PG 10+）按发布/订阅复制表级变更，可跨版本、可定向汇聚。两者都没有内建的多主，双向逻辑复制到 PG 17 才具备基础设施。

语义上的实际差别：PG 的 `remote_apply` 保证从库读到与主库一致的最新状态（写后读一致），MySQL 半同步只保证 binlog 已送达从库、不保证已回放。对「写完立刻在新会话读」的业务，PG 的配置空间更细。

## MVCC 与并发行为

- **MySQL（InnoDB）**：旧版本通过 undo log 重构，当前行留在原地，purge 线程异步清理；长事务会拖住 purge，表现为 history list 增长、undo 膨胀。
- **PostgreSQL**：新旧版本都留在堆里，vacuum 回收死元组；长事务同样危险——挡住 vacuum 导致表/索引膨胀，见 [MVCC 与多版本](../internals/mvcc-and-multi-version) 与 [vacuum 与 HOT](../internals/vacuum-and-hot)。

两边的教训一致：**长事务都是要消灭的**，只是症状不同。锁行为上，MySQL 默认隔离级别是 REPEATABLE READ，用 next-key 锁（间隙锁）阻止幻读，间隙锁本身是死锁的常见来源；PG 默认 READ COMMITTED，靠快照读、不做间隙锁，幻读在 RR 下仍可能发生，需要真串行化时用 SSI（可串行化快照隔离），见 [事务与隔离级别](../internals/transactions-and-isolation)。

## 类型系统

PostgreSQL 严格类型，MySQL 宽容隐式转换，这个差异在迁移和审计场景最容易被低估：

```sql
-- MySQL：字符串与数字比较发生隐式转换
SELECT * FROM users WHERE phone = 13800138000;   -- 索引失效，且 '13800138000abc' 也可能匹配
-- PostgreSQL：直接报错 operator does not exist，类型不匹配在开发期就暴露
```

- MySQL 有 `UNSIGNED` 类型、允许 `0000-00-00` 日期（非严格模式）；PG 都不接受，用 `CHECK (col >= 0)` 与约束替代。
- MySQL `TIMESTAMP` 有 1970–2038 范围限制且带时区转换行为；PG `timestamptz` 无此限制，类型选择见 [数据类型总览](../basics/data-types-overview)。
- 布尔在 MySQL 是 `tinyint(1)`，PG 是真正的 `boolean`，ORM 映射要注意。

## 从 MySQL 迁移：语法差异清单

| MySQL 写法 | PostgreSQL 对应写法 |
| --- | --- |
| `` `col` `` 反引号 | `"col"` 双引号；标识符建议直接小写不引用 |
| `LIMIT 5, 10` | `LIMIT 10 OFFSET 5`（`LIMIT n OFFSET m` 两边通用） |
| GROUP BY 带非聚合列（宽松模式） | 不允许；用 `any_value()`（PG 16+）、`max()` 或 `DISTINCT ON` |
| `AUTO_INCREMENT` | `GENERATED ALWAYS AS IDENTITY` |
| `INSERT IGNORE` | `INSERT ... ON CONFLICT DO NOTHING` |
| `ON DUPLICATE KEY UPDATE` | `INSERT ... ON CONFLICT (col) DO UPDATE ...` |
| `REPLACE INTO` | `ON CONFLICT DO UPDATE`（REPLACE 是删后插，副作用不同） |
| `LAST_INSERT_ID()` | `INSERT ... RETURNING id` |
| `DATE_FORMAT(d, '%Y-%m')` | `to_char(d, 'YYYY-MM')` |
| `DATEDIFF(a, b)` / `TIMESTAMPDIFF` | `a::date - b::date` / `age()`、`extract(epoch from ...)` |
| `UNIX_TIMESTAMP()` / `FROM_UNIXTIME(n)` | `extract(epoch from now())` / `to_timestamp(n)` |
| `IFNULL(a, b)` | `coalesce(a, b)`（两边都支持 COALESCE） |
| `a || b` 字符串连接 | PG 中 `||` 就是连接；MySQL 的 `\|\|` 默认是逻辑 OR，用 `CONCAT` |
| `#` 行注释 | 只支持 `--` |
| `UNSIGNED` / `ENGINE=InnoDB` / `CHARSET=utf8mb4` 表选项 | 删除；无符号用 CHECK 约束，编码在库级设定 |

`LIMIT n, m` 与日期函数是迁移脚本里出错率最高的两类；GROUP BY 宽松模式则属于「MySQL 一直带病运行、PG 直接拒收」的典型，迁移前建议先在 MySQL 开启 `ONLY_FULL_GROUP_BY` 跑一段时间回归。

## 生态与托管

两边的主流托管都很成熟：AWS RDS/Aurora、GCP Cloud SQL、阿里云 RDS 都同时提供两者。差异在长尾：PostgreSQL 的托管服务通常提供扩展白名单（pgvector、PostGIS 等逐渐标配），MySQL 托管的优势在部分国内团队的工具链熟悉度与既有运维资产。团队侧的权重往往比产品侧大：现有 DBA 技能、监控告警模板、备份演练脚本都是真实成本，评估时别只看产品特性表。

## 双栈共存建议

大型组织里两者长期共存是常态，比「统一到一个」更现实的约束是：

- **一个业务只选一个主库**，避免同一份数据双写两套数据库；
- 确实需要跨库查询时用 [FDW](./fdw-and-foreign-data) 做只读联合查询，而不是互相同步全量数据；
- 迁移决策看痛点：MySQL 团队频繁手工处理 JSON、数组、复杂报表时，PG 的 SQL 能力兑现为开发效率；反过来，团队 PG 经验为零而业务就是简单 CRUD，迁移收益覆盖不了学习与运维成本。

## 参考资料

- [wiki.postgresql.org/wiki/Foreign_data_wrappers](https://wiki.postgresql.org/wiki/Foreign_data_wrappers)
- [GitHub · pgvector/pgvector](https://github.com/pgvector/pgvector)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [选型问答](./when-to-choose-postgresql)
- [MVCC 与多版本](../internals/mvcc-and-multi-version)
- [数据类型总览](../basics/data-types-overview)
- [FDW 与外部数据](./fdw-and-foreign-data)
- [what-is-postgresql](/basics/what-is-postgresql.md)
- [index](index.md)
- [when-to-choose-postgresql](when-to-choose-postgresql.md)
- [knowledge](/knowledge.md)