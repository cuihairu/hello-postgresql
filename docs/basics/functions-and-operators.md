# 函数与运算符

函数（function）与运算符（operator）是 SQL 里可直接复用的计算单元。运算符大多是内置语法（`+`、`= ANY`、`@>`），函数则是可调用的具名逻辑（`lower()`、`date_part()`）。两者都能在 `SELECT`、`WHERE`、`ORDER BY`、`UPDATE SET` 里使用，也都能被注册成自定义函数供后续 SQL 复用。本篇先给出常用函数速览与类型强转写法，再演示从 `LANGUAGE SQL` 到 PL/pgSQL 的自定义函数最小可跑示例，最后讲清 `VOLATILE/STABLE/IMMUTABLE` 这组标注为何影响执行计划。

## 常用字符串函数

字符串函数是日常查询里最常用的一组，绝大多数对 `NULL` 入参会返回 `NULL`（而非空串），这点与 MySQL 的 `CONCAT` 行为不同：

```sql
SELECT length('hello')            AS len,   -- 5
       upper('hello')             AS up,    -- HELLO
       lower('HELLO')             AS low,   -- hello
       trim('  hi  ')             AS trimmed,
       ltrim('  hi  ')            AS l,     -- 只去左空格
       replace('a-b-c', '-', '_') AS rep,   -- a_b_c
       split_part('a-b-c', '-', 2) AS p2,   -- b
       left('abcdefgh', 3)        AS l3;    -- abc
```

正则与模式匹配是 PostgreSQL 的强项，配合操作符比嵌套函数可读性好：

```sql
SELECT 'abc123' ~ '^abc'          AS regex_match,   -- true
       'abc123' ~* 'ABC'          AS regex_ic,      -- 忽略大小写匹配
       'abc123' !~ '^abc'         AS not_match,
       'abc123' ~ '.*[0-9]$'      AS ends_digit,
       'abc123' SIMILAR TO 'a%'   AS like_similar,  -- SQL 标准的 LIKE 增强版
       regexp_matches('a1b2c3', '([a-z])([0-9])')   AS matches;
```

