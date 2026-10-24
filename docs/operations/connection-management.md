# Connection Management

Every connection in PostgreSQL corresponds to its own backend process, so connection count is a real resource cost, not just a parameter. Applications connecting directly to the database, opening a short-lived connection per request, or running hundreds of instances each holding its own pool will all crush the database. This page collects how to size `max_connections`, why you need a connection pool in between, and what each of PgBouncer's three pool modes can and cannot do.

## `max_connections` and per-connection memory cost

- **Process model**: one process per connection (see [Process Architecture](../internals/process-architecture)). Even idle, a connection carries several MB of baseline memory (stack, catalog caches), and active connections allocate more per sort/hash operator according to `work_mem`.
- **Setup is expensive**: fork + authentication + initialization, on the order of tens of milliseconds each time. Under short-lived connections with high concurrency, most of the CPU goes to process creation.
- **The cost of raising it**: memory overcommit, more context switches, and the lock manager plus various data structures grow linearly with connection count. A few hundred connections is a common healthy ceiling; beyond that, solve it with pooling rather than cranking the parameter up.

```sql
SHOW max_connections;
-- current connection distribution: by state, and grouped by user/application
SELECT state, count(*) FROM pg_stat_activity GROUP BY 1 ORDER BY 2 DESC;
SELECT usename, application_name, client_addr, count(*)
  FROM pg_stat_activity WHERE backend_type = 'client backend'
  GROUP BY 1,2,3 ORDER BY 4 DESC;
```

```plaintext
# conf.d snippet
max_connections = 200                 # actual concurrency is controlled by the connection pool
superuser_reserved_connections = 3    # keep a lane for ops/monitoring; default is 3
```

## PgBouncer's three pool modes

PgBouncer maintains a small number of real backend connections between the application and the database, and multiplexes many client connections over them. The difference between the three `pool_mode` values is *when a client occupies a backend connection*:

| Mode | Occupation | Can do | Cannot do |
| --- | --- | --- | --- |
| session | The client exclusively occupies a connection from the moment it connects until it disconnects | All session-level features (`SET`, temporary tables, cursors, advisory locks, `LISTEN/NOTIFY`) | Limited pooling benefit: connections are never released, so backends stay occupied anyway |
| transaction | Borrows a backend per transaction and returns it when the transaction ends | Dramatically reduces backend connections; the most common mode | Session-level state is unreliable (see below); protocol-level prepared statements need PgBouncer 1.21+ |
| statement | Borrows once per statement and returns it as soon as the statement finishes | Extreme connection compression; suited to stateless query proxies | No explicit transactions: multi-statement transactions after `BEGIN` simply stop working |

**Classic pitfalls in transaction mode**:

