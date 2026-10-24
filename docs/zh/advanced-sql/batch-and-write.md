# 批量与写入

单行 `INSERT` 循环一万次和一次写入一万行，相差的往往不是一个常数而是量级——因为每条语句都有解析、规划、事务提交、WAL 刷盘的固定开销。这里整理服务端 `COPY` 与客户端 `\copy` 的分工、多值 INSERT 的用法与上限、批量 upsert 的冲突语义、UNLOGGED 表的适用场景，以及大表批量删除的分批策略。

## 示例表

```sql
CREATE TABLE readings (
    meter_id   bigint      NOT NULL,
    read_at    timestamptz NOT NULL,
    value      numeric(12,3) NOT NULL,
    status     text        NOT NULL DEFAULT 'ok',
    PRIMARY KEY (meter_id, read_at)
);
```

## COPY：服务端批量加载的主通道

`COPY` 走流式协议，一次解析整份数据、按块写 WAL，绕过了逐条语句的解析与规划开销，这正是它与逐行 INSERT 相差一个量级的原因——INSERT 的成本里每行都要摊一份语句处理和（默认提交模式下）WAL 等待，COPY 把这些固定成本摊到整批上。

```sql
-- 服务端 COPY：读取数据库进程有权限的文件（需超级用户或 pg_read_server_files）
COPY readings FROM '/data/readings.csv' WITH (FORMAT csv, HEADER true);

-- 导出到服务端文件
COPY (SELECT * FROM readings WHERE read_at >= '2026-01-01')
TO '/data/jan.csv' WITH (FORMAT csv, HEADER true);
```

`HEADER true` 表示文件第一行是列名，跳过不当作数据；配合 `DELIMITER`、`QUOTE`、`NULL '字符串'` 选项可处理各种方言的 CSV。错误处理上，COPY 默认**一条坏行就整体失败**——它是单条语句，没有「跳过坏行继续」的官方开关，脏数据多的文件要先清洗或先载入 staging 表再校验。

## \copy：psql 客户端版本

`\copy` 是 psql 的元命令，数据经客户端中转，读写的是**运行 psql 的那台机器**上的文件，不需要数据库服务端权限：

```plaintext
\copy readings FROM '/local/readings.csv' WITH (FORMAT csv, HEADER true)
\copy (SELECT * FROM readings WHERE meter_id = 7) TO '/local/m7.csv' WITH (FORMAT csv, HEADER true)
```

三条实用差异：`\copy` 与语句的对应规则是「元命令必须在同一行写完」，`\copy ... to` 后面的查询不能换行；它失败时 psql 默认继续执行后续语句，脚本里要检查 `\if` 或看退出码；权限上它只需客户端文件的读写权与目标表的 DML 权限。图形客户端（DBeaver、pgAdmin）的导入功能底层多数也是 COPY 路径。

## INSERT 多值与一次多行

不便用 COPY 时（数据在程序内存里、或经由 ORM），至少把逐行 INSERT 合并成多值形式：

```sql
INSERT INTO readings (meter_id, read_at, value) VALUES
    (1, '2026-01-05 00:00:00+08', 100.500),
    (1, '2026-01-05 01:00:00+08', 101.200),
    (2, '2026-01-05 00:00:00+08',  55.010);
```

工程上常见上限：单条语句的总长度受参数上限约束（协议层面单条 Bind 消息上限 1GB，实践中以 thousands 到数万行为一档比较稳）；更好的做法是 `INSERT ... SELECT` 从 `unnest` 数组或 `generate_series` 生成行，避免拼接巨型 SQL 文本：

```sql
INSERT INTO readings (meter_id, read_at, value)
SELECT m, read_at, round((random()*500)::numeric, 3)
FROM generate_series(1, 3) AS m,
     generate_series('2026-01-05'::timestamptz, '2026-01-05 05:00:00+08', interval '1 hour') AS read_at;
```

## 批量 upsert 与冲突语义

`ON CONFLICT` 在批量写入里最常用，但要分清「冲突检测目标」：

```sql
INSERT INTO readings (meter_id, read_at, value, status)
VALUES
    (1, '2026-01-05 00:00:00+08', 999.999, 'corrected'),
    (3, '2026-01-05 00:00:00+08',  12.500, 'ok')
ON CONFLICT (meter_id, read_at)              -- 指定唯一约束/索引列
DO UPDATE SET value = EXCLUDED.value,
              status = EXCLUDED.status;
```

- `ON CONFLICT (cols)` 只对匹配该列集合的唯一索引生效；`ON CONFLICT DO NOTHING` 不写目标则对**任意**唯一冲突都跳过。
- 冲突行为是**逐行判定**的：`DO UPDATE` 时批内两行撞同一个键同样会报错（`ON CONFLICT DO UPDATE command cannot affect row a second time`），不能靠它去重自身；`DO NOTHING` 则没有这个限制，重复行静默跳过。
- 整条语句是原子的：任何一行遇到无法用 DO UPDATE 消化的冲突（比如同时违反另一个约束），**整个语句回滚**，不是只回滚那一行。依赖这个语义做幂等导入时，导入脚本要能整体重试。

