# 金额与数值

金额字段的选型错误（浮点存钱、字符存钱、舍入口径不一致）在账务系统里都是直接的资金事故。PostgreSQL 提供的选项其实很短：语义精确的 `numeric`，或以最小单位存储的 `bigint` 整数；`float` 和内置 `money` 类型都不该用于存钱。本篇讲清各选项的原理、舍入规则的坑，以及算术与聚合的行为。

## numeric：语义精确的定点十进制

`numeric(precision, scale)` 是定点十进制：`precision` 是总有效位数，`scale` 是小数位数。`numeric(12,2)` 表示最多 10 位整数加 2 位小数；不带参数的 `numeric` 是任意精度。

```sql
CREATE TABLE payments (
  id     bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  note   text
);

INSERT INTO payments (amount) VALUES (199.90);

SELECT amount, amount * 100 FROM payments;
-- 199.90 | 19990.00    —— 十进制精确计算，无浮点误差
```

`numeric` 在 CPU 上用软件实现的十进制算术，运算速度低于整数和浮点，但 OLTP 里金额列的读写量级完全感知不到差异。它的核心价值是**语义精确**：存进去是 0.1，取出来就是 0.1。官方类型参考见[数值类型](https://www.postgresql.org/docs/current/datatype-numeric.html)。

## 不要用 float 存钱

`float4`/`float8` 是二进制浮点，多数十进制小数无法精确表示：

```sql
SELECT 0.1::float8 + 0.2::float8;              -- 0.30000000000000004
SELECT (0.1::float8 + 0.2::float8) = 0.3;      -- false

SELECT 0.1::numeric + 0.2::numeric = 0.3::numeric;   -- true
```

单次误差可能看不出，但累加（对账、汇总）、乘除（汇率换算）会让误差持续放大，`sum()` 结果对不上分录就是这类问题的典型表现。数值建模总览见 [数据类型概览](../basics/data-types-overview)。

## bigint 存分还是 numeric 存元

两种都正确，选一种全库统一：

```sql
-- 方案 A：bigint 存最小单位（分），199.90 元存 19990
CREATE TABLE payments_fen (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  amount  bigint  NOT NULL CHECK (amount >= 0),   -- 单位：分
  currency char(3) NOT NULL DEFAULT 'CNY'
);

-- 方案 B：numeric 存元
amount numeric(12,2) NOT NULL CHECK (amount >= 0)
```

- **bigint 存分**的优点：整数运算快且无任何舍入歧义；与支付网关的对账单位（微信、支付宝都以分为单位）天然对齐，落库即落账。缺点是可读性差，人工查数要心算，且一旦出现比"分"更细的单位（费率分摊）就要改列。
- **numeric 存元**的优点：直观，SQL 里直接加减乘除。缺点是要在每个换算点显式约定舍入。

关键纪律：**同一业务的金额不要两种方案混用**，并在接口文档里写明单位。两者都比 `float` 和字符型正确。

## 舍入规则

PostgreSQL 里两种舍入并存，混用必出对不平：

```sql
SELECT round(2.5::numeric), round(3.5::numeric);   -- 3 | 4   半远离零
SELECT round(2.5::float8),  round(3.5::float8);    -- 2 | 4   半取偶（银行家舍入）
```

- `numeric` 的 `round` 是**四舍五入、半远离零**（2.5 进为 3，-2.5 进为 -3）。这与 Java `BigDecimal` 的 `HALF_UP` 一致。
- `float8` 的 `round` 走 C 库的 `rint`，是**半取偶**（2.5 舍为 2，3.5 进为 4）。Python `decimal` 的 `ROUND_HALF_EVEN` 是同类。
- 跨语言/跨系统对账时，先把双方舍入模式约定成一致，再谈金额；优惠分摊（把 10 元拆到 3 个商品）这类"和必须等于总额"的场景，用"逐项舍入、最后一项补差"的模式。

## numeric 的算术与聚合

```sql
SELECT 10::numeric / 4;
-- 2.5000000000000000    除法产生高标度结果，不要裸用

SELECT round(100.00::numeric * 0.07, 2);   -- 7.00    算税后显式定标度

SELECT sum(amount) FROM payments;          -- sum(numeric) 仍是 numeric，不丢精度
```

规则要点：加减结果的标度取两操作数较大者；乘法标度相加；**除法会产生远超预期的小数位**（如上例 16 位），所以每个除法之后都应显式 `round(..., 2)` 落到目标标度。聚合方面 `sum(numeric)` 与 `avg(numeric)` 都返回 `numeric`；`sum(bigint)` 也返回 `numeric`（而非 `bigint`），大额汇总不会溢出。

## money 类型为什么不用

PostgreSQL 内置的 `money` 类型（个别资料里写作 pg_money）不推荐用于新表：标度固定为 2 位、输出与解析行为随 `lc_monetary` 区域设置变化（换区域后符号与分隔符都会变）、与其他数值类型混合运算必须显式 cast，且不适合多币种。需要"带币种的金额"时，用 `numeric` 加一个 `currency char(3)` 列自行建模，行为完全可控。

## 参考资料

- [PostgreSQL 官方文档 · 5.5. Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
- [PostgreSQL 官方文档 · 5.12. Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [数据类型概览](../basics/data-types-overview)
- [约束与数据质量](./constraints-and-data-quality)
- [反模式清单](./anti-patterns)
- [时间建模](./time-modeling)
- [data-types-overview](/basics/data-types-overview.md)
- [functions-and-operators](/basics/functions-and-operators.md)
- [anti-patterns](anti-patterns.md)
- [index](index.md)