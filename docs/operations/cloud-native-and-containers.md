# 云原生与容器

把 PostgreSQL 放进容器里跑，核心问题只有一个：数据目录必须是持久卷，容器层随时可以被替换。围绕这一点，Docker 用卷挂载解决，K8s 用 PVC + StatefulSet 解决，再往上 operator 解决自动化切换与备份。本地开发和生产容器化的诉求不同，不必用同一套方案。

## 官方 Docker 镜像与数据落卷

官方镜像 `postgres:17`（Debian 基础）和 `postgres:17-alpine` 都把 `PGDATA` 指到 `/var/lib/postgresql/data`。容器文件系统是临时的，不挂卷的话 `docker rm` 就把数据带走了。

```bash
# 最简单的可存续跑法：数据写到命名卷
docker volume create pgdata
docker run -d --name pg17 \
  -e POSTGRES_PASSWORD=devpass \
  -e POSTGRES_DB=app \
  -v pgdata:/var/lib/postgresql/data \
  -p 5432:5432 \
  postgres:17

# 生产更常见的做法：绑定挂载到宿主机目录，备份工具直接对着目录来
docker run -d --name pg17 \
  -v /data/pg17:/var/lib/postgresql/data \
  postgres:17
```

注意：

- 镜像首次初始化（`initdb`）只在 `PGDATA` 为空时执行；`POSTGRES_PASSWORD` 只在初始化时生效，之后改环境变量不会改数据库里的密码。
- 官方镜像的 `POSTGRES_USER` 默认是 `postgres`，生产上建议显式指定业务用户与数据库，不要拿超级用户连应用。
- 挂载卷的所有者必须是 `postgres` 用户（镜像内 uid 999），权限不对会导致启动失败。

## docker compose 最小配置

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

`healthcheck` 用 `pg_isready` 即可，不要在 healthcheck 里跑重查询。`pg_isready` 只探测连接可达，不做认证，适合当存活探针。

密码不建议写在 compose 文件里，用 `.env` 文件或 secrets 注入：

```yaml
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/pg_password
    secrets:
      - pg_password

secrets:
  pg_password:
    file: ./pg_password.txt
```

`*_FILE` 后缀的环境变量（`POSTGRES_PASSWORD_FILE`、`POSTGRES_USER_FILE` 等）是官方镜像支持的 secrets 方式，K8s 里同样适用。

## Kubernetes StatefulSet 要点

在 K8s 上跑有状态服务，StatefulSet 比 Deployment 合适，原因有三：

- **稳定的网络标识**：Pod 名固定（如 `pg-0`、`pg-1`），主从切换后客户端通过 Service 或 operator 提供的读写分离 Service 找到主库，不用追着 Pod IP。
- **有序部署与滚动更新**：StatefulSet 按序号逐个更新 Pod，从库先重启、主库最后动，天然配合 HA 工具的切换语义。
- **每个 Pod 独立 PVC**：`volumeClaimTemplates` 保证 `pg-0` 重建后仍挂回原来那块盘，数据不丢。

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: pg
spec:
  serviceName: pg
  replicas: 1            # 单主架构通常 replicas=1，主从用 operator 管理
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

双副本「谁是主」的问题 StatefulSet 本身不解决：两个 Pod 都能起来，谁挂了 `postgres` 不会再起主库角色，需要外加仲裁。这一层交给 operator：

- **CloudNativePG**（CNCF 项目）：原生 K8s CRD，声明式定义集群副本数、备份到对象存储、自动 failover。
- **Zalando Postgres Operator**：配合 Patroni 做 HA，与 Spilo 镜像搭配，适合已有 Patroni 经验的团队。
- operator 还顺带解决了 WAL 归档到 S3、PITR、监控 exporter 注入这些周边问题，比手写 StatefulSet 省力得多（见 [高可用架构](./high-availability-architecture)）。

配置注入建议用 ConfigMap 挂载 `postgresql.conf` 片段或用 `POSTGRES_INITDB_ARGS` 控制 initdb 行为；运行期参数用 `ALTER SYSTEM` 写进 `postgresql.auto.conf`，避免改动挂载的配置文件需要重建 Pod。

## 本地开发 vs 生产容器化

两者目标不同，不必强行统一：

| 维度 | 本地开发容器 | 生产容器化 |
| --- | --- | --- |
| 关注点 | 起得快、版本与生产一致 | 数据可靠、可切换、可备份 |
| 数据卷 | 命名卷即可，随时可丢 | PVC / 云盘，纳入备份策略 |
| 副本数 | 1 | 1 主 N 从，operator 管理 |
| 配置 | 默认即可 | 显式资源限制、secrets、探针 |
| 升级 | 换镜像 tag | 走 [版本升级](./version-upgrade) 流程 |

一个常见坑：本地开发用容器跑得很顺，生产也照搬「一个容器 + 一个卷」，结果没有备份、没有监控、没有 HA，磁盘满或节点故障就是一次事故。容器化解决的是部署与隔离，不自动解决可靠性，后两者仍要靠 [备份策略](./backup-strategy) 与 [监控告警](./monitoring-and-alerting) 补齐。

另一个坑是资源限制：给容器设了 `memory limit` 却没同步调小 `shared_buffers` 和 `work_mem`，cgroup OOM killer 会直接杀掉 postmaster，实例反复重启。容器的内存限制要和 PG 内存参数一起规划（见 [架构与内存](../internals/architecture-and-memory)）。

## 相关页面

- [集群初始化与目录布局](./cluster-init-and-layout)——initdb 与数据目录的基础。
- [高可用架构](./high-availability-architecture)——operator 与 Patroni 的切换机制。
- [备份策略](./backup-strategy)——容器环境下备份怎么落地。

官方镜像与用法见 Docker Hub：<https://hub.docker.com/_/postgres>；运行期参数参考：<https://www.postgresql.org/docs/current/runtime-config.html>