- **`SET` / `search_path`**: session-level `SET` gets "inherited" by the next consumer, or is lost when the connection is returned. Use `SET LOCAL` inside the transaction instead, or put `options='-c search_path=app,public'` on the connection string so it takes effect each time a backend connection is created.
- **Advisory locks / `LISTEN/NOTIFY` / temporary tables / cross-transaction cursors**: all session-level concepts; under a transaction pool they either stop working or leak to other clients. If you need these features, use session mode or a direct connection.
- **Prepared statements**: JDBC and similar drivers use protocol-level prepared statements by default (pgjdbc's `prepareThreshold` defaults to switching after 5 executions). Older PgBouncer versions fail outright with `prepared statement "..." does not exist`; **from PgBouncer 1.21, protocol-level prepared statements are supported**, and with the `max_prepared_statements` parameter they work normally in transaction mode. SQL-text-level `PREPARE`/`EXECUTE` is still unsupported.

## Deployment placement and key parameters

Two deployment placements: a sidecar on the same host as the application (loopback, minimal latency, process-level failure isolation) or a standalone pooling tier (centralized control over multiple applications). Either way, the database-side `max_connections` should leave headroom for direct ops connections, monitoring, logical replication, and so on.

```ini
;; /etc/pgbouncer/pgbouncer.ini
[databases]
appdb = host=127.0.0.1 port=5432 dbname=appdb

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = 6432
pool_mode = transaction
max_client_conn = 500          ; total client connection cap; default 100
default_pool_size = 40         ; real backend connections per (user, db) pair; default 20
reserve_pool_size = 5          ; back-up connections borrowed under spikes
reserve_pool_timeout = 3       ; only tap the reserve pool after waiting more than 3s
server_idle_timeout = 60       ; how long a backend may sit idle before closing
max_prepared_statements = 200  ; protocol-level prepared statement support in 1.21+
auth_type = scram-sha-256
```

```bash
sudo systemctl restart pgbouncer
psql -h 127.0.0.1 -p 6432 -U pgbouncer pgbouncer   # connect to the admin console (database name is fixed at pgbouncer)
```

Note that `server_reset_query` (running `DISCARD ALL` before returning a backend connection) only takes effect in session mode; under transaction mode the connection owner changes at any moment, so it can't be cleaned up safely — in other words, **a transaction pool doesn't back you up on session state**.

## Dividing the work between the app side and the bouncer side

The two pooling layers each own one job, and their configuration has to match rather than fight each other:

- **The app-side pool** (HikariCP, pgx Pool, SQLAlchemy pool, etc.) is responsible for limiting concurrency: pool size ≈ CPU cores × 2~4 (an empirical starting point for OLTP). Requests beyond the concurrency limit queue inside the application, which is controllable.
- **The bouncer side** is responsible for multiplexing multiple applications' connections onto `default_pool_size` real backends.
- **Anti-pattern one**: the application pool has no upper limit, expecting PgBouncer to queue — client connections fill `max_client_conn` up, putting pressure on PgBouncer's own memory and file descriptors.
- **Anti-pattern two**: a large application pool plus a large bouncer pool — `default_pool_size × number of pooling-tier instances` must be less than `max_connections`, and the real concurrency ceiling should still be constrained by CPU/IO. Two layers of queuing only make latency harder to diagnose.
- Long transactions are the nemesis of a transaction pool: one long transaction holds a backend connection for its entire duration, a handful of sessions drain the pool, and `cl_waiting` spikes.

## Observability: admin console commands

After connecting to the `pgbouncer` admin database, run these (one panel per command):

```plaintext
SHOW POOLS;     -- cl_active/cl_waiting: client queueing; sv_active/sv_idle: backend occupation
SHOW CLIENTS;   -- where current client connections come from and how long they've been connected
SHOW SERVERS;   -- state of the real backend connections
SHOW STATS;     -- total QPS, average query duration, bytes sent/received
```

Health criteria: in `SHOW POOLS`, `cl_waiting` staying above 0 for a long time means `default_pool_size` is too small or long transactions are holding slots; the `maxwait` column shows seconds of wait at the head of the queue, and a continuously growing value should trigger an alert.

## Caveats and common pitfalls

- **Audit your code before switching to transaction mode**: search for uses of `SET`, `advisory_lock`, `LISTEN`, temporary tables, and `PREPARE`, and confirm each one is reworked or moved to session mode.
- **Upgrading PgBouncer to 1.21+** is a precondition for JDBC + a transaction pool; otherwise prepared-statement errors will mostly surface only during peak hours.
- **`max_client_conn` is the PgBouncer-side cap** — don't forget to also raise the system `ulimit -n` and systemd's `LimitNOFILE`.
- **Authentication pass-through**: under `auth_type=scram-sha-256`, the password verification method must match the PostgreSQL side; when using `auth_query`, confirm the querying account has the minimum necessary privileges.
- **Don't monitor only the database**: if the PgBouncer process itself dies, that's equivalent to a database disconnect, so it belongs in liveness probes too.
- **Superuser direct connections are unconstrained by pooling**, and ops scripts are actually cleaner going direct — but leave room in `superuser_reserved_connections`.

## Further reading

- [PostgreSQL official docs · Chapter 25. Backup and Restore](https://www.postgresql.org/docs/current/backup.html)
- [PostgreSQL official docs · Chapter 19. Server Configuration](https://www.postgresql.org/docs/current/runtime-config.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Process Architecture](../internals/process-architecture)
- [Connection and ORM Optimization](../performance/connection-and-orm-optimization)
- [Parameter Tuning](../performance/parameter-tuning)
- [High Availability Architectures](./high-availability-architecture)
- [install-and-quickstart](/basics/install-and-quickstart.md)
- [comparison-with-mysql](/ecosystem/comparison-with-mysql.md)
- [process-architecture](/internals/process-architecture.md)
- [knowledge](/knowledge.md)
- [index](index.md)
- [connection-and-orm-optimization](/performance/connection-and-orm-optimization.md)
- [client-drivers](/tools/client-drivers.md)