`split_part`、`regexp_matches`、`regexp_replace` 是清洗脏数据的三件套，官方参考：[字符串函数与操作符](https://www.postgresql.org/docs/current/functions-string.html)。

## 常用数值函数

```sql
SELECT round(3.14159, 2)     AS r2,      -- 3.14
       trunc(3.9)            AS t,       -- 3（截断）
       floor(3.9)            AS f,       -- 3
       ceil(3.1)             AS c,       -- 4
       greatest(1, 5, 3)     AS g,       -- 5
       least(1, 5, 3)        AS l,       -- 1
       power(2, 10)          AS p,       -- 1024
       sqrt(144)             AS s,       -- 12
       random()              AS rnd,     -- 0..1
       abs(-42)              AS a,
       mod(10, 3)            AS m,       -- 1
       width_bucket(5, 0, 10, 4) AS bucket;  -- 区间分桶，常用于报表
```

`round(numeric)` 遇半值按"远离零"取整（常规四舍五入），不是银行家舍入：`round(2.5::numeric) = 3`、`round(-2.5::numeric) = -3`。但 `round(double precision)` 的半值处理依赖平台（多数平台是四舍六入五成双，`round(2.5::double precision)` 常得 2）——同一个字面量按类型不同可能得到不同结果。涉及金额一律用 `numeric`，见 [货币与数值类型](../database-design/money-and-numeric)。

## 常用日期与时间函数

```sql
SELECT now()                              AS ts,
       current_date                       AS d,
       date_trunc('day', now())           AS day,
       date_trunc('month', now())         AS month,
       date_part('hour', now())           AS h,      -- 取小时
       extract(year FROM now())           AS y,      -- 等价写法
       now() AT TIME ZONE 'Asia/Shanghai' AS local,
       ('2026-10-12')::date + interval '7 days' AS week,
       age('1990-01-01')                  AS age_out,
       date_part('epoch', now())          AS epoch,  -- 自 1970 的秒数
       to_char(now(), 'YYYY-MM-DD HH24:MI:SS') AS fmt;
```

`date_trunc` 与 `date_part` 是 SQL 与函数两种取向：前者把时间截到某粒度的边界值，后者只抽取分量。两者配合是写报表、做时间窗口的核心手法，完整参考见 [日期时间函数](https://www.postgresql.org/docs/current/functions-datetime.html)。

## 类型强转：`::` 与 `CAST`

PostgreSQL 有两种写法，效果完全等价：

```sql
SELECT '42'::int                 AS a,      -- 42
       CAST('42' AS integer)     AS b,      -- 42
       '2026-10-12'::date        AS d,
       '1.5'::numeric(10,2)      AS n,
       'abc'::text::jsonb        AS j,      -- 先 text 再 jsonb
       '42'::bigint::int         AS round_trip;
```

`::` 是 PostgreSQL 扩展写法，简短，适合交互；`CAST(... AS ...)` 是 SQL 标准，便于跨数据库迁移的代码。注意两点：

- 字符串→整数的隐式转换**只在表达式上下文**发生（如 `WHERE id = '1'`），`SELECT '1'` 原样返回字符串，不会自动变成整数。
- 失败会抛错而非返回 `NULL`。需要容忍脏数据时用 `NULLIF` + `try_cast`（PG 没有 `TRY_CAST`，需自建函数或依赖 `dblink`/PL/pgSQL `EXCEPTION` 块），见 [常见新手错误](./common-beginner-mistakes)。

## `COALESCE` / `NULLIF` / `GREATEST` / `LEAST`

这四个是处理"多个值里挑一个"的标准四件套：

```sql
SELECT COALESCE(NULL, NULL, '兜底')        AS coalesce,  -- 第一个非 NULL
       COALESCE(1, 2, 3)                   AS coalesce2, -- 1
       NULLIF('', '')                      AS nif_empty, -- NULL（相等则 NULL）
       NULLIF('a', 'b')                    AS nif_diff,  -- a
       GREATEST(1, 5, 3)                   AS g,
       LEAST(1, 5, 3)                      AS l;
```

实际场景：把空字符串规范化为 `NULL`、给缺失字段兜底默认值、按业务规则在多列间取最优。

```sql
-- 把空串视为缺失，并在缺失时取默认值
UPDATE users
SET   email = COALESCE(NULLIF(email, ''), 'nobody@example.com'),
      age   = GREATEST(LEAST(age, 120), 0)   -- 夹到 [0,120]
WHERE age IS NOT NULL;
```

## SQL 语言函数：最小示例

最简单的自定义函数用 `LANGUAGE sql`，函数体本身就是一条 SQL 语句。`CREATE FUNCTION` 由权限受限的角色执行（见 [角色与权限](../security/roles-and-permissions)）：

```sql
-- 把金额按两位小数返回，NULL 安全
CREATE OR REPLACE FUNCTION money_round(v numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE                          -- 同入参必同返回值，可被索引
AS $$
  SELECT COALESCE(round(v, 2), 0);
$$;

SELECT money_round(3.14159), money_round(NULL);
```

如果函数需要修改数据、或返回值依赖当前事务外的状态，不能标 `IMMUTABLE`，见下一节。

## PL/pgSQL 入门

PL/pgSQL 是 PostgreSQL 自带的过程语言，支持变量、流程控制、异常处理，是写复杂业务逻辑的主力。最小子例：

```sql
-- 把指定用户的余额减扣，余额不足返回 false，并在事务内回滚
CREATE OR REPLACE FUNCTION deduct(uid int, amt numeric)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  cur numeric;
BEGIN
  SELECT balance INTO cur FROM accounts WHERE id = uid;
  IF cur IS NULL THEN
    RAISE EXCEPTION '账户 % 不存在', uid;
  END IF;
  IF cur < amt THEN
    RETURN false;
  END IF;
  UPDATE accounts SET balance = balance - amt WHERE id = uid;
  RETURN true;
END;
$$;

-- 业务表 + 数据
CREATE TABLE accounts (id int PRIMARY KEY, balance numeric(12,2));
INSERT INTO accounts VALUES (1, 100), (2, 10);

SELECT deduct(1, 30);   -- true
SELECT * FROM accounts WHERE id = 1;  -- balance = 70
SELECT deduct(2, 30);   -- false（余额不足）
SELECT * FROM accounts WHERE id = 2;  -- balance 仍为 10
```

要点：`DECLARE ... BEGIN ... END` 包住变量声明与语句体；`SELECT ... INTO` 把查询结果读到变量；`RAISE EXCEPTION` 等价于让函数抛错；`RETURNS SETOF xxx` 可返回多行（用 `RETURN QUERY` 或 `RETURN NEXT`）。完整的函数能力与 `RETURNS SETOF`、游标、触发器用法见 [高级 SQL 函数](../advanced-sql/sql-functions-advanced)。

## VOLATILE / STABLE / IMMUTABLE 标注

函数有三类易变性标注，**直接影响优化器能否复用结果**：

- `IMMUTABLE`：相同入参必返回相同结果，且不依赖数据库外状态。优化器会做常量折叠、把结果写入索引表达式、把函数表达式下推到子查询。例：`abs()`、`lower()`、`date_part()` 都是内置 IMMUTABLE。
- `STABLE`：同一次查询内同入参同结果，但跨查询可能变。例：`now()`、`current_user`、`random()` 不在此列但 `now()` 标 STABLE。
- `VOLATILE`：可能随时变、或有副作用（如修改数据）。优化器**不会**做任何折叠或下推，每行每次调用都重算。`random()`、`nextval()`、`setval()` 都是 VOLATILE。

不指定时默认 `VOLATILE`，最保守。标注错会带来两类问题：

- 把 `VOLATILE` 误标 `IMMUTABLE`：优化器可能把本应逐行计算的结果折叠成常量，业务结果错。
- 把 `IMMUTABLE` 误标 `VOLATILE`：失去常量折叠与索引下推机会，计划次优。

```sql
-- 正确：纯计算 + 无副作用，标 IMMUTABLE，可被 btree 表达式索引使用
CREATE FUNCTION hash_str(s text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT md5(s) $$;

-- 错误示范：含随机数却标 IMMUTABLE，业务上不可预期
-- CREATE FUNCTION rand_tag() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT md5(random()::text) $$;
```

## 注意事项与常见坑

- `NULL` 入参多数函数返回 `NULL`。需要空串语义时用 `COALESCE` 包一层，或用 `||` 拼接（`'' || NULL` 返回 `''`，是唯一不传染 NULL 的字符串运算符）。
- `random()` 每次调用产生新值，`SELECT random(), random()` 同行两列也不同——别指望它"在 SQL 里像种子一样可复现"，需要稳定随机请用 `seed()` 配合。
- 字符串与数值混用（`WHERE varchar_col = 1`）会触发隐式转换，可能让索引失效——见 [常见新手错误](./common-beginner-mistakes)。
- 自定义函数里 `CREATE OR REPLACE` 不会修改既有依赖该函数的视图/物化视图，需要刷新。
- 标量 SQL 函数返回多列请用 `RETURNS TABLE(...)` 或返回复合类型，不要返回 `text` 拼 JSON 字符串再手工解析。

## 相关页面

- [WHERE 与表达式](./where-and-expressions)
- [高级 SQL 函数](../advanced-sql/sql-functions-advanced)
- [数据类型概览](./data-types-overview)
- [常见新手错误](./common-beginner-mistakes)
