# 第1部分：基础知识

从「PostgreSQL 是什么」到能独立完成建库、查询、事务与排错的最小闭环。本部分假设读者有基本编程经验，不需要数据库背景。

- [什么是 PostgreSQL](what-is-postgresql.md) —— 历史、许可、ACID 与 MVCC 取向、生态位。
- [安装与快速上手](install-and-quickstart.md) —— apt/yum/Homebrew/Windows 安装、initdb 初始化集群、跑通第一条查询。
- [psql 入门](psql-getting-started.md) —— 连接参数、`\dt`/`\d`/`\timing`/`\x` 等元命令、psqlrc 个性化。
- [数据库与 schema 对象](database-and-schema-objects.md) —— cluster/database/schema/table 层级、owner、search_path。
- [数据类型总览](data-types-overview.md) —— 数值/文本/时间/布尔/UUID，serial 与 identity 的取舍。
- [特色类型入门](special-types-intro.md) —— JSONB、数组、range、枚举、复合类型的最小可用知识。
- [CRUD 与 ON CONFLICT](crud-and-on-conflict.md) —— INSERT/UPDATE/DELETE、UPSERT、RETURNING。
- [WHERE 与表达式](where-and-expressions.md) —— 比较、LIKE/ILIKE、IN、NULL 语义。
- [聚合与 GROUP BY](aggregate-and-group-by.md) —— 聚合函数、HAVING、FILTER、分组空值。
- [JOIN 全家族](join-family.md) —— inner/left/right/full/cross、USING/NATURAL、自连接。
- [函数与运算符](functions-and-operators.md) —— `::` 强转、COALESCE、SQL 与 PL/pgSQL 函数入门。
- [事务入门](transaction-basics.md) —— BEGIN/COMMIT/ROLLBACK、SAVEPOINT、DDL 也可回滚。
- [常用系统表与元数据](system-catalogs-and-metadata.md) —— pg_class/pg_tables/information_schema 与表大小查询。
- [命名与书写规范](naming-and-style-conventions.md) —— 大小写折叠规则、双引号陷阱、命名与风格约定。
- [常见新手错误](common-beginner-mistakes.md) —— NULL 比较、隐式转换、时区等高频坑位清单。

---

- [知识点整理](../knowledge.md) —— 全站复习主线。
