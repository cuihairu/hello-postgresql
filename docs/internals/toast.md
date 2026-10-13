# TOAST

PostgreSQL 的页大小固定 8KB，一行元组原则上要装进单个页面。超长字段（`text`、`jsonb`、数组等可变长类型）不会被拒绝，而是被 TOAST（The Oversized-Attribute Storage Technique）自动压缩或搬进关联的 TOAST 表。整个过程对 SQL 完全透明，但存储位置与更新代价的差异，是很多"慢 UPDATE、表莫名变大"的根源。官方参考：[TOAST](https://www.postgresql.org/docs/current/storage-toast.html)。

## 大值去哪了：TOAST 表与分块

- 每张可能存大值的表都有一个伴生的 TOAST 表（schema `pg_toast`，名字形如 `pg_toast.pg_toast_<oid>`）和一个 btree 索引。
- 元组组装后若超过约 2KB（`toast_tuple_target`，默认 2000 字节），可 TOAST 的字段按存储策略先压缩、再考虑外置。
- 外置的大值切成约 2KB 一块（chunk）存进 TOAST 表，按 `(chunk_id, chunk_seq)` 通过索引读回；单个字段最大约 1GB。
- 压缩后的值即使留在主行内，也比原始值小得多，很多大字段根本不需要外置。

观测某张表的 TOAST 去向与实际占用：

```sql
CREATE TABLE docs (id int PRIMARY KEY, body text);
INSERT INTO docs VALUES (1, repeat('x', 500000));

SELECT reltoastrelid::regclass AS toast_table
FROM   pg_class
WHERE  relname = 'docs';                     -- pg_toast.pg_toast_16384

SELECT pg_size_pretty(pg_relation_size('docs'))       AS heap,
       pg_size_pretty(pg_total_relation_size('docs')) AS total;
-- heap 只有几 KB，大头在 TOAST 表里
```

## 四种存储策略

每个可变长列有一个存储策略，决定"压缩吗、外置吗"：

| 策略 | 压缩 | 外置 | 说明 |
| --- | --- | --- | --- |
| PLAIN | 否 | 否 | 定长类型（integer、timestamp 等）唯一选项 |
| EXTENDED | 先压缩 | 压缩后仍放不下才外置 | 绝大多数类型的默认值 |
| EXTERNAL | 否 | 行太宽时外置 | 跳过压缩省 CPU；外置后支持按块取子串 |
| MAIN | 先压缩 | 尽量内联，实在放不下才外置 | 强调留在主行 |

查看与修改：

```sql
-- attstorage: p=PLAIN, e=EXTERNAL, x=EXTENDED, m=MAIN
SELECT attname, attstorage
FROM   pg_attribute
WHERE  attrelid = 'docs'::regclass AND attname = 'body' AND NOT attisdropped;

ALTER TABLE docs ALTER COLUMN body SET STORAGE EXTERNAL;  -- 禁压缩
-- PG 14+ 可单独指定压缩算法：
ALTER TABLE docs ALTER COLUMN body SET COMPRESSION lz4;
```

**压缩算法**：传统只有 pglz；PG 14 起支持 lz4（解压快、CPU 占用低，压缩率略差），默认算法由 `default_toast_compression` 控制（仍为 pglz），可在列上覆盖。随机读多、解压在热点路径上的大字段值得试 lz4。

**EXTERNAL 的典型场景**：大 `text/jsonb` 写多读少、或经常只取前缀——外置且未压缩的值取子串（如 `left(body, 200)`）只需读前几个 chunk，不用解压整个值。

## 读取开销：自动解 TOAST

执行器读到带 TOAST 指针的列时才通过 TOAST 索引把所有 chunk 取回并解压（detoast）：

- 只有查询真正引用了大字段才触发；`SELECT id FROM docs` 完全不碰 TOAST。
- `SELECT *` 与 ORM 默认整行加载是最常见的意外 detoast 来源，网络传输还会被放大。
- 判断某列某行的实际磁盘大小：

```sql
SELECT id, pg_size_pretty(pg_column_size(body)) AS body_bytes FROM docs;
```

## 更新大字段：整块重写的代价

MVCC 的 `UPDATE` 写出新版本元组（见 [MVCC 与多版本](./mvcc-and-multi-version)），对 TOAST 的行为分两种：

- **改的是小列**：新元组直接引用旧 TOAST chunk，大值不重写；代价只是主行的新版本。
- **改的是大字段本身**：旧 chunk 全部作废，新值重新压缩、分块、写入。500KB 的字段改一个字符也是整个 500KB 重写，且旧 chunk 要等 VACUUM 回收（见 [VACUUM 与 HOT](./vacuum-and-hot)）。

```sql
UPDATE docs SET body = body || '!' WHERE id = 1;
SELECT pg_size_pretty(pg_total_relation_size('docs'));  -- 明显变大
VACUUM docs;                                            -- 回收旧 chunk 后回落
```

因此**高频更新的大字段应拆到单独的 1:1 子表**：

```sql
CREATE TABLE doc_bodies (
  doc_id int PRIMARY KEY REFERENCES docs(id),
  body   text
);
```

收益：主表更窄，每页放更多行，索引与顺序扫描都更快；更新主表的其他列不会碰 body；大字段只在真正需要时 join 出来。这与把"变长冷数据"分表存放的建模思路一致，见[逻辑到物理建模](../database-design/logical-to-physical-modeling)。

## 注意事项与常见坑

- `toast_tuple_target` 是表级存储参数（`ALTER TABLE t SET (toast_tuple_target = 128)`），降低外置阈值让更短的值也更早外置；除特殊场景外不必调整。
- **btree 索引项上限约 2704 字节**（约 1/3 页，8KB 页下）：给大 text 直接建普通索引会报 `index row size ... exceeds maximum`，应改用前缀/表达式索引或 GIN + pg_trgm，见 [GIN 索引](../indexing/gin)与[模式匹配](../advanced-sql/pattern-matching)。
- 监控膨胀时**别漏掉 TOAST 表**：`pg_total_relation_size` 已包含它，但逐表看 `pg_relation_size(reltoastrelid)` 更直观。
- `ORDER BY`、`DISTINCT`、join 键出现在大字段上时，每行都要 detoast，代价远超直觉。
- `VACUUM FULL`、`pg_dump`、逻辑复制都会整体搬运大字段，TOAST 巨大的表这些操作都慢。

## 参考资料

- [PostgreSQL 官方文档 · 66.2. TOAST](https://www.postgresql.org/docs/current/storage-toast.html)
- [PostgreSQL 官方文档 · Chapter 51. Overview of PostgreSQL Internals](https://www.postgresql.org/docs/current/overview.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [MVCC 与多版本](./mvcc-and-multi-version)
- [VACUUM 与 HOT](./vacuum-and-hot)
- [GIN 索引](../indexing/gin)
- [JSONB 操作](../advanced-sql/jsonb-operations)
- [array-operations](/advanced-sql/array-operations.md)
- [jsonb-operations](/advanced-sql/jsonb-operations.md)
- [data-types-overview](/basics/data-types-overview.md)
- [special-types-intro](/basics/special-types-intro.md)
- [index](index.md)
- [connection-and-orm-optimization](/performance/connection-and-orm-optimization.md)
官方文档参考：[TOAST](https://www.postgresql.org/docs/current/storage-toast.html)
