# SSL and Transport Encryption

By default the protocol traffic between client and server is cleartext: queries, parameters, even the authentication exchange itself can be seen by any device on the path. With TLS on, transport encryption is handled by OpenSSL; the server-side configuration lives in two places — the `ssl_*` parameters in `postgresql.conf` and the `hostssl` records in pg_hba. How the client validates the server's identity is decided by the `sslmode` level — encrypting without validating does not stop a man in the middle.

## Quick start: generate a certificate and turn on ssl

For a test or intranet self-signed setup, one openssl command generates a self-signed certificate (production should use an internal CA or a trusted certificate):

```bash
openssl req -new -x509 -days 365 -nodes -subj "/CN=db.internal" \
  -addext "subjectAltName=DNS:db.internal" \
  -keyout server.key -out server.crt
```

```plaintext
# postgresql.conf
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
ssl_min_protocol_version = 'TLSv1.2'
```

The private key must be owned by the system user running postgres with permissions `0600`, otherwise startup fails with `private key file has group or world access`. After restarting, verify with `psql "host=db.internal sslmode=verify-full"`; `\conninfo` shows whether the current connection is encrypted and how the certificate checked out.

## ssl_min_protocol_version

The default has been `TLSv1.2` since PG 12 (earlier versions defaulted to TLSv1, and old protocols should not be re-enabled). If you have no legacy baggage, pin it straight to `TLSv1.2`; when you genuinely have old clients, lower it first and migrate them step by step, isolating the old clients into their own pg_hba rules. The corresponding `ssl_max_protocol_version` defaults to empty (no upper bound) and is usually left alone.

## Forcing encryption in pg_hba: hostssl

`ssl=on` only "allows" encryption — a client can still go cleartext (`sslmode=prefer` tries encryption first but falls back to cleartext on failure). Forcing encryption is pg_hba's job: write every business rule as `hostssl` and close the file with a single `host all all 0.0.0.0/0 reject`, and cleartext connections are refused outright. Record syntax and ordering rules are in [pg_hba and Authentication](./pg-hba-and-authentication).

## The six sslmode levels

| sslmode | Encrypted | Validates the server certificate | Stops MITM |
| --- | --- | --- | --- |
| `disable` | No | — | No |
| `allow` | Try cleartext first, then TLS | No | No |
| `prefer` (default) | Try TLS first, fall back to cleartext | No | No |
| `require` | Yes | No | Weak: no identity check; a MITM presenting its own self-signed certificate still connects |
| `verify-ca` | Yes | Validates the CA chain | Medium: the certificate is trusted but the host name is not checked |
| `verify-full` | Yes | Validates the CA chain + host name match | Yes |

The key takeaway: `require` only guarantees "this connection is encrypted" and never confirms who is on the other end — an attacker presenting a self-signed certificate of their own still establishes an encrypted connection and captures your data. Production clients should standardize on `verify-full` and distribute a trusted CA: the `sslrootcert` parameter points at the CA file, and from PG 16 `sslrootcert=system` uses the operating system's certificate store directly, skipping manual distribution.

PG 17 added a handshake optimization: libpq gained the `sslnegotiation=direct` connection parameter, letting the client start the TLS handshake straight on the TCP connection and skipping the cleartext round trip where the traditional flow first probes whether SSL is supported (requires ALPN support in OpenSSL 3.2+ on both ends). This is a performance optimization, unrelated to certificate validation levels.

## Certificate rotation: reload is enough, no restart

The server certificate, private key, CA, and revocation list are **re-read at startup and on every configuration reload**, so from PG 10 on rotating certificates needs no restart:

```bash
cp new-server.crt $PGDATA/server.crt
cp new-server.key $PGDATA/server.key
chown postgres:postgres $PGDATA/server.*
chmod 600 $PGDATA/server.key
psql -U postgres -c "SELECT pg_reload_conf();"   # new connections use the new certificate; established ones are unaffected
```

When the private key is passphrase-protected, pair it with `ssl_passphrase_command` to fetch the passphrase from a key management service, so an unattended restart doesn't hang on the interactive prompt.

## Observing connection encryption: pg_stat_ssl

```sql
SELECT a.pid, a.usename, a.application_name, a.client_addr,
       s.ssl, s.version, s.cipher, s.bits
FROM pg_stat_activity a
JOIN pg_stat_ssl s USING (pid)
WHERE a.datname IS NOT NULL;
```

Rows with `ssl = f` are the unencrypted connections — find the source via `application_name` and `client_addr`, then add `verify-full` to its connection string. This query makes a good standing item in security inspections; fold it into [Monitoring and Alerting](../operations/monitoring-and-alerting) to run on a schedule.

## Caveats and common pitfalls

- libpq defaults to `sslmode=prefer`: once a cluster without configured certificates turns on `ssl=on`, clients are usually already on TLS, but the "fall back to cleartext" semantics are still there — to force it, use `hostssl` plus a reject closing rule.
- A self-signed certificate with `sslmode=require` only encrypts and never validates identity; to use `verify-full` the certificate's SAN (subjectAltName) must be written as the host name the client actually connects to, or validation fails.
- Client certificate authentication (mutual TLS) is a separate layer: set the pg_hba method to `cert`, have the client carry `sslcert`/`sslkey`, and the certificate CN must match the database user.
- Managed cloud databases often terminate TLS at the proxy layer, so `pg_stat_ssl` may not reflect the full path — defer to the vendor's documentation.
- TLS overhead is usually in the low single-digit percentages and largely negligible once a connection pool keeps long connections alive; don't disable encryption for performance.
- Forgetting to rotate an expiring certificate breaks every new connection; track expiry in your certificate management or use something like cert-manager for automatic issuance.

## References

- [PostgreSQL official docs · 5.9. Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [PostgreSQL official docs · 20.3. Authentication Methods](https://www.postgresql.org/docs/current/auth-methods.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [pg_hba and Authentication](./pg-hba-and-authentication)
- [Encryption at Rest](./data-encryption-at-rest)
- [Hardening Checklist](./hardening-checklist)
- [Monitoring and Alerting](../operations/monitoring-and-alerting)
- [data-encryption-at-rest](data-encryption-at-rest.md)
- [hardening-checklist](hardening-checklist.md)
- [index](index.md)
- [pg-hba-and-authentication](pg-hba-and-authentication.md)
Official docs: [SSL/TLS support](https://www.postgresql.org/docs/current/ssl-tcp.html), [libpq SSL support](https://www.postgresql.org/docs/current/libpq-ssl.html), [pg_stat_ssl](https://www.postgresql.org/docs/current/monitoring-stats.html).