还有一点常被误解：`DO UPDATE` 的分支无论是否真正更新，都会执行一次「尝试更新」，若表上有更新触发器或希望「值没变就别动」，用 `DO UPDATE SET ... WHERE readings.value IS DISTINCT FROM EXCLUDED.value` 加条件，或确认 PG 15+ 的 `MERGE` 是否更贴合语义，见 [MERGE 与写入放大优化](/zh/performance/write-throughput-optimization)。

## UNLOGGED 表一瞥

不写 WAL 的表，写入速度接近内存速度，代价是崩溃后数据被清空、不参与流复制：

```sql
CREATE UNLOGGED TABLE staging_readings (LIKE readings INCLUDING ALL);
```

典型用途是「导入中转表」：先 COPY 进 unlogged staging，校验后再成批 `INSERT INTO ... SELECT` 进正式表。它不是省掉正式表 WAL 的手段，只适合可重建的临时数据，详细取舍见 [写入吞吐优化](/zh/performance/write-throughput-optimization)。

## 批量删除分批

一次性 `DELETE FROM readings WHERE read_at < '2025-01-01'` 删几千万行的问题是：长事务、巨量 WAL、索引膨胀、复制延迟。改成小批量循环：

```sql
-- 方式一：LIMIT 子查询，按主键驱动（最通用）
DELETE FROM readings
WHERE (meter_id, read_at) IN (
    SELECT meter_id, read_at
    FROM readings
    WHERE read_at < '2025-01-01'
    LIMIT 10000
);
-- psql 里 \watch 1 循环执行，或在应用/脚本里循环到 0 行

-- 方式二：按 ctid 分批（ctid 只在同一条语句内稳定，所以子查询和 DELETE 必须同语句）
DELETE FROM readings
WHERE ctid IN (SELECT ctid FROM readings WHERE read_at < '2025-01-01' LIMIT 10000);
```

两批之间留间隔，让 autovacuum 有机会清理死元组，避免表与索引持续膨胀；分区表则优先 `DROP PARTITION` 直接跳过逐行删除，见 [表继承与分区设计](/zh/database-design/table-inheritance-and-partitioning-design)。

## 注意事项与常见坑

- 服务端 `COPY ... FROM` 与客户端 `\copy` 的语法差异容易混：`\copy` 后面的文件路径永远相对于 psql 客户端进程。
- 批量 upsert 的 `EXCLUDED` 引用的是「本行试图插入的新值」，在 `DO UPDATE SET` 里与旧值对比时注意 NULL 语义用 `IS DISTINCT FROM`。
- 多值 INSERT 一条几万行时，语句解析与锁持有时间变长，失败重试的粒度也大；按几千行分片更稳。
- 批量删除循环里若用 `OFFSET` 翻页会越删越慢（前缀重复扫描），用主键或 ctid 定位下一批起点。
- COPY 到含触发器/生成列的表时，生成列不允许出现在列清单里，会直接报错。

## 参考资料

- [PostgreSQL 官方文档 · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL 官方文档 · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [CRUD 与 ON CONFLICT](/zh/basics/crud-and-on-conflict)
- [写入吞吐优化](/zh/performance/write-throughput-optimization)
- [表继承与分区设计](/zh/database-design/table-inheritance-and-partitioning-design)
- [psql 进阶用法](/zh/tools/psql-advanced)
- [cte-and-non-recursive-with](/zh/advanced-sql/cte-and-non-recursive-with)
- [index](/zh/advanced-sql/index)
- [sql-functions-advanced](/zh/advanced-sql/sql-functions-advanced)
- [crud-and-on-conflict](/zh/basics/crud-and-on-conflict)
- [anti-patterns](/zh/database-design/anti-patterns)
- [soft-delete-and-tombstone](/zh/database-design/soft-delete-and-tombstone)
- [postgresql-17-features](/zh/ecosystem/postgresql-17-features)
- [logical-replication-ops](/zh/operations/logical-replication-ops)
- [connection-and-orm-optimization](/zh/performance/connection-and-orm-optimization)
- [write-throughput-optimization](/zh/performance/write-throughput-optimization)
- [client-drivers](/zh/tools/client-drivers)
- [real-world-cases](/zh/tools/real-world-cases)
官方文档：[COPY](https://www.postgresql.org/docs/current/sql-copy.html)、[INSERT 的 ON CONFLICT 子句](https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT)、[CREATE UNLOGGED TABLE](https://www.postgresql.org/docs/current/sql-createtable.html#SQL-CREATETABLE-UNLOGGED)。
