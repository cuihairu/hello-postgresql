# Encryption at Rest

Encryption at rest answers the question: when the disk is taken away (or a cloud snapshot or backup file is dragged off), can the data files, WAL, temp files, and backups inside still be read? It is no substitute for transport encryption ([SSL and Transport Encryption](./ssl-and-transport-encryption)): one covers "at rest", the other "in transit".

## Current state: the kernel has no built-in TDE

The PostgreSQL kernel still has no built-in transparent data encryption (TDE): data files and WAL both land on disk in cleartext. Community discussion and patches around cluster-level TDE have gone on for years (key management, performance, and compatibility with replication and the toolchain are the main sticking points), and as of this writing the official built-in solution still has no landing date. That shapes the selection logic:

- **Column-level encryption** (pgcrypto): precise, ciphertext travels with the data, but it intrudes on the application and limits retrieval — a fit for a handful of highly sensitive columns.
- **Storage-level encryption** (LUKS / cloud disk KMS): fully transparent to the database and covers every file, but it only protects against "the media walking away", not against an attacker holding OS root.

Choose by threat model, or stack both. A cloud vendor's "transparent database encryption" entrusts the key system to the platform side — at heart a storage-level scheme.

## Column-level encryption: pgcrypto

The `pgcrypto` extension provides OpenPGP symmetric encryption functions, suited to column-level sensitive data like ID numbers and bank card numbers:

```sql
CREATE EXTENSION pgcrypto;

CREATE TABLE payment_cards (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  holder  text NOT NULL,
  card_no bytea NOT NULL      -- ciphertext is binary; store it in bytea
);

-- write: the key is injected through a session GUC, see the next section
INSERT INTO payment_cards (holder, card_no)
VALUES ('alice', pgp_sym_encrypt('6222 0000 1234 5678', current_setting('app.enc_key')));

-- read
SELECT holder,
       pgp_sym_decrypt(card_no, current_setting('app.enc_key')) AS card_no
FROM payment_cards
WHERE id = 1;
```

Weigh the cost first: a plain index on the ciphertext column does nothing for "query by card number" (an equality condition must be decrypted before it can compare), and the same goes for `LIKE` and range queries. When you do need to search on an encrypted field, the common pattern is an extra HMAC (keyed hash) column with an index for equality lookups. So pgcrypto fits a small set of sensitive columns that are "written often, read by primary key", not whole-table encryption.

## Where the key comes from: never in the database, never in SQL text

The principle: the key does not land in the database (otherwise the ciphertext and the key travel together when the disk is taken), and it is not hard-coded in SQL or code. The common practice is for the application to fetch the key from a KMS / key service and inject it through a session GUC:

```sql
-- run by the driver or a pool hook after the connection is established, before business queries (bound parameter; the key never enters SQL text)
SELECT set_config('app.enc_key', $1, true);   -- true = current transaction only, gone when it ends
```

After that, every encryption/decryption wrapper reads the key uniformly via `current_setting('app.enc_key')`. The key never appears in business SQL text, so it cannot show up in `pg_stat_statements`, slow-query logs, or audit logs. A more complete wrapper implements encryption/decryption as `SECURITY DEFINER` functions, so the application sees only a plaintext interface and never touches the key; if the key service is unavailable, the injection fails and the query fails with it — design the failure direction to "fail safe".

## Storage-level encryption: file systems and cloud disks

| Scheme | Coverage | Characteristics | Limits |
| --- | --- | --- | --- |
| LUKS / dm-crypt | The whole disk (data directory, WAL, temp files all included) | Completely invisible to the database; `cryptsetup` set up once | Needs OS operations on board; managing the decryption passphrase demands the same rigor |
| ZFS native encryption | Per dataset | Integrates well with snapshots/replication | Tied to the ZFS ecosystem |
| Cloud disk encryption (KMS) | Block devices like EBS / Persistent Disk | Flip a switch and go, small performance impact | No defense against an attacker with OS root; key operations are under the cloud platform's control |

What they share: the database process sees plaintext, encryption happens at the block layer, and with AES-NI on modern CPUs the performance loss is usually low. The shared limitation: **anyone with OS root can read the plaintext** — it protects against lost media, leaked snapshots, and offline disk theft, not against lateral movement after a breach.

## Encrypting backups and WAL

With the data files encrypted, wherever WAL and backups land must be covered too, or the backup server is the cleartext copy easiest to walk away with:

```bash
# logical backup: encrypt on export
pg_dump -Fc appdb | gpg --encrypt --recipient dba@corp.example > appdb.dump.gpg

# restore
gpg --decrypt appdb.dump.gpg | pg_restore -d appdb
```

Physical backups and WAL archives should go straight to encrypted storage: enable SSE-KMS on S3-class object storage, or use backup tooling with encryption support (both WAL-G and pgBackRest support client-side encryption). When you run PITR recovery drills (see [Disaster Recovery Drills](../operations/disaster-recovery-drills)), put "can the current keys complete the restore" on the checklist — lose the keys, and an encrypted backup is lost data.

## Key rotation approach

- Column-level: add a `key_version int` column to the encrypted rows; during rotation, new writes use the new key version while a background job re-encrypts old data in batches, both keys decrypt during the transition, and the old key is retired when it's done. The key-version mechanism of a KMS supports this flow natively.
- Storage-level: LUKS supports online re-encryption with `cryptsetup reencrypt`; rotating the KMS key on a cloud disk usually means "new disk + data migration" — infrequent but heavy work.
- WAL cannot be re-encrypted after the fact; rely on storage-level key rotation, or shrink the exposure window with a shorter archive retention period.
- After any rotation, run one full recovery drill with the new key before retiring the old one.

## Caveats and common pitfalls

- Concatenating the key into a SQL string writes it into logs and `pg_stat_statements`; always inject it through bound parameters or a session GUC.
- Storing ciphertext in a `text` column is an encoding trap — use `bytea`; the decryption function errors out outright on corrupted ciphertext, so the read path needs exception handling.
- "The disk is encrypted, the backup isn't" is a frequent omission — bring backups under the same encryption policy.
- pgcrypto also ships `digest` / `hmac` / `crypt` and friends: store password hashes with `crypt + gen_salt('bf')`, not the `md5()` function family.
- Encryption is not auditing: who decrypted which data and when is answered by [Auditing](./audit).

## References

- [PostgreSQL official docs · 5.9. Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [PostgreSQL official docs · 20.3. Authentication Methods](https://www.postgresql.org/docs/current/auth-methods.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [SSL and Transport Encryption](./ssl-and-transport-encryption)
- [Backup strategy](../operations/backup-strategy)
- [Disaster Recovery Drills](../operations/disaster-recovery-drills)
- [Hardening Checklist](./hardening-checklist)
- [hardening-checklist](hardening-checklist.md)
- [index](index.md)
- [ssl-and-transport-encryption](ssl-and-transport-encryption.md)
Official docs: [pgcrypto](https://www.postgresql.org/docs/current/pgcrypto.html), [Encryption options](https://www.postgresql.org/docs/current/encryption-options.html).
