# EXPLAIN (ANALYZE, BUFFERS, WAL)

裸 `EXPLAIN` 只给估算；加上 `ANALYZE` 让语句真实执行一遍，计划里每个节点就有了实际耗时、实际行数和执行次数；再加 `BUFFERS` 能看到每个节点读了多少块、多少来自缓存、多少落了临时文件；`WAL`（PG 13+）还能统计写语句产生的日志量。这一页讲这套组合的用法、输出逐字段解读，以及两个高频误读：loops 乘法和临时文件。

## ANALYZE 会真实执行：写语句要包事务回滚

`EXPLAIN (ANALYZE)` 对语句做完整执行（结果集被丢弃，不返回给客户端），因此 UPDATE/DELETE/INSERT 会真的改数据、触发器会真的跑、副作用全部生效。调优写语句时，用事务包起来再回滚：

```sql
BEGIN;
EXPLAIN (ANALYZE, BUFFERS)
UPDATE orders SET status = 'paid' WHERE order_id = 12345;
ROLLBACK;   -- 数据恢复原样，但执行过程完整发生了一次
```

注意三点：回滚本身也产生 WAL 和死元组，别在高负载主库上随便跑；涉及序列 nextval 等非事务性副作用时回滚救不回来；带 `SELECT pg_sleep(...)` 或大 DML 的语句要认真估执行时长，避免锁住业务行。

## 完整样例：逐行解读

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT user_id, sum(amount)
FROM orders
WHERE created_at >= now() - interval '7 days'
GROUP BY user_id
ORDER BY sum(amount) DESC
LIMIT 20;
```

```plaintext
Limit (cost=20834.71..20834.76 rows=20 width=40) (actual time=41.219..41.226 rows=20 loops=1)
  Buffers: shared hit=5403
  ->  Sort (cost=20834.71..20860.82 rows=10443 width=40) (actual time=41.216..41.222 rows=20 loops=1)
        Sort Key: (sum(amount)) DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=5403
        ->  HashAggregate (cost=19727.50..19797.13 rows=10443 width=40) (actual time=38.910..40.501 rows=8932 loops=1)
              Group Key: user_id
              Batches: 1  Memory Usage: 1281kB
              Buffers: shared hit=5403
              ->  Seq Scan on orders
                    (cost=0.00..19144.58 rows=116583 width=14)
                    (actual time=0.011..20.555 rows=77778 loops=1)
                    Filter: (created_at >= (now() - '7 days'::interval))
                    Rows Removed by Filter: 922222
                    Buffers: shared hit=5403
Planning:
  Buffers: shared hit=36
Planning Time: 0.180 ms
Execution Time: 41.310 ms
```

逐行解读：

- **Seq Scan 节点**：数据来源。估算 116583 行、实际 77778 行，同一数量级，估算可信；`Rows Removed by Filter: 922222` 说明全表 100 万行里 92% 被过滤掉——如果这是高频查询，就是「该建索引」的直接证据。
- **HashAggregate 节点**：按 `user_id` 分组。`Batches: 1` 表示哈希表一次装进 work_mem（大于 1 说明分组落盘了）；`Memory Usage: 1281kB` 是实际占用。
- **Sort 节点**：按聚合结果倒序。`Sort Method: top-N heapsort` 是 LIMIT 20 触发的优化——只维护 20 行的小顶堆，而不是全量排序；没有 LIMIT 时会看到 `quicksort Memory: xxx`（内存排序）或 `external merge Disk: xxx`（落盘）。
- **每个节点的 Buffers**：整条路径 shared hit=5403，全是缓存命中、零磁盘读，说明耗时花在 CPU 过滤和聚合上而不是 IO 上。
- **Planning** 段（PG 13+ 默认显示）：规划本身读了 36 块缓存，`Planning Time` 0.18 ms 可忽略；若复杂查询规划时间上百毫秒，问题在规划阶段而非执行。
- **Execution Time**：不含网络传输和客户端取数的时间。

## actual time 与 loops：乘法陷阱

ANALYZE 输出的三件套是 `(actual time=startup..total rows=N loops=K)`：time 单位毫秒，rows 是该节点**每次循环**平均输出的行数，loops 是该节点总共执行了几次。被上层节点重复驱动的节点（比如 Nested Loop 的内层）loops 远大于 1，此时：

- **总耗时 ≈ actual time × loops**，单看 time 会低估几个数量级；
- **总行数 = rows × loops**，rows 显示为小数是正常的（平均数）。

```plaintext
Nested Loop (cost=0.42..89.70 rows=10 width=16)
            (actual time=0.040..852.411 rows=100000 loops=1)
  ->  Index Scan using users_pkey on users u
        (cost=0.42..8.44 rows=1 width=8) (actual time=0.030..50.203 rows=10000 loops=1)
        Index Cond: (user_id < 10001)
  ->  Index Scan using orders_user_id_idx on orders o
        (cost=0.00..8.12 rows=10 width=8)
        (actual time=0.001..0.080 rows=10.0 loops=10000)
        Index Cond: (user_id = u.user_id)
