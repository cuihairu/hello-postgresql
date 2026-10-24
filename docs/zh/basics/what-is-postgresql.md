# 什么是 PostgreSQL

PostgreSQL（常缩写为 PG、pg，口语读作 "post-gres-Q-L"）是一个开源的对象-关系数据库管理系统。它源自加州大学伯克利分校的 POSTGRES 项目，1996 年 7 月起以 PostgreSQL 名称对外发布，三十年来由全球开发者社区维护，版本号沿用了 PostgreSQL 16 / 17 这样的主线。它不是某个公司的产品，也没有单一厂商控制它的演进方向。

## 历史脉络

- **1986–1994：Berkeley POSTGRES**。Michael Stonebraker 教授在 Ingres 项目之后主导了 POSTGRES 研究，目标是支持复杂数据类型、用户自定义类型、规则系统（rule system）和关系表的继承。这个阶段的系统用一种叫 QUEL 的查询语言。
- **1995：Postgres95**。伯克利的学生 Andrew Yu 与 Jolly Chen 把 QUEL 换成了 SQL 接口，项目改名 Postgres95，代码以 BSD 风格许可发布。Stonebraker 也在同期基于 POSTGRES 创办了商业公司 Illustra（后被 Informix 收购）。
- **1996 至今：PostgreSQL**。以 Marc G. Fournier、Thomas Lockhart、Vadim Mikheev 为首的开源团队接手代码，项目正式定名 PostgreSQL，采用 PostgreSQL License。社区此后以"每年一个主版本 + 不定期小版本"的节奏演进。

