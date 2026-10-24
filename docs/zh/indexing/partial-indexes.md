# 部分索引

部分索引（partial index）在 `CREATE INDEX ... WHERE 谓词` 指定的行子集上建索引：索引文件里只有满足谓词的行，其他行完全不出现。当绝大多数查询只关心表中一小部分行（比如只查未完成订单、只查未删除数据）时，把这部分行单独收进一个小索引，能同时拿到更小的体积、更少的写放大和更集中的热点页。

## 谓词语义与匹配条件

先造一张有代表性的表：99% 的订单已完成，只有 1% 处于 pending。

```sql
CREATE TABLE orders_p (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     bigint NOT NULL,
    status      text   NOT NULL DEFAULT 'pending',
    amount      numeric(10,2) NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO orders_p (user_id, status, amount)
SELECT g % 1000,
       CASE WHEN g % 100 = 0 THEN 'pending' ELSE 'done' END,
       g::numeric
FROM generate_series(1, 100000) g;

CREATE INDEX idx_orders_pending ON orders_p (created_at) WHERE status = 'pending';
```

优化器能否使用部分索引，取决于**查询谓词是否蕴含索引谓词**：查询条件为真时，索引谓词必须必然为真。上例中 `WHERE status = 'pending'` 与索引谓词完全一致，直接命中：

```sql
EXPLAIN
SELECT id, user_id, amount
FROM orders_p
WHERE status = 'pending'
  AND created_at >= '2026-10-01';
```

```plaintext
Index Scan using idx_orders_pending on orders_p
  Index Cond: (created_at >= '2026-10-01 00:00:00+08')
```

注意计划里不再出现 `status` 过滤：凡是从这个索引里取出的行都必然满足 `status = 'pending'`，执行器无需复查。蕴含关系的证明发生在**计划期**，依据是查询 SQL 里写出的常量，与约束排除用的是同一套机制。

## 热点行：只索引未完成订单

订单表里历史订单只归档查询，活跃查询几乎全部集中在未完成的那一小撮。部分索引只收这些行，整个索引可能只有几百 KB，全部常驻内存：

```sql
-- 100000 行里只索引了 1000 行
SELECT pg_size_pretty(pg_relation_size('idx_orders_pending'));  -- 约 32 kB
SELECT pg_size_pretty(pg_relation_size('orders_p'));            -- 表本体是数 MB 量级

-- 只有 pending 行的写才会触碰这个索引
UPDATE orders_p SET amount = amount + 1 WHERE id = 7;    -- done 行：不写此索引
UPDATE orders_p SET status = 'paid' WHERE id = 10;       -- done -> paid：新旧值都不在谓词内，不写
UPDATE orders_p SET status = 'paid' WHERE id = 200;      -- pending -> paid：删一条旧项，不新增
```

全量索引在任何 UPDATE 时都可能产生索引项；部分索引把写放大限制在被谓词覆盖的行上。状态频繁翻转的行（pending -> paid -> done）在离开谓词范围后就不再给这个索引添写。

## 配合软删除：WHERE deleted_at IS NULL

软删除表（见[软删除与墓碑](/zh/database-design/soft-delete-and-tombstone)）的绝大多数查询都带 `deleted_at IS NULL`，已删除行只增不减，是部分索引的天然场景：

```sql
CREATE TABLE users_sd (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email       text NOT NULL,
    deleted_at  timestamptz
);

CREATE INDEX idx_users_sd_email
    ON users_sd (email)
    WHERE deleted_at IS NULL;
```

登录、注册查重、邮箱找回全都自动命中；已删除的账号不再占用索引空间。前提是查询里确实带着 `deleted_at IS NULL`——如果 ORM 的默认作用域会自动加这个条件，索引就能命中；哪条查询忘了加，既查到已删数据，也用不上索引，两头出问题。

## 体积与写放大

部分索引省的不只是磁盘：

- **缓存命中率**：小索引的叶子页常驻 shared buffers，查找几乎不产生物理读。
- **VACUUM / REINDEX 成本**：索引越小，清理和重建越快。
- **写路径**：不满足谓词的 INSERT/UPDATE 完全不触碰该索引；带多个部分索引时，一条 UPDATE 通常只会更新其中少数几个。

代价是维护两条「真相」：谓词条件写进了索引定义，业务上的状态集变化（新增一个 `processing` 状态也要走热点路径）时需要记得改索引谓词并重建。