```

内层索引扫描 `actual time=0.001..0.080` 看似只要 0.08 毫秒，但 loops=10000，实际贡献约 800 毫秒——这就是「看到 0.0x 毫秒以为很快」的典型陷阱。同样，rows=10.0 × 10000 次循环 = 10 万行。判断坏节点时，永远用「time × loops」和「rows × loops」换算成总量再比较。

## Buffers：命中、读取与临时文件

`BUFFERS` 按块（默认 8kB）统计各节点的 IO：

- **shared hit**：在 shared_buffers 里命中，纯内存操作；
- **shared read**：缓存里没有、从存储读取（可能被操作系统文件缓存兜住，不代表真的打了磁盘）；
- **shared dirtied / written**：被弄脏、被刷出的块，写语句常见；
- **temp read / written**：**临时文件读写**，出现即说明 sort/hash 的数据量超过了 work_mem，是最直接的「内存不够」信号。

诊断套路：`hit` 占比低 → 缓存小或数据冷，考虑加大 `shared_buffers` 或检查是否全表扫描；`temp written` 大 → 调 `work_mem`，或用索引消掉排序；某节点独占绝大部分 buffers → 它就是 IO 热点。持续观察各实例统计的原理见 [统计观察](../internals/pg-stat-observation)。

## WAL 统计（PG 13+）

`WAL` 选项只对产生日志的节点生效，常用来评估写放大：

```sql
BEGIN;
EXPLAIN (ANALYZE, WAL)
UPDATE orders SET status = 'paid' WHERE order_id = 12345;
ROLLBACK;
```

```plaintext
Update on orders (actual time=0.512..0.514 rows=1 loops=1)
  ->  Index Scan using orders_pkey on orders
        (actual time=0.038..0.040 rows=1 loops=1)
        Index Cond: (order_id = 12345)
        WAL: records=4 bytes=1000 fpi=1
Query Identifier: 1873462406727496351
Planning Time: 0.145 ms
Execution Time: 0.633 ms
```

`records` 是 WAL 记录条数，`bytes` 是字节数，`fpi` 是 full page image（checkpoint 后首次改页时整页写入镜像）个数。fpi 很大说明赶上 checkpoint 后的第一波写，属于正常现象但要注意 checkpoint 频率，见 [checkpoint 与缓冲区](../internals/checkpoint-and-buffer)。批量写语句的 WAL bytes 还能帮你估算主从延迟和归档压力。

## Timing 开销与代价对照

`ANALYZE` 默认带 `TIMING ON`，每个节点都要读时钟，对输出行数巨大的查询，计时本身的开销可能占掉可观比例（老版本更明显）。只关心行数和缓冲区时关掉它：

```sql
EXPLAIN (ANALYZE, TIMING OFF, BUFFERS) SELECT ...;  -- 仍有节点行数与总执行时间
```

另外注意 cost 与 actual 是两套体系：cost 是基于统计的定价（见 [优化器代价模型](../internals/optimizer-cost-model)），actual 是实测。对照两者不是为了换算，而是找「优化器以为便宜、实际很贵」的节点——那正是估算失真的位置。

## 注意事项与常见坑

- `EXPLAIN (ANALYZE)` 执行完会把结果集丢弃，但扫描、函数、触发器都真实发生；对 DML 一律包事务回滚。
- `actual time` 与 `rows` 是 per-loop 平均值，比较节点代价前先乘上 loops。
- Buffers 统计有少量叠加误差，节点间相加不一定精确等于顶层值。
- 测试结果受缓存冷热影响很大：冷缓存跑一次、热缓存再跑一次，结论可能相反；重要结论多跑几次取稳定值。
- 统计信息在执行瞬间被采样，输出里 `rows` 的平均值意味着极端倾斜分布下单次循环的行数可能差异巨大。
- PG 13 起 `BUFFERS` 才包含规划期的缓冲区统计，老版本输出没有 Planning 段。

## 相关页面

- [EXPLAIN 读法](./explain-basics)
- [常见坏计划](./common-bad-plans)
- [统计信息与 ANALYZE](./statistics-and-analyze)
- [优化器代价模型](../internals/optimizer-cost-model)

官方文档：[EXPLAIN 命令](https://www.postgresql.org/docs/current/sql-explain.html)、[Using EXPLAIN 教程](https://www.postgresql.org/docs/current/using-explain.html)。
