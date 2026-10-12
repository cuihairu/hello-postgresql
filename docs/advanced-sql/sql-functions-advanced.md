# SQL 函数进阶

基础 SQL 函数（标量函数、简单 `CREATE FUNCTION ... LANGUAGE sql`）之外，业务逻辑下沉到数据库时真正依赖的是 PL/pgSQL 的过程能力：变量、异常捕获、返回表结构。这一页覆盖 PL/pgSQL 的变量与赋值、`RAISE` 与 `EXCEPTION` 错误处理、`RETURNS TABLE` 与 OUT 参数、以及决定优化器如何对待你的函数的**易变性分类**——标错易变性是函数性能问题的头号来源。

## 示例表

```sql
CREATE TABLE accounts (
    id         bigserial PRIMARY KEY,
    owner      text NOT NULL,
    balance    numeric(12,2) NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO accounts (owner, balance) VALUES
    ('alice', 1000.00),
    ('bob',   250.00);
```

## 变量：声明、默认值、赋值与参数别名

PL/pgSQL 块的声明区以 `DECLARE` 开始，每行一个变量：

```sql
CREATE OR REPLACE FUNCTION withdraw(acc_id bigint, amount numeric)
RETURNS numeric
LANGUAGE plpgsql
AS $$
DECLARE
    current_balance numeric;                     -- 无默认值，初始为 NULL
    overdraft       boolean := false;            -- 声明时赋默认值
    min_required    numeric NOT NULL DEFAULT 0;  -- NOT NULL + 默认值
BEGIN
    SELECT balance INTO current_balance FROM accounts WHERE id = acc_id;
    current_balance := current_balance - amount; -- := 赋值
    RETURN current_balance;
END;
$$;

SELECT withdraw(1, 200.00);   -- 800.00
```

要点：

- 函数参数在函数体内直接按名字引用（PG 9.2 起支持命名参数）；当参数名与列名冲突时，**列名优先**，参数会被静默遮蔽——这就是历史上推荐 `$1`/`$2` 或加前缀（`p_acc_id`）的原因。PG 9.0 起可在函数体开头加编译选项 `#variable_conflict error` 让冲突直接报错而不是静默遮蔽。
- `SELECT ... INTO 变量` 在命中多行时只取第一行、不报错；期望恰好一行时用 `SELECT ... INTO STRICT 变量`，0 行或 2 行都会抛 `NO_DATA_FOUND`/`TOO_MANY_ROWS` 异常。

## RAISE 与异常捕获

`RAISE` 抛出错误，`EXCEPTION` 子句捕获并处理，错误码用五字符的 SQLSTATE 或命名条件：

```sql
CREATE OR REPLACE FUNCTION transfer(src bigint, dst bigint, amount numeric)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE accounts SET balance = balance - amount WHERE id = src;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'account % not found', src USING ERRCODE = 'P0002';
    END IF;
    UPDATE accounts SET balance = balance + amount WHERE id = dst;
EXCEPTION
    WHEN no_data_found THEN
        RAISE WARNING 'no_data_found caught, re-raising';
        RAISE;
    WHEN numeric_value_out_of_range THEN
        RAISE NOTICE 'balance overflow, rolled back inside function';
    WHEN others THEN
        RAISE EXCEPTION 'unexpected error: %', SQLERRM USING HINT = 'check input';
END;
$$;
```

常用形式：`RAISE [DEBUG|LOG|INFO|NOTICE|WARNING|EXCEPTION] '格式串' [, 参数...]`，格式串里 `%` 逐个替换参数；`USING ERRCODE = '...'`、`USING MESSAGE = '...'`、`USING HINT = '...'` 补充错误元信息。捕获粒度上，`WHEN others` 兜底所有未列出的错误；`RAISE;`（无参）把当前异常原样重新抛出。异常被捕获后，**该函数块内此前的写操作会回滚到块开始的隐式保存点**，但外层事务如何继续由调用方决定。

错误细节可以在 `WHEN` 块里用 `GET STACKED DIAGNOSTICS` 读取（拿到 SQLSTATE、错误消息、上下文栈等），需要把错误转存日志表时用它：

```sql
EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE,
                            v_msg   = MESSAGE_TEXT;
    INSERT INTO error_log(err_code, err_msg) VALUES (v_state, v_msg);
    RAISE;
```

注意：`EXCEPTION` 子句的代价不小（建立子事务保存点），不要把它包在每行执行的循环体里当 try/catch 用，见 [批量与写入](./batch-and-write)。

## RETURNS TABLE 与 OUT 参数

返回多行多列有三种等价声明，选哪种是接口风格问题：

