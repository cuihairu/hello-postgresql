# Local Development Environments

The first goal for a local database is "one command to bring it up," and the second is "resettable at any time." The official Docker image plus a compose file satisfies both at once.

## Bringing up a database with docker compose

Drop a `docker-compose.yml` in the repo root:

```yaml
services:
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: appdb
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./init:/docker-entrypoint-initdb.d
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d appdb"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  pgdata:
```

```bash
docker compose up -d
docker compose exec db psql -U app -d appdb -c 'select version()'
```

A few behavioral details of the official image:

- `.sql`, `.sql.gz`, and `.sh` files under `/docker-entrypoint-initdb.d/` run **only when the data directory is empty**, sorted by file name — they only take effect on the first start. If you edit init scripts afterwards you have to delete the volume and rebuild;
- The data volume uses a named volume `pgdata` rather than a directory bind-mount, which avoids the local directory ownership/permission trap (bind-mounting a host directory often fails initialization);
- The `pg_isready` healthcheck lets orchestrators detect that "the database is up," and application containers wait for readiness with `depends_on: { db: { condition: service_healthy } }`;
- The image ships with tags like `postgres:16` and `postgres:17`. Have the team standardize on one major version to avoid version drift between local and production.

## Seed data strategy

Put two files in the init directory, using numeric prefixes to guarantee order:

```sql
-- init/01_schema.sql
CREATE TABLE IF NOT EXISTS users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  email text UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  amount numeric(10,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

```sql
-- init/02_seed.sql
INSERT INTO users (name, email)
VALUES ('Zhang San', 'zhangsan@example.com'), ('Li Si', 'lisi@example.com')
ON CONFLICT (email) DO NOTHING;

INSERT INTO orders (user_id, amount)
SELECT u.id, (random() * 1000)::numeric(10,2)
FROM users u
CROSS JOIN generate_series(1, 50);
```

The value of separating schema from data: reset data without touching structure, CI can apply schema only, and the `ON CONFLICT DO NOTHING` in seed files guarantees idempotency so repeated runs don't insert duplicates. When the repo has real desensitized samples, put them in seed; otherwise accumulate them in the local database.

## Test database isolation

Tests fear contaminating each other most. Three isolation granularities, lightest to heaviest:

**Option A: roll back a transaction per test.** Each test is wrapped in `BEGIN ... ROLLBACK`, so the database state doesn't change, concurrency is high, and it runs fast. The precondition is that **the code under test must not `COMMIT` on its own** — the moment it commits, the rollback is wasted, so you need connection-pool interception or explicit transaction nesting to work around it.

**Option B: clone a template database.** Each test gets its own database, with complete isolation from the others:

```sql
-- Run once the template database is built and has no active connections
CREATE DATABASE test_order_flow TEMPLATE dev_db;
-- After the tests finish
DROP DATABASE test_order_flow;
```

Cloning is instant (it copies files rather than inserting row by row), which suits integration tests. Note that the template database must have **no active connections whatsoever** (including its own); confirm this before cloning.

**Option C: one schema per test.** The cost of creating databases drops to zero and you share the connection pool. The trade-off is that `search_path` must be reset strictly per test, and residue crossing schemas will interfere with each other.

A common approach is to use Option A for unit tests and Option B for integration tests, and to test directly against the main database in the dev container.

## psql aliases and environment variables

When connecting interactively to a local database you don't want to type the full connection parameters each time. psql reads, in order, command-line arguments, environment variables, then defaults:

```bash
# Put in ~/.bashrc / ~/.zshrc, or in the project's .envrc (loaded by direnv)
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=app PGDATABASE=appdb

alias psql='psql -P pager=off -P null="(null)"'
alias pgexec='psql -X -v ON_ERROR_STOP=1 -f'
```

The password prompt can be handled with `~/.pgpass` (permissions must be 0600): `127.0.0.1:5432:appdb:app:app`. Passwords that land in shell history or anywhere else should never appear in code — see the connection string section of [client drivers](./client-drivers).

For everyday psql usage (`\d`, `\x`, `\copy`), see [psql basics](../basics/psql-getting-started) and [psql advanced](./psql-advanced). For installing PostgreSQL on a machine for the first time, see [installation and first connection](../basics/install-and-quickstart).

## References

- [PostgreSQL official docs · psql](https://www.postgresql.org/docs/current/app-psql.html)
- [PostgreSQL official docs · F.32. pg_stat_statements — track statistics of SQL planning and execution](https://www.postgresql.org/docs/current/pgstatstatements.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [psql advanced](./psql-advanced)
- [schema migration tools](./schema-migration-tools)
- [client drivers](./client-drivers)
- [installation and first connection](../basics/install-and-quickstart)
- [index](index.md)
- [psql-advanced](psql-advanced.md)
- [schema-migration-tools](schema-migration-tools.md)
Official docs: [postgres image docs](https://hub.docker.com/_/postgres), [template databases](https://www.postgresql.org/docs/current/manage-ag-templatedbs.html), [libpq environment variables](https://www.postgresql.org/docs/current/libpq-envars.html).