官方对这段历史的叙述见 [A Brief History of PostgreSQL](https://www.postgresql.org/docs/current/history.html)。

## 许可：PostgreSQL License

PostgreSQL 使用 PostgreSQL License，属于类 BSD 的宽松许可：

- 允许免费用于商业闭源产品，也允许修改后闭源再分发；
- 允许改名发布，不要求保留商标（但官方不建议冒用 PostgreSQL 品牌）；
- 唯一义务是保留原始版权声明。

许可全文可查官方页面 [The PostgreSQL License](https://www.postgresql.org/about/licence/)。这意味着把 PostgreSQL 嵌入商业软件（包括云厂商的托管服务）几乎不受许可限制。相比之下 GPL 类数据库（如 MySQL 的企业版双许可）在商业分发上有额外约束。

## 标准兼容、ACID 与 MVCC

**标准 SQL 兼容度高。** PostgreSQL 长期把"贴近 SQL 标准"当作设计目标：窗口函数、CTE、递归查询、外连接、`FILTER` 子句、`NULLS FIRST/LAST` 排序等标准特性都在 PG 里以标准语法实现（个别标准函数用的是 PG 自己的名字，如 `string_agg` 对应标准里的 `LISTAGG`）。在 PG 里学到的 SQL 知识，迁移到其它数据库的成本也相对低。

**完整 ACID 支持。** 事务要么全做要么全不做（原子性），提交结果持久落盘（持久性），约束在事务内始终一致（一致性）。隔离级别从 `READ UNCOMMITTED` 到 `SERIALIZABLE` 可选（见下条）。

**MVCC：读写互不阻塞。** PostgreSQL 用多版本并发控制（Multi-Version Concurrency Control）：每一行数据可有多个历史版本，读操作读快照、写操作写新版本，读不阻塞写、写不阻塞读。默认隔离级别是 `READ COMMITTED`，可重复读与串行化用真正的快照/SSI 实现（而非 MySQL InnoDB 那种可重复读间隙锁语义）。原理细节见官方 [并发控制](https://www.postgresql.org/docs/current/mvcc.html) 一章与站内 [MVCC 与多版本](/zh/internals/mvcc-and-multi-version)。

## 对象-关系特性

PG 在关系模型之上允许"对象化"扩展：

- **自定义类型与函数**：可以用 SQL、C 或 PL/pgSQL 定义新类型、新运算符、新索引访问方法；
- **表继承**：子表自动拥有父表列，查询父表默认涵盖子表（现代实践中更多被声明式分区表取代）；
- **函数即一等公民**：支持高阶函数、窗口函数、聚合函数（含自定义聚合）、`LATERAL`；
- **丰富的内置类型**：JSONB、数组、range、hstore、网络地址（`inet`/`cidr`）、全文检索向量、地理几何（配合 PostGIS）等。

这些特性让 PG 既能做传统 OLTP 业务库，也能承载地理（PostGIS）、时序（TimescaleDB）、向量（pgvector）、文档（JSONB）等场景。

## 跑一段 SQL 感受特性

装好后（见下一页）在 psql 里执行下面这段自包含脚本，能直观看到 PG 的几个特色：复合类型、数组下标、JSONB 取值、range 类型与 `RETURNING`：

```sql
CREATE TABLE products (
    id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name     text        NOT NULL,
    tags     text[]      NOT NULL DEFAULT '{}',      -- 数组类型
    attrs    jsonb       NOT NULL DEFAULT '{}',      -- 文档存取
    price    numeric(10,2) NOT NULL,
    valid_during tstzrange NOT NULL                   -- 时间区间
);

INSERT INTO products (name, tags, attrs, price, valid_during) VALUES
    ('机械键盘', ARRAY['外设','办公'], '{"switch":"红轴","backlit":true}', 399.00,
     tstzrange('2026-01-01', '2026-12-31'))
RETURNING id, name, tags[1], attrs->>'switch', valid_during;

-- 区间包含：这行商品当前是否在售
SELECT name FROM products
WHERE valid_during @> now();

DROP TABLE products;
```

这段脚本无需任何扩展即可在 PG 13+ 上运行（`tstzrange` 是内置类型）。数组、JSONB、range 的完整用法见 [特色类型概览](/zh/basics/special-types-intro)。

## 生态位与选型

- **OLTP 业务库**：电商、支付、账号系统等强事务、强一致场景是它的主场；
- **分析 / OLAP**：借助并行查询、列存扩展（如 `cstore_fdw`）、`dw` 类扩展与外部表（FDW），也能跑分析型负载，但专用 OLAP 引擎（ClickHouse 等）在超大规模扫描上仍有优势；
- **地理**：PostGIS 是事实标准的空间数据库扩展；
- **时序**：TimescaleDB 在 PG 上提供时序压缩与连续聚合；
- **向量检索**：pgvector 让 PG 支持 embedding 相似度搜索，是 AI 应用的常见选择；
- **通用后端**：许多应用把 PG 当"一个库解决所有事"，避免引入多套异构存储。

## 与 MySQL 的粗略定位差异

| 维度 | PostgreSQL | MySQL（InnoDB） |
| --- | --- | --- |
| SQL 标准兼容 | 更贴近标准，复杂查询能力强 | 功能在补齐，部分方言特色 |
| 复杂查询 / 分析 | 强项（CTE、窗口、并行、丰富索引类型） | 较弱，通常把复杂计算放到应用层 |
| 数据完整性 | 约束、外键、可延迟约束、域类型都完整 | 外键在 InnoDB 支持但约束体系较弱 |
| 扩展性 | 扩展机制成熟，可深度定制 | 插件机制相对封闭 |
| 部署运维 | 单库为主，生态工具多 | 主从复制、国内中小项目常见 |
| 并发模型 | MVCC，读写不互相阻塞 | MVCC，间隙锁参与较多 |

一句话概括：业务逻辑复杂、需要强一致与复杂查询、希望一个库兼顾多种数据形态时，PG 往往是更顺手的起点；结构简单的 Web 应用、团队已深度使用 MySQL 工具链时，MySQL 也仍然常见。选型没有绝对答案，详见 [PostgreSQL 与 MySQL 对比](/zh/ecosystem/comparison-with-mysql)。

## 小结

- 出身学术（Berkeley POSTGRES），1996 年起叫 PostgreSQL，社区驱动；
- PostgreSQL License 类 BSD，商用分发宽松；
- 标准 SQL 兼容 + 完整 ACID + MVCC，读写不互相阻塞；
- 对象-关系特性让它从 OLTP 一路扩展到地理、时序、向量等生态。

## 参考资料

- [PostgreSQL 官方文档 · Chapter 13. Concurrency Control](https://www.postgresql.org/docs/current/mvcc.html)
- [PostgreSQL 官方文档 · Part I. Tutorial](https://www.postgresql.org/docs/current/tutorial.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [安装与首次连接](/zh/basics/install-and-quickstart)
- [psql 常用操作](/zh/basics/psql-getting-started)
- [数据库与 schema 对象](/zh/basics/database-and-schema-objects)
- [MVCC 与多版本](/zh/internals/mvcc-and-multi-version)
- [glossary](/zh/appendix/glossary)
- [index](/zh/basics/index)
- [install-and-quickstart](/zh/basics/install-and-quickstart)
- [when-to-choose-postgresql](/zh/ecosystem/when-to-choose-postgresql)