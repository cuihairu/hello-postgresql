# 本地开发环境

本地库的第一目标是"一条命令起起来"，第二目标是"随时能重置"。用官方 Docker 镜像加一个 compose 文件可以同时满足两者。

## docker compose 起库

仓库根目录放一个 `docker-compose.yml`：

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

几个官方镜像的行为细节：

- `/docker-entrypoint-initdb.d/` 下的 `.sql`、`.sql.gz`、`.sh` 会在**数据目录为空时**按文件名排序执行——只有首次启动有效，之后改 init 脚本要删卷重建；
- 数据卷用命名卷 `pgdata` 而非目录挂载，能避开本地目录属主/权限的坑（Docker 把宿主目录挂进去时常报初始化失败）；
- `pg_isready` 健康检查让编排工具能感知"库起来了"，应用容器用 `depends_on: { db: { condition: service_healthy } }` 等待就绪；
- 镜像里同时存在 `postgres:16`、`postgres:17` 等标签，团队统一用一个主版本，避免本地与生产版本漂移。

## seed 数据策略

init 目录放两个文件，用数字前缀保证顺序：

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
VALUES ('张三', 'zhangsan@example.com'), ('李四', 'lisi@example.com')
ON CONFLICT (email) DO NOTHING;

INSERT INTO orders (user_id, amount)
SELECT u.id, (random() * 1000)::numeric(10,2)
FROM users u
CROSS JOIN generate_series(1, 50);
```

schema 与数据分离的价值：重置数据不动结构、CI 可以只应用 schema、seed 文件里的 `ON CONFLICT DO NOTHING` 保证幂等，多次执行不重复插。仓库里有真实脱敏样例时放进 seed，没有就在本地库里积累。

## 测试库隔离

测试最怕互相污染，三种隔离粒度由轻到重：

**方案 A：每测试事务回滚。** 每个测试包在 `BEGIN ... ROLLBACK` 里，库状态不变、并发度高、跑得快。前提是**被测代码不能自己 `COMMIT`**——它一提交回滚就白费，需要改用连接池拦截或显式事务嵌套来规避。

**方案 B：克隆模板库。** 每个测试一个独立库，互相彻底隔离：

```sql
-- 模板库建好、没有活动连接时执行
CREATE DATABASE test_order_flow TEMPLATE dev_db;
-- 测试结束后
DROP DATABASE test_order_flow;
```

克隆瞬间完成（拷贝文件而非逐行插入），适合集成测试。注意模板库要求**无任何活动连接**（含模板库自己的），先确认再克隆。

**方案 C：每测试一个 schema。** 建库成本降为零，共享连接池；代价是 `search_path` 必须严格按测试重置，跨 schema 的残留会互相干扰。

一个常见做法是单测用方案 A、集成测试用方案 B，开发容器里手动测试直接用主库。

## psql 别名与环境变量

交互连本地库时不需要每次敲全连接参数，psql 会依次读命令行参数、环境变量、默认值：

```bash
# 放 ~/.bashrc / ~/.zshrc，或放项目的 .envrc（direnv 加载）
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=app PGDATABASE=appdb

alias psql='psql -P pager=off -P null="(null)"'
alias pgexec='psql -X -v ON_ERROR_STOP=1 -f'
```

密码提示可以用 `~/.pgpass` 解决（权限必须 0600）：`127.0.0.1:5432:appdb:app:app`。密码进了 shell 历史或别处的写法都不应该出现在代码里，见[客户端驱动](/zh/tools/client-drivers)的连接串章节。

psql 的日常用法（`\d`、`\x`、`\copy`）见[psql 常用操作](/zh/basics/psql-getting-started)与[psql 高阶](/zh/tools/psql-advanced)；第一次在机器上装 PostgreSQL 见[安装与首次连接](/zh/basics/install-and-quickstart)。

## 参考资料

- [PostgreSQL 官方文档 · psql](https://www.postgresql.org/docs/current/app-psql.html)
- [PostgreSQL 官方文档 · F.32. pg_stat_statements — track statistics of SQL planning and execution](https://www.postgresql.org/docs/current/pgstatstatements.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [psql 高阶](/zh/tools/psql-advanced)
- [schema 迁移工具](/zh/tools/schema-migration-tools)
- [客户端驱动](/zh/tools/client-drivers)
- [安装与首次连接](/zh/basics/install-and-quickstart)
- [index](/zh/tools/index)
- [psql-advanced](/zh/tools/psql-advanced)
- [schema-migration-tools](/zh/tools/schema-migration-tools)
官方文档：[postgres 镜像文档](https://hub.docker.com/_/postgres)、[模板数据库](https://www.postgresql.org/docs/current/manage-ag-templatedbs.html)、[libpq 环境变量](https://www.postgresql.org/docs/current/libpq-envars.html)。
