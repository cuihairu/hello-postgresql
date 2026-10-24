# Hardening Checklist

The points scattered across the security pages are collected here into one runnable checklist: each item comes with the command to execute, suitable for a pass before a new environment goes live, and usable as the basis for quarterly inspections of an existing instance. The reasoning and full explanation behind each item live on the corresponding page; this page keeps only "what to do, and how".

## Network: shrink the exposure surface

**Bind to the intranet address, not `0.0.0.0`** (a purely local application listens on localhost only):

```plaintext
# postgresql.conf
listen_addresses = '10.0.1.10'    # intranet IP; 'localhost' for local-only use
```

**Minimize pg_hba**: delete every `trust` and every overly broad subnet rule, with a default deny at the end:

```bash
grep -n "trust" "$(psql -U postgres -tAc 'SHOW hba_file')"   # find leftover trust
```

```plaintext
# pg_hba.conf target shape: exact subnets + forced encryption + default deny
hostssl  app  app_rw  10.0.1.0/24  scram-sha-256
host     all  all      0.0.0.0/0    reject
```

**The host firewall opens 5432 only to the application subnet**:

```bash
ufw allow from 10.0.1.0/24 to any port 5432 proto tcp
```

## Accounts: never run the application as a superuser

**Forbid superusers from logging in over the network** — a superuser bypasses every privilege check, so GRANT/REVOKE is useless against one; only pg_hba can block it:

```plaintext
# pg_hba.conf: postgres allows local peer only
local  all  postgres  peer
host   all  postgres  0.0.0.0/0  reject
```

**The application uses a dedicated least-privilege role**; connecting directly as owner or superuser is off-limits (role split in [Roles and the Permission Model](./roles-and-permissions)):

```sql
CREATE ROLE app_svc LOGIN PASSWORD '...' IN ROLE app_rw;
```

**Passwords use SCRAM with an expiry set**, with complexity enforced by an extension:

```sql
SET password_encryption = 'scram-sha-256';
ALTER ROLE app_svc PASSWORD '...' VALID UNTIL '2027-06-30';
```

```plaintext
# reject weak passwords outright: the passwordcheck extension (requires a restart)
shared_preload_libraries = 'passwordcheck'
```

## Privileges: take the default grants back from PUBLIC

**Revoke the default grants on database connect and the public schema** (versions before PG 15 need to do it manually; from PG 15 on, schema CREATE is already revoked by default — see [The Object Grant Hierarchy](./object-grant-hierarchy)):

```sql
REVOKE CONNECT ON DATABASE app FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

**Revoke EXECUTE from PUBLIC on sensitive functions**:

```sql
REVOKE EXECUTE ON FUNCTION gen_token(text) FROM PUBLIC;
```

**Cover future objects with DEFAULT PRIVILEGES** so new tables don't go naked:

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
```

**Inspect for attributes a business role should never hold** (the result should be empty):

```sql
SELECT rolname, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
FROM pg_roles
WHERE rolcanlogin AND (rolcreatedb OR rolcreaterole
      OR rolreplication OR rolbypassrls OR rolsuper)
  AND rolname NOT IN ('postgres');
```

## Transport: force TLS

**Turn on ssl server-side with a floor of TLSv1.2, and write every pg_hba business rule as `hostssl`** (certificate generation and rotation in [SSL and Transport Encryption](./ssl-and-transport-encryption)):

```plaintext
ssl = on
ssl_min_protocol_version = 'TLSv1.2'
```

**Standardize client connection strings on `sslmode=verify-full`**, distribute the CA via `sslrootcert` (`sslrootcert=system` from PG 16 on), and never allow falling back to `require` or below.

**Inspect for unencrypted connections and drive them to zero** (the result should be empty):

```sql
SELECT a.pid, a.usename, a.application_name, a.client_addr
FROM pg_stat_activity a
JOIN pg_stat_ssl s USING (pid)
WHERE a.datname IS NOT NULL AND NOT s.ssl;
```

## Data: choose the encryption layer by sensitivity

- Highly sensitive columns get pgcrypto column-level encryption, with the key injected via a KMS and never landing in the database or the logs (see [Encryption at Rest](./data-encryption-at-rest)).
- Enable LUKS or cloud disk encryption on the volume holding the data directory, covering data files, WAL, and temp files.
- Backups and WAL archives go to encrypted storage; logical backups are encrypted on export:

```bash
pg_dump -Fc appdb | gpg --encrypt --recipient dba@corp.example > appdb.dump.gpg
```

## Configuration: timeouts, logging, and loadable libraries

**Set statement and transaction timeouts on business roles** so a runaway query cannot drag the instance down:

```sql
ALTER ROLE app_rw SET statement_timeout = '30s';
ALTER ROLE app_rw SET idle_in_transaction_session_timeout = '5min';
```

**Turn on the baseline audit parameters and feed a remote collector** (suggested combinations in [Auditing](./audit)):

```plaintext
log_connections = on
log_min_duration_statement = 500ms
```

**Restrict loadable libraries**: non-superusers may only load libraries on the `local_preload_libraries` whitelist and located under `$libdir/plugins` — move the extensions ordinary user sessions may load into that directory and refuse everything else, closing the injection surface of third-party function libraries.

**Confirm the default extension surface**: don't install extras that show up in `available_extensions`, and don't enable what isn't in `pg_extension` — install on demand.

## Upgrades and vulnerability tracking

**Subscribe to security announcements and track versions**: the [PostgreSQL security information page](https://www.postgresql.org/support/security/) and the security announcement mailing list; a minor release usually follows within days of a new CVE.

**Apply minor releases (including CVE fixes) promptly**: a minor upgrade involves no data format conversion, and the downtime window is usually just one restart:

```bash
apt-get update && apt-get install --only-upgrade postgresql-17
systemctl restart postgresql
```

**Check whether the current version is a known-vulnerable one**:

```sql
SELECT version();   -- check the exact minor version against the security announcements
```

## References

- [postgresql.org/support/security](https://www.postgresql.org/support/security/)
- [PostgreSQL official docs · 5.9. Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Roles and the Permission Model](./roles-and-permissions)
- [pg_hba and Authentication](./pg-hba-and-authentication)
- [SSL and Transport Encryption](./ssl-and-transport-encryption)
- [Auditing](./audit)
- [database-and-schema-objects](/basics/database-and-schema-objects.md)
- [audit](audit.md)
- [data-encryption-at-rest](data-encryption-at-rest.md)
- [index](index.md)
- [object-grant-hierarchy](object-grant-hierarchy.md)
- [pg-hba-and-authentication](pg-hba-and-authentication.md)
- [roles-and-permissions](roles-and-permissions.md)
- [row-level-security](row-level-security.md)
- [ssl-and-transport-encryption](ssl-and-transport-encryption.md)
Official docs: [Server configuration](https://www.postgresql.org/docs/current/runtime-config.html), [Security announcements](https://www.postgresql.org/support/security/).
