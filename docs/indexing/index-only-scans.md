# 仅索引扫描

普通索引扫描找到索引项后还要回表：拿着行指针去堆里取完整元组。仅索引扫描（Index Only Scan）跳过这一步——查询需要的所有列都直接从索引条目里读出来，堆页面完全不碰。代价是两个硬前提：**查询引用的列必须全部在索引里**，且**索引里没有可见性信息，要靠 visibility map 判断行是否可见**。第二个前提决定了它的实际效果和 vacuum 绑在一起。

## 一个可复现的对照

```sql
CREATE TABLE ios_demo (
    id    int PRIMARY KEY,
    flag  boolean NOT NULL,
    note  text
);

INSERT INTO ios_demo
SELECT g, g % 2 = 0, 'n' || g
FROM generate_series(1, 200000) g;

CREATE INDEX idx_ios_flag ON ios_demo (flag);

-- 关键一步：让 visibility map 全部置位
VACUUM ios_demo;

EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*) FROM ios_demo WHERE flag;
```

```plaintext
Aggregate
  ->  Index Only Scan using idx_ios_flag on ios_demo
        Heap Fetches: 0
        Buffers: shared hit=55
```

`Heap Fetches: 0` 表示一次堆元组都没碰：200000 行里一半命中 `flag = true`，但只读了 55 个索引缓冲页（加 visibility map 的少量页）。如果查询写成 `SELECT id, flag, note ...`，`note` 不在索引里，优化器只能退回普通 Index Scan 或顺序扫描——索引里凑不齐查询要的列，就谈不上「仅索引」。

## Heap Fetches 与 visibility map

索引条目里没有 MVCC 可见性信息（xmin/xmax 存在堆元组上，见 [MVCC 与多版本](../internals/mvcc-and-multi-version)），优化器无法仅凭索引判断「这条行对当前事务可见」。PostgreSQL 的解法是 visibility map：每张表的每个堆页面对应一个位，vacuum 时把「所有行对一切事务可见」的页置位（见 [VACUUM 与 HOT](../internals/vacuum-and-hot)）。

- 页面位已置位：索引条目直接采信，不回表。
- 位未置位：**必须回表**检查该行可见性——这就是 `Heap Fetches` 计数的来源。此时计划仍叫 Index Only Scan，但「仅索引」的收益已经流失。

把上面那张表改动一批行，再看计划：

```sql
UPDATE ios_demo SET note = note || 'x' WHERE id <= 50000;

-- 先不 VACUUM，直接看计划
EXPLAIN (ANALYZE)
SELECT count(*) FROM ios_demo WHERE flag;
-- Heap Fetches: 25000 左右
-- （id <= 50000 的行所在页失去 all-visible 位，其中 flag 为 true 的行全部回表）

VACUUM ios_demo;

EXPLAIN (ANALYZE)
SELECT count(*) FROM ios_demo WHERE flag;
-- Heap Fetches: 0       （visibility map 重新干净）
```

不需要改到行本身被索引的值：只要堆页面上有任何写入（哪怕 UPDATE 了没进索引的 `note` 列），该页的 all-visible 位就被清掉，之后每次仅索引扫描都要为这些行回表，直到下一次 vacuum。所以频繁更新的表上，Index Only Scan 往往「计划叫这个名字，实际干着普通索引扫描的活」。

## INCLUDE 扩展覆盖

`INCLUDE` 列进入索引存储但不参与键序（见[组合索引设计](./composite-index-design)），专门用来把 IOS 需要的列补齐而不打乱检索键：

```sql
CREATE TABLE orders_i (
    id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL,
    amount  numeric(10,2) NOT NULL,
    status  text NOT NULL
);

CREATE INDEX idx_orders_i_user
    ON orders_i (user_id) INCLUDE (amount, status);

EXPLAIN
SELECT amount, status FROM orders_i WHERE user_id = 42;
-- Index Only Scan using idx_orders_i_user（vacuum 后 Heap Fetches: 0）
```

`(user_id, amount, status)` 这种键列写法也能覆盖，但 INCLUDE 的语义更清晰：`amount`、`status` 只是「捎带存储」，B-tree 不为它们维护排序与查找，索引维护开销略低，也避免查询意外依赖它们的位置顺序。注意 INCLUDE 只有 B-tree（以及 GiST、SP-GiST 的部分算子类）支持。

## 索引类型支持范围

按官方口径：B-tree 无条件支持仅索引扫描；GiST、SP-GiST 仅部分算子类支持；GIN 的条目只存原值的一部分，不支持；BRIN 只存块区间摘要、Hash 只存哈希码，同样无法从索引还原整行，均不支持。只有 B-tree/GiST/SP-GiST 支持 INCLUDE。也就是说「覆盖索引」这套优化在 jsonb、数组、全文检索场景（GIN）里基本不可用，需要覆盖时优先考虑 B-tree 表达式索引（见[表达式索引](./expression-indexes)）。

## 让 IOS 成立的运维手段

仅索引扫描的实际收益几乎完全由 visibility map 的干净程度决定，这把责任交给日常维护：

- **保证 autovacuum 追得上**：批量 UPDATE/DELETE 之后表长时间不 vacuum，`Heap Fetches` 会持续攀升。大表手动跑一次 `VACUUM (ANALYZE)` 是最直接的止血。
- **观测页面的 all-visible 比例**：

  ```sql
  SELECT relname, n_live_tup, n_dead_tup,
         last_autovacuum
  FROM pg_stat_user_tables
  WHERE relname = 'ios_demo';
  ```

- **长事务会拖住 vacuum 的清理进度**（旧快照让死元组无法回收、页面无法置位），排查 IOS 突然变慢时把长事务也列入嫌疑。
- 定期维护与膨胀治理见[索引膨胀与维护](./index-bloat-and-maintenance)——索引页密度下降同样会增加 IOS 要读的页数。

## 注意事项与常见坑

- `EXPLAIN` 不带 `ANALYZE` 时看不到 `Heap Fetches`，只看计划类型会误判「已经在用 IOS 所以很快」；评估必须 `EXPLAIN (ANALYZE, BUFFERS)`，方法见 [EXPLAIN ANALYZE 与 BUFFERS](../performance/explain-analyze-buffers)。
- `SELECT *` 与仅索引扫描天然互斥；想让热点查询吃到 IOS，先约束查询的列清单。
- `count(*)`、存在性判断、只取索引列的报表查询是 IOS 的最大受益者；低选择性 + 大表时收益尤其明显。
- 频繁更新的表不要为了 IOS 堆 INCLUDE 列：每多带一列，索引就多一分写放大，而 VM 长期不干净时这些投入换不来收益。

## 相关页面

- [组合索引设计](./composite-index-design) —— INCLUDE 列与键列的设计细节。
- [索引膨胀与维护](./index-bloat-and-maintenance) —— 索引页密度与 REINDEX 对 IOS 的影响。
- [VACUUM 与 HOT](../internals/vacuum-and-hot) —— visibility map 的产生机制。
- [EXPLAIN ANALYZE 与 BUFFERS](../performance/explain-analyze-buffers) —— 如何量化 Heap Fetches 的实际代价。

官方文档：[仅索引扫描与覆盖索引](https://www.postgresql.org/docs/current/indexes-index-only-scans.html)、[visibility map](https://www.postgresql.org/docs/current/storage-vm.html)。
