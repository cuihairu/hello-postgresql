# 常用系统表与元数据

PostgreSQL 把"数据库里有哪些表、哪些列、哪些索引"这些元信息也当作普通数据存放在系统目录（system catalog）里。它们本质上就是普通表，你可以直接 `SELECT`、`JOIN`、`WHERE`，甚至给它们建视图。我在排障、生成代码和写运维脚本时常查目录：`\d`、`\dt` 这些 psql 元命令，底层其实就是对目录的封装查询。这里先列三类常用速查视图，再记录 `pg_class/pg_attribute/pg_namespace` 的 OID 世界观，以及 `information_schema`、表大小统计、`COMMENT ON`。

## 速查视图：pg_tables / pg_indexes / pg_sequences

这三个视图对 `pg_class` 做了人性化包装，字段名直白，是日常最常用的入口：

```sql
-- 当前数据库（search_path 可见）的普通表与行数估计
SELECT schemaname, tablename, tableowner, hasindexes
FROM   pg_tables
WHERE  schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER  BY schemaname, tablename;

-- 每张表的索引清单
SELECT schemaname, tablename, indexname, indexdef
FROM   pg_indexes
WHERE  schemaname = 'public'
ORDER  BY tablename, indexname;

-- 序列当前值、增量与上限
SELECT sequencename, data_type, increment_by, min_value, max_value, last_value
FROM   pg_sequences
WHERE  schemaname = 'public';
```

`pg_sequences` 里的 `last_value` 是**已分配出去的最大值**，`next_value` 是下一个会分配的值。排障时常用来检查"序列是否落后于已有数据"或"是否接近 integer 上限"。

## pg_class / pg_attribute / pg_namespace：OID 世界观

PostgreSQL 内部一切对象都有唯一标识 `OID`（Object Identifier），系统目录靠 OID 相互引用，而非名字。这是理解目录查询的关键：

- `pg_class`：所有"关系"对象——表、索引、视图、物化视图、序列、TOAST 表都在这一张表里，用 `relkind` 区分（`r` 普通表、`i` 索引、`v` 视图、`m` 物化视图、`S` 序列、`p` 分区表、`t` TOAST）。
- `pg_attribute`：列定义。**系统列也在里面**，所以查列清单时必须过滤 `attnum > 0 AND NOT attisdropped`。
- `pg_namespace`：schema（命名空间）。表、函数都挂在某个 namespace 下。
- `pg_type`、`pg_proc`、`pg_constraint`、`pg_index`、`pg_description` 等同样是按 OID 关联的目录。

三者关联的标准查询模式：

```sql
SELECT n.nspname        AS schema,
       c.relname        AS table_name,
       a.attname        AS column_name,
       format_type(a.atttypid, a.atttypmod) AS data_type,
       a.attnotnull     AS not_null
FROM   pg_class      c
JOIN   pg_namespace  n ON n.oid = c.relnamespace
JOIN   pg_attribute  a ON a.attrelid = c.oid
WHERE  c.relkind = 'r'                 -- 普通表
  AND  n.nspname = 'public'
  AND  a.attnum > 0                    -- 排除系统列
  AND  NOT a.attisdropped              -- 排除已删除列
ORDER  BY c.relname, a.attnum;
```

