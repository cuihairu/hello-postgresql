# Client Drivers

A substantial share of database performance problems has nothing to do with the SQL itself and instead comes from how the application side uses connections and passes parameters. This page collects the correct usage of the two mainstream drivers, the key connection string parameters, and how connection pooling divides the work.

## psycopg 3 (Python)

```bash
pip install "psycopg[binary]"
```

```python
import psycopg

conn = psycopg.connect("postgresql://app:secret@localhost:5432/appdb")

# Parameterized: %s placeholder + parameter tuple, the driver handles escaping
cur = conn.execute(
    "SELECT id, email FROM users WHERE status = %s ORDER BY id LIMIT %s",
    ("active", 10),
)
rows = cur.fetchall()

# psycopg 3 opens a transaction block by default, so you must commit explicitly
cur.execute("UPDATE users SET status = %s WHERE id = %s", ("active", 1))
conn.commit()
```

Three points:

- `conn.execute()` returns a cursor directly, no separate `cursor()` call needed;
- From `psycopg 3.1` there's a **pipeline mode** that bundles a batch of statements into a single network round trip. The payoff is very clear for loop-based insert/update workloads:

```python
with conn.pipeline() as p:
    for uid in user_ids:
        conn.execute("INSERT INTO audit_log(user_id) VALUES (%s)", (uid,))
conn.commit()
```

- Parameters always go in the second argument tuple. Don't splice them into the SQL string.

## node-postgres (Node.js)

```bash
npm install pg
```

```javascript
const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  password: process.env.DATABASE_PASSWORD,
  max: 10,                       // connection limit inside the pool
  connectionTimeoutMillis: 2000,
});

const { rows } = await pool.query(
  'SELECT id, email FROM users WHERE status = $1 ORDER BY id LIMIT $2',
  ['active', 10],
);

await pool.end();
```

- Parameters use numbered placeholders `$1`, `$2`, which is the equivalent of Python's `%s`. Both are the standard way to prevent SQL injection;
- **Pool** is an in-process connection pool responsible for reuse and recycling; a web service should share one Pool globally. **Client** is a single independent connection, suitable when you need fixed session state or must not mix other statements inside a transaction. You have to `release`/`end` it when done;
- Borrowing a connection from the Pool to run a long transaction holds a pool slot, and other requests queue up. Long-running jobs should use a separate Client.

## Connection strings and key parameters

```plaintext
postgresql://app:secret@10.0.0.8:5432/appdb?sslmode=require&connect_timeout=5&application_name=orders-api
```

| Parameter | Purpose |
| --- | --- |
| `connect_timeout` | Timeout in seconds for establishing a connection. **Without it, a stalled connection waits forever**, which is especially critical during a service restart storm |
| `application_name` | Shows up in `pg_stat_activity.application_name`. When troubleshooting, it lets you spot which service a request came from at a glance — see [troubleshooting toolbox](./troubleshooting-toolbox) |
| `sslmode` | `disable`/`require`/`verify-full`. Across the public network or under compliance requirements, at least `require` |
| Defaults for `host`/`port`/`sslmode` | Defaults fall back to the local Unix socket, and `sslmode` defaults to `prefer`. In scripts it's better to spell everything out explicitly |

Connection strings are usually read from environment variables rather than written into code: `DATABASE_URL`, or split per item into `PGHOST`/`PGUSER`/`PGPASSWORD`.

## Why you must use a connection pool

PostgreSQL uses a **one-connection-one-backend-process** process model: each connection forks a process, allocates memory, and registers shared lock-table resources (for the architectural details, see [process architecture](../internals/process-architecture)). This means:

- Connection count equals process count. 100 connections is 100 processes, and even a few dozen connections noticeably increase scheduling and memory pressure;
- `max_connections` is usually only a few hundred, and exceeding it gets you rejected outright;
- Establishing a connection itself costs a handshake, authentication, and possibly SSL negotiation. Creating a new connection per request is far more expensive than reuse.

So pooling happens at two layers: the **in-app pool** (Python side uses `psycopg_pool.Pool`, which requires installing `psycopg[binary,pool]`; Node side uses `pg.Pool`) manages reuse within its own process — one pool per application instance, with tens to a hundred connections. **PgBouncer** sits between the applications and the database and manages the total connection count across all apps, aggregating hundreds or thousands of application connections down to a few dozen PostgreSQL connections. PgBouncer has two modes:

- `session` mode: a connection maps one-to-one to a backend session. Behavior is closest to a direct connection, but the aggregation capability is weak;
- `transaction` mode: a single connection is reused across different transactions. Aggregation is highest, but note that it breaks session-level state (`SET`, temporary tables, session-level prepared statements).

The in-app pool manages "per-instance concurrency," and PgBouncer manages "cross-instance total." They don't replace each other. With serverless, elastic container scaling, or many microservices, PgBouncer is almost mandatory.

## Parameterized queries are the baseline

**String concatenation is the only source of injection, and parameterization is the only way to splice in user input**:

```python
# Dangerous: the query condition comes from user input and gets concatenated into the SQL
sql = f"SELECT * FROM users WHERE name = '{request.args['name']}'"
conn.execute(sql)          # with input ' OR '1'='1 the whole table is read out

# Correct: placeholder + parameter
conn.execute("SELECT * FROM users WHERE name = %s", (request.args['name'],))
```

Parameterization is about more than preventing injection — it also lets the same SQL structure reuse a single compiled plan, which helps performance too. Anywhere it "just looks like you're splicing in a number or a date" needs parameterization as well. Today you pass a number, tomorrow you pass an array of user IDs; the defense shouldn't rely on self-discipline but on habit. For the correct way to do bulk writes, see [batch and write](../advanced-sql/batch-and-write).

## References

- [PostgreSQL official docs · psql](https://www.postgresql.org/docs/current/app-psql.html)
- [PostgreSQL official docs · F.32. pg_stat_statements — track statistics of SQL planning and execution](https://www.postgresql.org/docs/current/pgstatstatements.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [troubleshooting toolbox](./troubleshooting-toolbox)
- [connection and ORM optimization](../performance/connection-and-orm-optimization)
- [process architecture](../internals/process-architecture)
- [connection management](../operations/connection-management)
- [dbeaver-and-vscode](dbeaver-and-vscode.md)
- [index](index.md)
- [local-dev-environment](local-dev-environment.md)
- [real-world-cases](real-world-cases.md)
- [schema-migration-tools](schema-migration-tools.md)
- [troubleshooting-toolbox](troubleshooting-toolbox.md)
Official docs: [psycopg 3](https://www.psycopg.org/psycopg3/docs/), [node-postgres](https://node-postgres.com/), [libpq connection parameters](https://www.postgresql.org/docs/current/libpq-connect.html).
