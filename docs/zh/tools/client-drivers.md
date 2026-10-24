# 客户端驱动

数据库性能问题里相当一部分与 SQL 本身无关，而出现在应用侧的连接使用和参数传递方式上。这里整理两个主流驱动的正确用法、连接串关键参数，以及连接池的分工。

## psycopg 3（Python）

```bash
pip install "psycopg[binary]"
```

```python
import psycopg

conn = psycopg.connect("postgresql://app:secret@localhost:5432/appdb")

# 参数化：%s 占位符 + 参数元组，驱动负责转义
cur = conn.execute(
    "SELECT id, email FROM users WHERE status = %s ORDER BY id LIMIT %s",
    ("active", 10),
)
rows = cur.fetchall()

# psycopg 3 默认开启事务块，必须显式提交
cur.execute("UPDATE users SET status = %s WHERE id = %s", ("active", 1))
conn.commit()
```

三个要点：

- `conn.execute()` 直接返回游标，不必单独 `cursor()`；
- `psycopg 3.1` 起提供 **pipeline 模式**，把一批语句打包成一次网络往返，循环插入/更新场景收益明显：

```python
with conn.pipeline() as p:
    for uid in user_ids:
        conn.execute("INSERT INTO audit_log(user_id) VALUES (%s)", (uid,))
conn.commit()
```

- 参数永远走第二个参数元组，不要把它拼进 SQL 字符串。

## node-postgres（Node.js）

```bash
npm install pg
```

```javascript
const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'appdb',
  user: 'app',
  password: process.env.DATABASE_PASSWORD,
  max: 10,                       // 池内连接上限
  connectionTimeoutMillis: 2000,
});

const { rows } = await pool.query(
  'SELECT id, email FROM users WHERE status = $1 ORDER BY id LIMIT $2',
  ['active', 10],
);

await pool.end();
```

- 参数用 `$1`、`$2` 编号占位，与 Python 的 `%s` 等价，都是防止 SQL 注入的标准做法；
- **Pool** 是进程内连接池，负责复用与回收，Web 服务应全局共享一个 Pool；**Client** 是单条独立连接，适合需要固定会话状态或事务内不混用其他语句的场景，用完要 `release`/`end`；
- 从 Pool 借出连接跑长事务时会占住池位，其他请求会排队，长任务应单独用 Client。

## 连接串与关键参数

```plaintext
postgresql://app:secret@10.0.0.8:5432/appdb?sslmode=require&connect_timeout=5&application_name=orders-api
```

| 参数 | 作用 |
| --- | --- |
| `connect_timeout` | 建立连接的超时秒数，**不加它连接卡死时会一直等**，服务重启风暴时尤其需要 |
| `application_name` | 出现在 `pg_stat_activity.application_name`，排障时用它一眼认出请求来自哪个服务，见[排障工具箱](/zh/tools/troubleshooting-toolbox) |
| `sslmode` | `disable`/`require`/`verify-full`，跨公网或合规要求时至少 `require` |
| `host`/`port`/`sslmode` 的默认值 | 默认走本地 Unix socket、`sslmode` 默认 `prefer`，脚本里建议显式写全 |

连接串通常从环境变量读，不写进代码：`DATABASE_URL` 或按项拆成 `PGHOST`/`PGUSER`/`PGPASSWORD`。

## 为什么必须用连接池

PostgreSQL 是**一个连接一个后端进程**的进程模型：每个连接都要 fork 一个进程、分配内存、注册共享锁表资源（架构细节见[进程架构](/zh/internals/process-architecture)）。这意味着：

- 连接数直接等于进程数，100 个连接就是 100 个进程，几十个连接就开始明显增加调度与内存压力；
- `max_connections` 通常就设几百，超了直接被拒；
- 连接建立本身有握手、认证、可能还有 SSL 协商的开销，每次请求新建连接成本远高于复用。

于是连接池分两层：**应用内池**（Python 侧用 `psycopg_pool.Pool`，需安装 `psycopg[binary,pool]`；Node 侧用 `pg.Pool`）管自己进程内的复用，一个应用实例一个池、几十到上百个连接；**PgBouncer** 放在应用与数据库之间，管全部应用的连接总数，把成百上千个应用连接聚合到几十个 PostgreSQL 连接。PgBouncer 有两种模式：

- `session` 模式：连接与后端会话一一对应，行为最接近直连，但聚合能力弱；
- `transaction` 模式：一条连接在不同事务间复用，聚合程度最高，但要注意它会破坏会话级状态（`SET`、临时表、会话级 prepared statement）。

应用内池管"单实例并发"，PgBouncer 管"跨实例总量"，两者不是替代关系。serverless、容器弹性扩缩容、微服务数量多时几乎必装 PgBouncer。

## 参数化查询是底线

**字符串拼接 SQL 是注入的唯一源头，参数化是唯一的用户输入拼接方式**：

```python
# 危险：查询条件来自用户输入，被拼进 SQL
sql = f"SELECT * FROM users WHERE name = '{request.args['name']}'"
conn.execute(sql)          # 输入 ' OR '1'='1 时全表被读出

# 正确：占位符 + 参数
conn.execute("SELECT * FROM users WHERE name = %s", (request.args['name'],))
```

参数化不只防注入，还让相同 SQL 结构复用同一份已编译计划，对性能也有好处。凡是"看起来只是拼接个数字或日期"的地方一样要参数化——今天传数字，明天传用户 ID 数组，防线不该靠自律而靠习惯。批量写入的正确姿势见[批量写入](/zh/advanced-sql/batch-and-write)。

## 参考资料

- [PostgreSQL 官方文档 · psql](https://www.postgresql.org/docs/current/app-psql.html)
- [PostgreSQL 官方文档 · F.32. pg_stat_statements — track statistics of SQL planning and execution](https://www.postgresql.org/docs/current/pgstatstatements.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [排障工具箱](/zh/tools/troubleshooting-toolbox)
- [连接与 ORM 优化](/zh/performance/connection-and-orm-optimization)
- [进程架构](/zh/internals/process-architecture)
- [连接管理](/zh/operations/connection-management)
- [dbeaver-and-vscode](/zh/tools/dbeaver-and-vscode)
- [index](/zh/tools/index)
- [local-dev-environment](/zh/tools/local-dev-environment)
- [real-world-cases](/zh/tools/real-world-cases)
- [schema-migration-tools](/zh/tools/schema-migration-tools)
- [troubleshooting-toolbox](/zh/tools/troubleshooting-toolbox)
官方文档：[psycopg 3](https://www.psycopg.org/psycopg3/docs/)、[node-postgres](https://node-postgres.com/)、[libpq 连接参数](https://www.postgresql.org/docs/current/libpq-connect.html)。