`format_type()` 把内部类型 OID 翻译成可读字符串（含 `varchar(50)` 这类长度修饰）。知道这套 OID 关联后，`pg_constraint`、`pg_index` 的查询也就有章可循了。完整目录清单见 [pg_catalog 文档](https://www.postgresql.org/docs/current/catalogs.html)。

## information_schema：跨库标准但慢且信息少

`information_schema` 是 SQL 标准定义的元数据视图集，在 MySQL、SQL Server 等数据库里同名同结构，适合写跨库通用代码：

```sql
SELECT table_schema, table_name, table_type
FROM   information_schema.tables
WHERE  table_schema = 'public'
ORDER  BY table_name;

SELECT column_name, data_type, is_nullable, column_default
FROM   information_schema.columns
WHERE  table_schema = 'public' AND table_name = 'users'
ORDER  BY ordinal_position;
```

局限也很明确：

- **信息少**：PostgreSQL 特有概念（分区、TOAST、`relkind`、并行与统计信息）在标准里没有对应字段，查不到就要回落 `pg_catalog`。
- **慢**：视图里叠了多层权限过滤与类型展开，大库上比直接查 `pg_catalog` 慢一个量级。
- **权限过滤**：只显示当前用户可见的对象，DBA 日常排障建议直接用 `pg_catalog`。

## `\d+` 与目录查询对照

psql 元命令是目录查询的"语法糖"，两者结果等价。用 `psql -E` 启动可以让 psql 打印它实际发出的 SQL，便于熟悉目录查询：

```plaintext
\d+ users                          -- 表结构 + 注释 + 存储 + 压缩
\dt+ public.*                      -- 列出表及大小
\di+ users_*                       -- 列出索引及大小
\dn+                               -- 列出 schema
\df+ deduct                        -- 函数定义（含函数体）
\l+                                -- 数据库列表与大小
\dT+ text                          -- 类型与操作符
```

对照关系举例：`\d+ users` 底层是一条 `pg_class` + `pg_attribute` + `pg_type` + `pg_constraint` 的多表 JOIN；`\dt+` 则是 `pg_class relkind='r'` 加上 `pg_total_relation_size()`。记住这条对应关系，当 `\d` 不够用时就知道该查哪个目录。

## 查表大小：pg_total_relation_size

表在磁盘上的占用分三层，函数也分三个粒度：

```sql
-- 需要表结构
CREATE TABLE demo (id int PRIMARY KEY, payload text);
INSERT INTO demo SELECT g, repeat('x', 100) FROM generate_series(1, 10000) g;

SELECT pg_total_relation_size('demo')          AS total_bytes,   -- 表+索引+TOAST
       pg_relation_size('demo')                AS heap_bytes,    -- 仅主表（堆）
       pg_indexes_size('demo')                 AS index_bytes,   -- 所有索引
       pg_size_pretty(pg_total_relation_size('demo')) AS pretty;  -- 人类可读
```

- `pg_total_relation_size()`：主表 + 所有索引 + TOAST，排障最常用。
- `pg_relation_size()`：只有堆数据，用来分析"表本身 vs 索引"的比例。
- `pg_size_pretty()`：把字节数转成 `MB/GB`，通常包在最外层做展示。

查整库所有表大小排行：

```sql
SELECT n.nspname                AS schema,
       c.relname                AS table_name,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
       c.reltuples::bigint      AS est_rows          -- 统计信息里的估计行数
FROM   pg_class c
JOIN   pg_namespace n ON n.oid = c.relnamespace
WHERE  c.relkind = 'r' AND n.nspname = 'public'
ORDER  BY pg_total_relation_size(c.oid) DESC
LIMIT  20;
```

注意 `reltuples` 是 `ANALYZE` 时的估计值，不是精确行数；要精确值用 `count(*)`，但大表代价高，见 [pg_stat 观测](../internals/pg-stat-observation)。

## 列注释：COMMENT ON

PostgreSQL 没有单独的"表注释"语法（不像 MySQL 的 `COMMENT '...'` 写在 DDL 里），而是用独立的 `COMMENT ON` 语句，注释存进 `pg_description` 目录，`\d+` 会展示出来：

```sql
COMMENT ON TABLE  demo                 IS '演示表：批量插入与目录查询示例';
COMMENT ON COLUMN demo.payload         IS '模拟大字段，观察 TOAST 行为';
COMMENT ON COLUMN demo.id              IS '主键，业务无关自增';
COMMENT ON INDEX  demo_pkey            IS '主键索引';

SELECT c.relname, d.description
FROM   pg_description d
JOIN   pg_class c ON c.oid = d.objoid
WHERE  c.relname = 'demo';
```

规范团队通常要求关键业务表都写注释，并用迁移脚本维护，这样 `pg_dump` 时 `--no-comments` 之外默认会保留注释，配合代码生成器能让 ORM 字段说明自动同步。

## 注意事项与常见坑

- 系统目录是普通表，但**不要直接 UPDATE/DELETE**，也不要在其中建索引，只读即可。改结构请走 `ALTER` 等 DDL。
- `pg_class.relnatts` 记录列数，但**不包含**已被 `ALTER TABLE DROP COLUMN` 掉的列；判断"实际存在多少列"要过滤 `pg_attribute.attisdropped`。
- `pg_stat_user_tables` 是统计视图，重启后计数从 0 累计；而 `pg_class.reltuples` 在没有 `ANALYZE` 时可能是 `-1` 或陈旧值，判断行数别直接拿它当事实。
- `pg_total_relation_size()` 只算对象自身，不包含**分区表**的子分区大小。分区表求总大小要 `SUM` 每个分区的 `pg_total_relation_size()`，或查 `pg_partition_tree()` 递归聚合。
- `information_schema.columns.data_type` 对用户自定义类型只会显示 `USER-DEFINED`，此时要回落 `pg_attribute` + `pg_type` 查真实类型名。

## 参考资料

- [PostgreSQL 官方文档 · Part I. Tutorial](https://www.postgresql.org/docs/current/tutorial.html)
- [PostgreSQL 官方文档 · The SQL Language](https://www.postgresql.org/docs/current/sql.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [psql 元命令参考](../appendix/psql-meta-command-reference)
- [数据库与模式对象](./database-and-schema-objects)
- [psql 常用操作](./psql-getting-started)
- [pg_stat 观测体系](../internals/pg-stat-observation)
- [index](index.md)
- [naming-and-style-conventions](naming-and-style-conventions.md)
- [views-and-updatable-views](/database-design/views-and-updatable-views.md)
- [extension-management](/ecosystem/extension-management.md)