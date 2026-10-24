# Installation and First Connection

The goal of installing PostgreSQL is to get a **cluster** running (a set of processes plus a data directory), create a database, and then connect with psql to run your first SQL statement. Installation paths differ across operating systems mainly in where the packages come from and how the service is started; the concepts themselves are consistent.

> The examples in this article use PostgreSQL 16 / 17, and the syntax and directory structure are essentially consistent across versions.

## Three Installation Channels

For an official roundup of installation methods per platform, see [PostgreSQL Downloads](https://www.postgresql.org/download/). On Linux, prefer the PGDG repository for current releases rather than the older versions bundled with the distribution.

- **Distribution repositories (Debian/Ubuntu)**: `apt install postgresql-16` installs both server and client, automatically creates the `postgres` system user, and registers a systemd service. Note that the official repositories on Ubuntu 22.04 / Debian 12 usually carry 14 or 15; for 16+ use the PGDG repository.
- **PGDG repository (RHEL / Rocky / Fedora)**: the officially maintained PostgreSQL repository (https://yum.postgresql.org/), with rpm packages uniformly located under `/usr/pgsql-16/bin`.
- **Homebrew / Windows installer**: macOS and Windows each install with a single click, and the Windows installer runs `initdb` for you.

## Debian / Ubuntu (apt)

```bash
# Add the PGDG repository (using Debian 12 / PG16 as an example; you can swap bookworm -> noble, postgresql-16 -> 17)
sudo apt install -y curl ca-certificates
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
  | sudo tee /etc/apt/sources.list.d/pgdg.list

sudo apt update
sudo apt install -y postgresql-16

# The service is managed by systemd (the Debian/Ubuntu packages register it by default)
sudo systemctl enable --now postgresql
sudo systemctl status postgresql
```

## RHEL / Rocky / Fedora (dnf)

```bash
# Install the PGDG repository rpm (using Rocky 9 / PG16 as an example)
sudo dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm

# Enable the repository and install
sudo dnf module disable -y postgresql
sudo dnf install -y postgresql16-server postgresql16-contrib

# RHEL-family packages do not initialize automatically; you must run this once manually
sudo /usr/pgsql-16/bin/postgresql-16-setup initdb
sudo systemctl enable --now postgresql-16
```

## macOS (Homebrew)

```bash
brew install postgresql@16

# Put the command-line tools on PATH (the Apple Silicon path is /opt/homebrew, Intel is /usr/local)
echo 'export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# Homebrew usually auto-initializes to $(brew --prefix)/var/postgresql@16 at install time;
# if the directory does not exist or you want to create your own, initialize manually once:
initdb -D "$(brew --prefix)/var/postgresql@16" -E UTF8

# Start it as a long-running service
brew services start postgresql@16
```

## Windows (official installer)

Download the EDB graphical installer from https://www.postgresql.org/download/windows/ and just click Next all the way through. The installer does three things:

1. Installs the program to `C:\Program Files\PostgreSQL\16`;
2. Initializes the data directory with `initdb` (default `C:\Program Files\PostgreSQL\16\data`);
3. Registers and starts a Windows service named `postgresql-x64-16`.

Write down the `postgres` superuser password you set during installation; you will use it later when `psql` connects to localhost.

## Clusters, initdb, and Starting and Stopping

**A cluster (database cluster)** is a PostgreSQL-specific term: it refers to a single **standalone data directory** initialized by `initdb`, containing several databases and served by a group of background processes. Multiple clusters can exist on one server (different versions or ports), specified via `PGDATA` or `-D`. For the full parameters of `initdb` and `pg_ctl`, see the official docs [initdb](https://www.postgresql.org/docs/current/app-initdb.html) and [pg_ctl](https://www.postgresql.org/docs/current/app-pg-ctl.html).

**Data directory contents** (using PG16 as an example):

```text
/var/lib/postgresql/16/main/     # PGDATA
├── postgresql.conf              # Main configuration file
├── pg_hba.conf                  # Client authentication rules
├── PG_VERSION                   # Version identifier
├── base/                        # User data files
├── global/                      # Global system tables
└── postmaster.pid               # Runtime PID file
```

`initdb` creates only three system databases: `postgres` (the default connection database), `template0` (a clean template), and `template1` (the template used by default CREATE DATABASE).

```bash
# Initialize as the postgres user (do not use root)
sudo -u postgres /usr/lib/postgresql/16/bin/initdb \
  -D /var/lib/postgresql/16/main -E UTF8 --locale=C.UTF-8
```

**Starting and stopping a cluster**:

```bash
# Direct control (suitable for troubleshooting)
pg_ctl -D /var/lib/postgresql/16/main -l /tmp/pg.log start
pg_ctl -D /var/lib/postgresql/16/main stop -m fast

# In production, leave it to systemd (recommended)
sudo systemctl start postgresql      # Debian/Ubuntu package name
sudo systemctl start postgresql-16   # PGDG package name
```

The stop mode `-m` has three levels: `fast` (the default; waits for clients to disconnect), `immediate` (kills outright; recovery is required next time), and `smart` (waits for all sessions to end). For routine maintenance, `fast` is enough.

## Creating a Database, a User, and Your First SQL

After the service is installed, only the `postgres` superuser exists by default. In production, create a separate application account; for local trials you can just use `postgres`.

```bash
# On Debian/Ubuntu, peer authentication for the postgres user requires the same system username
sudo -u postgres psql
```

```sql
-- Create the user and database (run as superuser)
CREATE ROLE app LOGIN PASSWORD 'secret';
CREATE DATABASE appdb OWNER app;

-- Connect to the new database (open another terminal, or \c appdb inside psql)
-- psql -U app -d appdb

-- First SQL: create a table, insert data, and query
CREATE TABLE users (
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name  text        NOT NULL,
    email text        UNIQUE NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO users (name, email) VALUES
    ('Zhang San', 'zhangsan@example.com'),
    ('Li Si', 'lisi@example.com');

SELECT id, name, created_at FROM users ORDER BY id;
```

Seeing two rows returned means the whole chain (install -> initialize -> create database -> create table -> query) is working.

## Caveats and Common Pitfalls

- **Do not run postgres as root**: the official server refuses to start as root; you must use a dedicated system user (the `postgres` user on Debian-family systems, the same on PGDG installations).
- **You cannot copy the data directory and start it elsewhere**: cross-host migration must go through PITR / logical backups (see [Backup Strategy](/operations/backup-strategy)); copying files only barely works for the same version and architecture.
- **Port and listen address**: default 5432, listening only on `localhost`; `listen_addresses` and `pg_hba.conf` decide who can connect, and after changing them you need `reload` or a restart.
- **`createdb` / `createuser` are command-line shortcuts**: they are essentially wrapped SQL, equivalent to `CREATE DATABASE` / `CREATE ROLE`, suitable for scripted database creation.
- **When you forget the password**: temporarily change local authentication in `pg_hba.conf` to `trust`, reload, then use `psql -U postgres` to set the password, then change it back to the original rule — and do not forget to `reload`.

## References

- [postgresql.org/media/keys/ACCC4CF8.asc](https://www.postgresql.org/media/keys/ACCC4CF8.asc)
- [apt.postgresql.org/pub/repos/apt](https://apt.postgresql.org/pub/repos/apt)
- [download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm](https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm)
- [postgresql.org/download/windows](https://www.postgresql.org/download/windows/)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [What Is PostgreSQL](/basics/what-is-postgresql)
- [Everyday psql](/basics/psql-getting-started)
- [Connection Management](/operations/connection-management)
- [Version Upgrade](/operations/version-upgrade)
- [Basics & Core SQL](/basics/index)
- [Everyday psql](/basics/psql-getting-started)
- [What Is PostgreSQL](/basics/what-is-postgresql)
- [Cluster Init and Layout](/operations/cluster-init-and-layout)
- [Local Dev Environment](/tools/local-dev-environment)