## 用唯一部分索引做业务唯一约束

`UNIQUE` 部分索引是「范围内唯一」的标准实现——全表可以重复，谓词范围内不允许重复：

```sql
-- 每个用户同时只允许一个进行中订单
CREATE UNIQUE INDEX uniq_orders_user_pending
    ON orders_p (user_id)
    WHERE status = 'pending';

INSERT INTO orders_p (user_id, amount) VALUES (42, 9.90);          -- 成功
INSERT INTO orders_p (user_id, amount) VALUES (42, 5.00);          -- 报错
```

第二次插入得到 `ERROR: duplicate key value violates unique constraint "uniq_orders_user_pending"`。同样的手法可以表达「同一租户下未删除的邮箱唯一」「同一商品同一时段只有一个生效的促销」这类规则，比先查后插的应用层检查可靠得多——并发下应用层检查必然有竞态窗口。

## 谓词不匹配时索引用不上

蕴含关系稍有偏差，优化器就不会碰这个索引：

```sql
-- 匹配失败之一：条件比索引谓词更宽
EXPLAIN
SELECT count(*) FROM orders_p WHERE status IN ('pending', 'paid');
-- 谓词是 status = 'pending'，IN 两种状态不蕴含它 -> Seq Scan

-- 匹配失败之二：NOT IN / <> 无法被证明蕴含 =
EXPLAIN
SELECT count(*) FROM orders_p WHERE status <> 'done';
-- 同样 Seq Scan
```

这两条查询语义上都只涉及少量行，但优化器只做形式化的谓词蕴含证明，不会「猜」。要覆盖 `IN` 的写法，就把索引谓词也写成 `WHERE status IN ('pending', 'paid')`，查询与索引逐字对应最稳妥。

## 注意事项与常见坑

- **索引谓词必须是不可变表达式**。`now()`、`CURRENT_DATE` 这类随时间变化的函数不允许出现在谓词里，`WHERE created_at > now() - interval '7 days'` 会直接报错；固定日期常量（`WHERE created_at >= '2026-01-01'`）可以，但查询里必须写同一个常量才匹配。
- **绑定变量会破坏匹配**。`WHERE status = $1` 在生成通用计划时无法证明 `$1` 蕴含 `'pending'`，预编译语句、ORM 参数化查询可能绕开部分索引；遇到「手敲 SQL 走索引、程序里不走」，先查这里。
- **不要用部分索引替代分区**。谓词只是「索引里收不收这行」，数据仍全在同一张表里；按状态做查询隔离的需求到了数据量很大时，应考虑表分区。
- **统计信息按全表计算**。优化器知道部分索引只覆盖一部分行并据此估算，一般无需干预；但如果谓词列的统计严重过期，估算失真同样会导致弃用索引。

## 参考资料

- [PostgreSQL 官方文档 · Chapter 11. Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL 官方文档 · 11.2. Index Types](https://www.postgresql.org/docs/current/indexes-types.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [jsonb-design-patterns](/zh/advanced-sql/jsonb-design-patterns)
- [soft-delete-and-tombstone](/zh/database-design/soft-delete-and-tombstone)
- [pgvector](/zh/ecosystem/pgvector)
- [btree-structure](/zh/indexing/btree-structure)
- [composite-index-design](/zh/indexing/composite-index-design)
- [expression-indexes](/zh/indexing/expression-indexes)
- [index-failure-and-misuse](/zh/indexing/index-failure-and-misuse)
- [index](/zh/indexing/index)
- [slow-query-governance](/zh/performance/slow-query-governance)- [表达式索引](/zh/indexing/expression-indexes) —— WHERE 谓词里也常用表达式，两者可组合。
- [索引失效与误用](/zh/indexing/index-failure-and-misuse) —— 谓词不匹配是「用不上」的一种，还有更多形态。
- [软删除与墓碑](/zh/database-design/soft-delete-and-tombstone) —— `deleted_at` 方案的完整设计。
- [B-tree 结构与原则](/zh/indexing/btree-structure) —— 部分索引默认仍是最常用的 B-tree。

官方文档：[部分索引](https://www.postgresql.org/docs/current/indexes-partial.html)、[CREATE INDEX 谓词限制](https://www.postgresql.org/docs/current/sql-createindex.html)。
