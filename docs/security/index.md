# Security

Roles and privileges, row-level security, authentication and encryption, auditing, and the hardening checklist.

- [Roles and the Permission Model](roles-and-permissions.md) — ROLE/GRANT/REVOKE, NOLOGIN and SUPERUSER attributes.
- [The Object Grant Hierarchy](object-grant-hierarchy.md) — grants at the database, schema, table, and column level, default privileges.
- [Row-Level Security](row-level-security.md) — policies, USING and FOR CHECK, combining with roles.
- [pg_hba and Authentication](pg-hba-and-authentication.md) — method ordering, hostssl, scram, diagnosing denials.
- [SSL and Transport Encryption](ssl-and-transport-encryption.md) — configuration, certificates, enforcing encryption.
- [Encryption at Rest](data-encryption-at-rest.md) — pgcrypto, key management, encrypting backups.
- [Auditing](audit.md) — pgaudit, log toggles, statement archiving.
- [Hardening Checklist](hardening-checklist.md) — least privilege, no superuser application connections, an extension allowlist.

---

- [Architecture & Operations](../operations/) — the security side of the network and deployment layer.
