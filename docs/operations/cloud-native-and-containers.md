# Cloud-Native and Containers

Running PostgreSQL inside containers comes down to one core problem: the data directory must be a persistent volume, because the container layer can be replaced at any time. Around that, Docker solves it with volume mounts, K8s with PVC + StatefulSet, and above that an operator handles automated failover and backups. Local development and production containerization have different requirements, so there's no need to force one shared approach.

## Official Docker images and data on a volume

The official images `postgres:17` (Debian base) and `postgres:17-alpine` both point `PGDATA` at `/var/lib/postgresql/data`. The container filesystem is ephemeral, so without a volume mount, `docker rm` takes the data with it.

```bash
# the simplest survivable setup: write data to a named volume
docker volume create pgdata
docker run -d --name pg17 \
  -e POSTGRES_PASSWORD=devpass \
  -e POSTGRES_DB=app \
  -v pgdata:/var/lib/postgresql/data \
  -p 5432:5432 \
  postgres:17

# more common in production: bind-mount to a host directory, so backup tools can point at the directory directly
docker run -d --name pg17 \
  -v /data/pg17:/var/lib/postgresql/data \
  postgres:17
```

Notes:

- The image's first-time initialization (`initdb`) only runs when `PGDATA` is empty; `POSTGRES_PASSWORD` only takes effect at initialization, so changing the environment variable later does not change the password in the database.
- The official image's `POSTGRES_USER` defaults to `postgres`; in production, explicitly specify a business user and database rather than connecting the application as a superuser.
- The mounted volume's owner must be the `postgres` user (uid 999 inside the image); wrong permissions will cause startup failure.

## Minimal docker compose configuration

```yaml
# docker-compose.yml
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_DB: app
      POSTGRES_USER: app
      POSTGRES_PASSWORD: changeme
      POSTGRES_INITDB_ARGS: "--data-checksums"
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    restart: unless-stopped

volumes:
  pgdata:
```

A `healthcheck` using `pg_isready` is enough — don't run heavy queries in a healthcheck. `pg_isready` only probes that a connection is reachable and doesn't authenticate, which makes it a good fit as a liveness probe.

Passwords shouldn't live in the compose file; inject them via a `.env` file or secrets:

```yaml
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/pg_password
    secrets:
      - pg_password

secrets:
  pg_password:
    file: ./pg_password.txt
```

Environment variables with the `*_FILE` suffix (`POSTGRES_PASSWORD_FILE`, `POSTGRES_USER_FILE`, etc.) are the secrets mechanism the official image supports, and it applies the same way in K8s.

## Kubernetes StatefulSet essentials

For stateful services on K8s, a StatefulSet is a better fit than a Deployment, for three reasons:

- **Stable network identity**: Pod names are fixed (e.g. `pg-0`, `pg-1`), so after a primary/standby switchover clients find the primary through a Service or the read-write-splitting Service an operator provides, without chasing Pod IPs.
- **Ordered deployment and rolling updates**: a StatefulSet updates Pods one at a time in index order — standbys restart first, the primary last — which lines up naturally with HA tools' switchover semantics.
- **A separate PVC per Pod**: `volumeClaimTemplates` ensures that when `pg-0` is recreated it remounts the original disk, so no data is lost.

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: pg
spec:
  serviceName: pg
  replicas: 1            # single-primary setups are usually replicas=1; primary/standby is managed by an operator
  selector:
    matchLabels:
      app: pg
  template:
    metadata:
      labels:
        app: pg
    spec:
      containers:
        - name: postgres
          image: postgres:17
          ports:
            - containerPort: 5432
          env:
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: pg-secret
                  key: password
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
          readinessProbe:
            exec:
              command: ["pg_isready", "-U", "postgres"]
            initialDelaySeconds: 10
            periodSeconds: 10
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 50Gi
```

With two replicas, StatefulSet itself doesn't solve "who is primary": both Pods can come up, and if one dies, `postgres` won't start up in a primary role — you need external arbitration. That layer is where an operator comes in:

- **CloudNativePG** (a CNCF project): native K8s CRDs, declaratively defining cluster replica counts, backups to object storage, and automatic failover.
- **Zalando Postgres Operator**: provides HA in conjunction with Patroni, paired with the Spilo image, and suits teams that already have Patroni experience.
- An operator also takes care of the surrounding issues — WAL archiving to S3, PITR, injecting monitoring exporters — far less effort than hand-writing a StatefulSet (see [High Availability Architectures](./high-availability-architecture)).

For config injection, prefer mounting `postgresql.conf` snippets via ConfigMap or controlling initdb behavior with `POSTGRES_INITDB_ARGS`; for runtime parameters, use `ALTER SYSTEM` to write into `postgresql.auto.conf`, avoiding Pod rebuilds just to change a mounted config file.

## Local development vs production containerization

The two have different goals, so there's no need to force them into one model:

| Dimension | Local development container | Production containerization |
| --- | --- | --- |
| Focus | Starts fast, version matches production | Data reliability, failover, backups |
| Data volume | A named volume is fine, disposable at will | PVC / cloud disk, folded into the backup strategy |
| Replica count | 1 | 1 primary + N standbys, managed by an operator |
| Configuration | Defaults are fine | Explicit resource limits, secrets, probes |
| Upgrading | Change the image tag | Follow the [Version Upgrades](./version-upgrade) process |

A common pitfall: local development runs containers smoothly, so production copies the "one container + one volume" setup verbatim, and the result is no backups, no monitoring, no HA — a full disk or a node failure becomes an incident. Containerization solves deployment and isolation; it does not automatically solve reliability, which still needs [Backup Strategy](./backup-strategy) and [Monitoring and Alerting](./monitoring-and-alerting) to fill in.

Another pitfall is resource limits: setting a `memory limit` on the container without correspondingly shrinking `shared_buffers` and `work_mem` lets the cgroup OOM killer kill postmaster outright, and the instance restarts in a loop. Plan container memory limits together with PG's memory parameters (see [Architecture and Memory](../internals/architecture-and-memory)).

## Further reading

- [hub.docker.com/_/postgres](https://hub.docker.com/_/postgres)
- [PostgreSQL official docs · Chapter 19. Server Configuration](https://www.postgresql.org/docs/current/runtime-config.html)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [when-to-choose-postgresql](/ecosystem/when-to-choose-postgresql.md)
- [index](index.md)- [Cluster Init and Directory Layout](./cluster-init-and-layout) — the basics of initdb and the data directory.
- [High Availability Architectures](./high-availability-architecture) — operator and Patroni switchover mechanisms.
- [Backup Strategy](./backup-strategy) — how backups land in a container environment.

Official images and usage on Docker Hub: <https://hub.docker.com/_/postgres>; for runtime parameters see: <https://www.postgresql.org/docs/current/runtime-config.html>
