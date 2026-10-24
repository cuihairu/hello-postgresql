# SQL Functions in Depth

Beyond the basic SQL functions (scalar functions, simple `CREATE FUNCTION ... LANGUAGE sql`), what business logic really depends on once it moves down into the database is PL/pgSQL's procedural capability: variables, exception handling, and returning table structures. This page covers PL/pgSQL variables and assignment, `RAISE` and `EXCEPTION` error handling, `RETURNS TABLE` and OUT parameters, and **volatility classification** — which decides how the optimizer treats your function. Mislabeling volatility is the number-one source of function performance problems.

## Sample Table

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

## Variables: Declaration, Defaults, Assignment, and Parameter Aliasing

The declaration section of a PL/pgSQL block starts with `DECLARE`, one variable per line:

```sql
CREATE OR REPLACE FUNCTION withdraw(acc_id bigint, amount numeric)
RETURNS numeric
LANGUAGE plpgsql
AS $$
DECLARE
    current_balance numeric;                     -- no default, initializes to NULL
    overdraft       boolean := false;            -- default assigned at declaration
    min_required    numeric NOT NULL DEFAULT 0;  -- NOT NULL + default
BEGIN
    SELECT balance INTO current_balance FROM accounts WHERE id = acc_id;
    current_balance := current_balance - amount; -- := assignment
    RETURN current_balance;
END;
$$;

SELECT withdraw(1, 200.00);   -- 800.00
```

Essentials:

- Function parameters are referenced by name directly in the body (named parameters are supported from PG 9.2); when a parameter name collides with a column name, **the column name wins** and the parameter is silently shadowed — this is why the historical advice was to use `$1`/`$2` or a prefix (`p_acc_id`). From PG 9.0 you can add the compilation option `#variable_conflict error` at the top of the body to make collisions error instead of being silently shadowed.
- `SELECT ... INTO var` takes only the first row when it hits multiple rows and does not error; use `SELECT ... INTO STRICT var` when exactly one row is expected — 0 rows or 2 rows both raise a `NO_DATA_FOUND`/`TOO_MANY_ROWS` exception.

## RAISE and Exception Handling

`RAISE` throws an error and the `EXCEPTION` clause catches and handles it; error codes use the five-character SQLSTATE or a named condition:

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

Common forms: `RAISE [DEBUG|LOG|INFO|NOTICE|WARNING|EXCEPTION] 'format string' [, params...]`, where `%` in the format string is replaced by the parameters in turn; `USING ERRCODE = '...'`, `USING MESSAGE = '...'`, and `USING HINT = '...'` add error metadata. On catch granularity, `WHEN others` catches everything not listed; a bare `RAISE;` re-raises the current exception unchanged. After an exception is caught, **earlier writes inside that function block roll back to the implicit save point at the block's start**, but how the outer transaction continues is up to the caller.

Error details can be read inside a `WHEN` block with `GET STACKED DIAGNOSTICS` (giving you the SQLSTATE, the message, the context stack, and so on); use it when you need to persist errors into a log table:

```sql
EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE,
                            v_msg   = MESSAGE_TEXT;
    INSERT INTO error_log(err_code, err_msg) VALUES (v_state, v_msg);
    RAISE;
```

Note that an `EXCEPTION` clause is not cheap (it creates a subtransaction save point); do not wrap it around a loop body that executes per row as a try/catch. See [Batching and Writes](./batch-and-write).

## RETURNS TABLE and OUT Parameters

Returning multiple rows and columns has three equivalent declarations, and which one you pick is a matter of interface style:

```sql
-- 1. RETURNS TABLE: the most common; the column names become variable names in the body
CREATE OR REPLACE FUNCTION rich_accounts(threshold numeric)
RETURNS TABLE(id bigint, owner text, balance numeric)
LANGUAGE sql
AS $$
    SELECT a.id, a.owner, a.balance
    FROM accounts a WHERE a.balance > threshold;
$$;

-- 2. OUT parameters: good for reusing an existing function signature, or adding return columns incrementally
CREATE OR REPLACE FUNCTION rich_accounts_out(threshold numeric,
    OUT id bigint, OUT owner text, OUT balance numeric)
RETURNS SETOF record
LANGUAGE sql
AS $$
    SELECT a.id, a.owner, a.balance FROM accounts a WHERE a.balance > threshold;
$$;

-- The call form is the same
SELECT * FROM rich_accounts(500);
SELECT * FROM rich_accounts_out(500);
```

