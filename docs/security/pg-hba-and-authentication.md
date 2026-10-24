# pg_hba and Authentication

`pg_hba.conf` is the first gate on connection admission: for every connection that arrives, PostgreSQL matches the records in the file **top to bottom, one at a time**, and the first record that matches decides which way the connection is verified — verification fails and the connection is refused, with no further matching. So a wrong order (a broad rule first) makes every tightening rule after it completely inert. Authentication decides "who you are"; what you can access after logging in is decided by [Roles and the Permission Model](./roles-and-permissions), and whether the transport is encrypted is covered in [SSL and Transport Encryption](./ssl-and-transport-encryption).

## Record format and match order

Each record has five fields:

```plaintext
# type      database   user       address        auth method
hostssl     app        app_rw     10.0.1.0/24    scram-sha-256
host        all        all        0.0.0.0/0      reject
local       all        all                     peer
```

Matching rule: comparing "connection type + target database + user name + source address" record by record in file order, **the first record that matches on all of them wins**. The database field may be `all`, `sameuser`, `replication`, or a comma-separated list; the user field works the same way, where `+group-role-name` means every member of that group. After editing, run `SELECT pg_reload_conf();` (or `pg_ctl reload`) and it takes effect with no restart.

## Authentication methods at a glance

| Method | Behavior | Where to use it |
| --- | --- | --- |
| `trust` | Lets everyone through, no password check | Local development only; banned in production |
| `reject` | Refuses everyone | Blacklists and the default-deny closing rule |
| `peer` | Local sockets only; checks the OS user name against the database user | Local operations (the postgres user) |
| `scram-sha-256` | SCRAM challenge-response; the password never crosses the wire in cleartext | First choice for production network authentication |
| `md5` | MD5 challenge-response; stronger than cleartext but an obsolete algorithm | Legacy client compatibility |
| `cert` | Validates a client certificate; the CN must match the database user | Environments with a mature PKI |
| `gssapi` | Kerberos ticket authentication | Enterprise intranet single sign-on |
| `password` | Password sent in cleartext | Should never appear without a compelling reason |

Version note: `scram-sha-256` arrived in PG 10, and from PG 14 on new passwords are stored as SCRAM hashes by default (the previous default was md5). Both the `md5` and `scram` methods require the server to hold a password hash in the **corresponding form** — the most common pitfall, covered in the troubleshooting section below.

## Local sockets and peer: what to do when container identities don't line up

`local` records match only Unix domain socket connections. The `peer` method reads the client process's **operating system user name** (via SO_PEERCRED on Linux) and requires it to equal the requested database user — the `postgres` system user switches to the database postgres user with no password, while other OS users are refused. You can also use the `map=` option together with `pg_ident.conf` to map OS users to database users.

A frequent mismatch in container setups: in the official images the process runs as `postgres`, so local socket connections work fine; but application containers connect over TCP and never touch the `local` records. Conversely, when you want `psql -U app` straight over the socket inside a container, the OS user inside the container is usually root and peer fails immediately. Either switch to the matching OS user inside the container, or give that source its own TCP + password record — don't take the shortcut of changing `local` to `trust`.

## Address notation and hostssl / hostnossl

Four connection types: `local` (socket), `host` (TCP, matches with or without encryption), `hostssl` (TLS connections only), `hostnossl` (non-TLS connections only). Addresses use CIDR notation: `127.0.0.1/32`, `10.0.0.0/8`; IPv6 uses `::1/128`. Pairing `hostssl` with `ssl=on` on the server is the standard production form, forcing "this rule applies only to encrypted connections".

```plaintext
# production example: local peer + encrypted intranet + replication dedicated + refuse everything else
local   all          postgres    peer
hostssl app          app_rw      10.0.1.0/24    scram-sha-256
hostssl replication  repl_user   10.0.1.20/32   scram-sha-256
host    all          all         0.0.0.0/0      reject
```

