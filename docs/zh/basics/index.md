# 基础知识

这里汇集我处理建库、查询、事务和排错时常回看的基础记录；内容按主题排列，数据库背景不同也可以直接从具体问题查起。

- [什么是 PostgreSQL](/zh/basics/what-is-postgresql) —— 历史、许可、ACID 与 MVCC 取向、生态位。
- [安装与首次连接](/zh/basics/install-and-quickstart) —— apt/yum/Homebrew/Windows 安装、initdb 初始化集群、跑通第一条查询。
- [psql 常用操作](/zh/basics/psql-getting-started) —— 连接参数、`\dt`/`\d`/`\timing`/`\x` 等元命令、psqlrc 个性化。
- [数据库与 schema 对象](/zh/basics/database-and-schema-objects) —— cluster/database/schema/table 层级、owner、search_path。
- [数据类型总览](/zh/basics/data-types-overview) —— 数值/文本/时间/布尔/UUID，serial 与 identity 的取舍。
- [特色类型概览](/zh/basics/special-types-intro) —— JSONB、数组、range、枚举、复合类型的最小可用知识。
- [CRUD 与 ON CONFLICT](/zh/basics/crud-and-on-conflict) —— INSERT/UPDATE/DELETE、UPSERT、RETURNING。
- [WHERE 与表达式](/zh/basics/where-and-expressions) —— 比较、LIKE/ILIKE、IN、NULL 语义。
- [聚合与 GROUP BY](/zh/basics/aggregate-and-group-by) —— 聚合函数、HAVING、FILTER、分组空值。
- [JOIN 全家族](/zh/basics/join-family) —— inner/left/right/full/cross、USING/NATURAL、自连接。
- [函数与运算符](/zh/basics/functions-and-operators) —— `::` 强转、COALESCE、SQL 与 PL/pgSQL 函数基础。
- [事务基础](/zh/basics/transaction-basics) —— BEGIN/COMMIT/ROLLBACK、SAVEPOINT、DDL 也可回滚。
- [常用系统表与元数据](/zh/basics/system-catalogs-and-metadata) —— pg_class/pg_tables/information_schema 与表大小查询。
- [命名与书写规范](/zh/basics/naming-and-style-conventions) —— 大小写折叠规则、双引号陷阱、命名与风格约定。
- [常见踩坑](/zh/basics/common-beginner-mistakes) —— NULL 比较、隐式转换、时区等高频坑位清单。

---

- [开发者备忘](/zh/knowledge) —— 跨主题备忘。

<!-- BACKLINKS-AUTO -->
## 相关页面

- [index](/zh/advanced-sql/index)
- [index](/zh/database-design/index)
- [index](/zh/tools/index)