`RETURNS TABLE(col type, ...)` is essentially syntactic sugar for several OUT parameters plus `RETURNS SETOF record`. In PL/pgSQL versions, note that TABLE column names shadow table columns of the same name: writing `WHERE balance > threshold` in the body refers to the output variable, not the table's column, so qualify it with the table name as `accounts.balance`. Also, a set-returning function can appear in `FROM` for a lateral join. See [LATERAL and FROM Subqueries](./lateral-and-from-subquery).

## Volatility Classification: VOLATILE / STABLE / IMMUTABLE

Every function has a volatility declaration (default `VOLATILE`) that tells the optimizer the function's evaluation constraints:

| Class | Semantics | What the optimizer may do |
| --- | --- | --- |
| `VOLATILE` | May return a different value on each call (including side effects) | Nothing; it must be called for every row in `WHERE` |
| `STABLE` | Same arguments give the same result within one statement (may read tables) | Cache within one scan; may evaluate once in an index scan condition |
| `IMMUTABLE` | Same arguments give the same result at any time, does not touch tables | Pre-evaluate as a constant expression; may be used in an expression index |

```sql
-- STABLE: reads a table but the result is stable within one statement
CREATE OR REPLACE FUNCTION get_owner(acc_id bigint)
RETURNS text LANGUAGE plpgsql STABLE
AS $$
    SELECT owner FROM accounts WHERE id = acc_id;
$$;

-- IMMUTABLE: pure computation
CREATE OR REPLACE FUNCTION slugify(s text)
RETURNS text LANGUAGE sql IMMUTABLE
AS $$
    SELECT lower(regexp_replace(s, '[^a-zA-Z0-9]+', '-', 'g'));
$$;

-- Building an expression index requires the function to be IMMUTABLE
CREATE INDEX idx_accounts_slug ON accounts (slugify(owner));
```

**The trap of falsely claiming IMMUTABLE**: labeling a function that depends on environment or data as IMMUTABLE lets the optimizer evaluate it once at plan time and bake the result into the plan, or build incorrect index entries. Classic bad examples are marking `to_char(now(), ...)`, a `lower()` wrapper that depends on `search_path`, or a lookup function that reads another table as IMMUTABLE — the queries look fine on the primary, but break with wrong results after streaming replication to a standby or after a change of `search_path`. See [Streaming Replication and Synchronization](../internals/streaming-replication-and-sync). When in doubt, start from VOLATILE and tighten it only after confirming the function is pure.

## A Look at SECURITY DEFINER

A function runs as the caller by default (`SECURITY INVOKER`); declaring `SECURITY DEFINER` makes it run with the privileges of the function's **owner**. The typical use is letting ordinary users write to a restricted table through a function without being granted direct access:

```sql
CREATE OR REPLACE FUNCTION audit_write(msg text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public   -- lock search_path explicitly
AS $$
    INSERT INTO audit_log(msg, at) VALUES (msg, now());
$$;
```

It is also the main privilege-escalation attack surface: a SECURITY DEFINER function that does not lock `search_path` can be hijacked by a same-named object. Read the corresponding section of [Roles and Permissions](../security/roles-and-permissions) before using it in production.

## Caveats and Common Traps

- In PL/pgSQL, a same-named parameter shadowing a table column is not an error; get into the habit of prefixing parameters with `p_` or adding `#variable_conflict error` at the top of the function.
- `INTO` without `STRICT` takes only the first row on multiple matches, silently swallowing data problems; prefer `STRICT` plus exception handling when writing validation logic.
- An `EXCEPTION` in a function body creates a subtransaction on every entry, so per-row try/catch in a hot-path loop slows writes considerably.
- `CREATE OR REPLACE FUNCTION` cannot change the return type or the parameter list; to change the signature, `DROP FUNCTION` first.
- A function with the default `VOLATILE` in `WHERE` blocks a number of optimizations (such as predicate pushdown and index condition caching); for helper functions in read-only queries, consider whether they can be marked STABLE.

## References

- [PostgreSQL official documentation · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL official documentation · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Functions and Operators](../basics/functions-and-operators)
- [Batching and Writes](./batch-and-write)
- [Roles and Permissions](../security/roles-and-permissions)
- [Expression indexes](../indexing/expression-indexes)
- [index](index.md)
- [functions-and-operators](/basics/functions-and-operators.md)
Official documentation: [PL/pgSQL basics](https://www.postgresql.org/docs/current/plpgsql.html), [Errors and messages](https://www.postgresql.org/docs/current/plpgsql-control-structures.html#PLPGSQL-ERRORS-AND-MESSAGES), [Function volatility](https://www.postgresql.org/docs/current/xfunc-volatility.html).