Note that the database field of a replication connection must be the keyword `replication`, never a real database name.

## Verify first, then reload

```sql
-- syntax/format errors do not block a reload; they just make bad records silently ignored
SELECT line_number, type, database, user_name, address, auth_method, error
FROM pg_hba_file_rules
WHERE error IS NOT NULL;

SELECT pg_reload_conf();
```

The `pg_hba_file_rules` view parses the **file on disk**, not the currently active configuration. Checking `error IS NOT NULL` after adding records, before the reload, avoids a whole class of "I changed it and nothing happened" problems.

## The troubleshooting path for refused connections

Two typical errors, with different directions to look:

**1. `FATAL: no pg_hba.conf entry for host "x.x.x.x", user "...", database "..."`** —— no record matched at all. Check in order: the source address notation (is the mask right? `10.0.1.2` missing `/32` parses oddly), record order (did a broad rule or a reject earlier in the file catch it first), connection type (a TCP connection but only `local` configured). Use the `pg_hba_file_rules` view to confirm what each record actually parsed into.

**2. `FATAL: password authentication failed for user "..."`** —— a record matched, but password verification failed. The most common pitfall is a **mismatch between the authentication method and the password hash**: pg_hba says `scram-sha-256`, while the account's password is still an md5-era hash (existing accounts are not converted automatically after a PG 14 upgrade). To confirm:

```sql
SELECT rolname, left(rolpassword, 12) AS hash_head
FROM pg_authid
WHERE rolname = 'app_rw';   -- starts with SCRAM-SHA-256$ = scram; starts with md5 = legacy hash
```

Fix: align `password_encryption` with the pg_hba method, then reset the password `ALTER ROLE app_rw PASSWORD '...';` and retry. If the password itself is fine, turn on `log_connections` and re-read the server log for which record the connection hit and why it failed; older client drivers (libpq before PG 10, or third-party drivers not yet upgraded) don't support scram and surface as the same error.

## Caveats and common pitfalls

- A broad rule placed early makes every tightening rule after it ineffective; ending the file with `host all all 0.0.0.0/0 reject` is the sturdiest structure.
- Leftover `trust` entries (even if only for 127.0.0.1) can be "borrowed" by other processes or containers on the same host; cleaning them up takes one grep.
- pg_hba only decides "how identity is verified" and has nothing to do with object privileges; what you can see after a successful login is up to the role and grant system.
- Every connection runs authentication in full, so a very long pg_hba file or frequent reloads carry a slight overhead — usually negligible, but don't use pg_hba as an application rate limiter.
- Editing the file does nothing until you reload, and reloading silently skips bad records — bake the `pg_hba_file_rules` check into your change process.

## References

- [PostgreSQL official docs · 5.9. Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [PostgreSQL official docs · 20.3. Authentication Methods](https://www.postgresql.org/docs/current/auth-methods.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [SSL and Transport Encryption](./ssl-and-transport-encryption)
- [Roles and the Permission Model](./roles-and-permissions)
- [Hardening Checklist](./hardening-checklist)
- [Common errors and troubleshooting](../appendix/common-errors-and-troubleshooting)
- [knowledge](/knowledge.md)
- [audit](audit.md)
- [hardening-checklist](hardening-checklist.md)
- [index](index.md)
- [roles-and-permissions](roles-and-permissions.md)
- [row-level-security](row-level-security.md)
- [ssl-and-transport-encryption](ssl-and-transport-encryption.md)
- [dbeaver-and-vscode](/tools/dbeaver-and-vscode.md)
- [pgadmin-4](/tools/pgadmin-4.md)
Official docs: [The pg_hba.conf file](https://www.postgresql.org/docs/current/auth-pg-hba-conf.html), [Authentication methods](https://www.postgresql.org/docs/current/auth-methods.html), [User name maps](https://www.postgresql.org/docs/current/auth-username-maps.html).