```sql
-- 1. RETURNS TABLE：最常用，列名会成为函数体内的变量名
CREATE OR REPLACE FUNCTION rich_accounts(threshold numeric)
RETURNS TABLE(id bigint, owner text, balance numeric)
LANGUAGE sql
AS $$
    SELECT a.id, a.owner, a.balance
    FROM accounts a WHERE a.balance > threshold;
$$;

-- 2. OUT 参数：适合复用已有函数签名、或增量加返回列
CREATE OR REPLACE FUNCTION rich_accounts_out(threshold numeric,
    OUT id bigint, OUT owner text, OUT balance numeric)
RETURNS SETOF record
LANGUAGE sql
AS $$
    SELECT a.id, a.owner, a.balance FROM accounts a WHERE a.balance > threshold;
$$;

-- 调用方式相同
SELECT * FROM rich_accounts(500);
SELECT * FROM rich_accounts_out(500);
```

`RETURNS TABLE(col type, ...)` 本质上是若干 OUT 参数加 `RETURNS SETOF record` 的语法糖。PL/pgSQL 版本里要注意 TABLE 的列名会遮蔽同名表列，在函数体内写 `WHERE balance > threshold` 时那个 `balance` 是输出变量而不是表的列，需要用表名限定 `accounts.balance`。另外，返回集合的函数可以出现在 `FROM` 里做 lateral 连接，见 [LATERAL 与 FROM 子查询](./lateral-and-from-subquery)。

## 易变性分类：VOLATILE / STABLE / IMMUTABLE

每个函数有一个易变性声明（默认 `VOLATILE`），它告诉优化器这个函数的求值约束：

| 分类 | 语义 | 优化器可做的事 |
| --- | --- | --- |
| `VOLATILE` | 每次调用都可能返回不同值（含副作用） | 什么都不做；`WHERE` 里每行都要调用 |
| `STABLE` | 同一语句内、同参数结果不变（可读表） | 在一次扫描内缓存；索引扫描条件里可求值一次 |
| `IMMUTABLE` | 任意时刻、同参数结果恒定，不碰表 | 预求值常量表达式；可用于表达式索引 |

```sql
-- STABLE：读表但同语句内结果一致
CREATE OR REPLACE FUNCTION get_owner(acc_id bigint)
RETURNS text LANGUAGE plpgsql STABLE
AS $$
    SELECT owner FROM accounts WHERE id = acc_id;
$$;

-- IMMUTABLE：纯计算
CREATE OR REPLACE FUNCTION slugify(s text)
RETURNS text LANGUAGE sql IMMUTABLE
AS $$
    SELECT lower(regexp_replace(s, '[^a-zA-Z0-9]+', '-', 'g'));
$$;

-- 建表达式索引要求函数 IMMUTABLE
CREATE INDEX idx_accounts_slug ON accounts (slugify(owner));
```

**谎报 IMMUTABLE 的坑**：把依赖环境或数据的函数标成 IMMUTABLE，优化器可能在规划期求值一次并把结果固化进计划，或构建出错误的索引条目。经典反面例子是给 `to_char(now(), ...)`、依赖 `search_path` 的 `lower()` 包装、或读另一张表的查找函数标 IMMUTABLE——在主库上看起来正常，流复制到备库或换一个 `search_path` 后查询出错或结果错误，见 [流复制与同步](../internals/streaming-replication-and-sync)。拿不准时从 VOLATILE 起步，确认纯函数后再收紧。

## SECURITY DEFINER 一瞥

函数默认以调用者身份执行（`SECURITY INVOKER`）；声明 `SECURITY DEFINER` 后以函数**所有者**的权限执行，典型用途是让普通用户通过函数写入受限表而无需直接授权：

```sql
CREATE OR REPLACE FUNCTION audit_write(msg text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public   -- 显式锁定 search_path
AS $$
    INSERT INTO audit_log(msg, at) VALUES (msg, now());
$$;
```

它同时是权限提升的主要攻击面：不锁定 `search_path` 的 SECURITY DEFINER 函数可被同名对象劫持。生产使用前先读 [角色与权限](../security/roles-and-permissions) 中的对应小节。

## 注意事项与常见坑

- PL/pgSQL 里同名参数遮蔽表列不报错，养成参数加 `p_` 前缀或在函数开头加 `#variable_conflict error` 的习惯。
- `INTO` 不加 `STRICT` 时多行只取第一行，静默吞掉数据问题；写校验逻辑时优先 `STRICT` 加异常处理。
- 函数体内的 `EXCEPTION` 每次进入都会创建子事务，热路径循环里逐行 try/catch 会显著拖慢写入。
- `CREATE OR REPLACE FUNCTION` 不能改变返回类型或参数列表，改签名要先 `DROP FUNCTION`。
- 默认 `VOLATILE` 的函数出现在 `WHERE` 中会阻止不少优化（如谓词下推、索引条件缓存），只读查询的辅助函数先想想能否标 STABLE。

## 相关页面

- [函数与操作符](../basics/functions-and-operators)
- [批量与写入](./batch-and-write)
- [角色与权限](../security/roles-and-permissions)
- [表达式索引](../indexing/expression-indexes)

官方文档：[PL/pgSQL 基础](https://www.postgresql.org/docs/current/plpgsql.html)、[错误与消息](https://www.postgresql.org/docs/current/plpgsql-control-structures.html#PLPGSQL-ERRORS-AND-MESSAGES)、[函数易变性](https://www.postgresql.org/docs/current/xfunc-volatility.html)。
