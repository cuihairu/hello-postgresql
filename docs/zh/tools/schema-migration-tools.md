# schema 迁移工具

`CREATE TABLE` 在本地跑一遍很简单，难的是让几十个环境（开发、测试、预发、多个生产节点、每个开发者的机器）上的库结构**一致地演进**。迁移工具解决的就是这件事。

## 迁移要解决的三个问题

- **可重放**：任何一个新环境，按顺序执行全部迁移文件，就能得到与生产一致的最新结构；
- **可回滚**：发布出问题时要能退回上一版，每个变更最好有对应的反向操作；
- **可追责**：谁在什么版本改了什么，有文件、有记录、可 review。

所有主流工具都围绕"**有序的、带版本号的 SQL 文件 + 一张记录当前版本的表**"展开，差异只在文件命名、元数据管理和配套生态。

## golang-migrate

迁移是一对文件：`up` 前进、`down` 回退，文件名以六位序号开头：

```plaintext
migrations/
  000001_create_users.up.sql
  000001_create_users.down.sql
  000002_add_orders_status.up.sql
  000002_add_orders_status.down.sql
```

```bash
# 生成一对空文件
migrate create -ext sql -dir migrations -seq add_orders_status

# 执行与回退（连接串要带 sslmode 等参数）
migrate -path migrations -database "postgres://app:secret@localhost:5432/appdb?sslmode=disable" up 1
migrate -path migrations -database "postgres://app:secret@localhost:5432/appdb?sslmode=disable" down 1

# 迁移到具体版本 / 查看当前版本
migrate -path migrations -database "$DB_URL" goto 000002
migrate -path migrations -database "$DB_URL" version
```

已执行版本记录在 `schema_migrations` 表里。一个要认识的机制是 **dirty 标记**：迁移执行中途失败时该版本会被标记为 dirty，下次运行会拒绝继续，必须人工确认后用 `force` 清除再继续——宁可停下来问人，也不要让半成品结构继续往下走。

## Flyway

Flyway 用命名前缀区分类型，`V` 是版本化迁移，`R` 是可重复执行（视图、函数这类"始终对齐到最新定义"的对象）：

```plaintext
db/migration/
  V1__create_users.sql
  V2__add_orders_status.sql
  R__current_order_view.sql
```

```bash
# 已有结构的存量库接入 Flyway 时，先打基线
flyway -url=jdbc:postgresql://localhost:5432/appdb -user=app baseline -baselineVersion=1
flyway -url=jdbc:postgresql://localhost:5432/appdb -user=app migrate
flyway -url=jdbc:postgresql://localhost:5432/appdb -user=app info
```

`baseline` 的意义：存量库已经相当于执行到 V1，直接 `migrate` 会因 V1 与现状冲突而报错；打上基线后 Flyway 从 V2 开始应用。执行记录存在 `flyway_schema_history` 表。

## prisma migrate

Prisma 的思路反过来：**`schema.prisma` 文件是唯一真相**，SQL 由工具对比生成：

```bash
# 修改 schema.prisma 后，对比生成迁移 SQL 并应用到开发库
npx prisma migrate dev --name add_orders_status

# 生产环境只应用已生成好的迁移，不做任何对比与生成
npx prisma migrate deploy

# 存量库接入：把已存在的首个迁移标记为已应用
npx prisma migrate resolve --applied 20240101120000_init
```

`migrate dev` 生成的 SQL 存放在 `prisma/migrations/<时间戳>_<名称>/migration.sql`，与其他工具一样进版本库 review。适合已经在用 Prisma ORM 的团队；纯 SQL 团队用 golang-migrate 或 Flyway 更直接。

Node 生态还有一个不绑定 ORM 的 [node-pg-migrate](https://github.com/salsita/node-pg-migrate)，用 JS 写 up/down 迁移，思路与 golang-migrate 相同，在此不展开。

## 团队规范

工具不能替你守住纪律，这几条约定比选哪个工具更重要：

- **一个迁移一个事务**：迁移要么完整生效要么完全不出现在库里。Flyway、golang-migrate 默认把单个迁移包在事务里执行；例外是 `CREATE INDEX CONCURRENTLY` 这类不能在事务块内运行的语句，要么拆成独立迁移文件并确认工具配置允许跳过事务，要么接受加锁建索引。
- **禁止修改已合并的迁移**：其他环境可能已经执行过它，改了文件内容版本记录就对不上。错了就**新增**一个修正迁移，如同改已发布的代码要写新 commit 而不是改历史。
- **幂等策略有边界**：`CREATE TABLE IF NOT EXISTS` 能防止"表已存在"报错，但表存在而结构不同时会静默通过，把结构漂移藏起来；`ADD COLUMN IF NOT EXISTS` 可用，但改列类型、改约束没有等价写法。`IF NOT EXISTS` 适合"可能被手动建过的兜底场景"，不要当常规手段。绕过工具手动改生产结构，是迁移体系被破坏的头号原因。

迁移执行期间的锁与长事务风险，见[锁与并发瓶颈](/zh/performance/lock-and-concurrency-bottlenecks)；约束与索引背后的机制见[锁系统](/zh/internals/lock-system)。

## 参考资料

- [PostgreSQL 官方文档 · psql](https://www.postgresql.org/docs/current/app-psql.html)
- [PostgreSQL 官方文档 · F.32. pg_stat_statements — track statistics of SQL planning and execution](https://www.postgresql.org/docs/current/pgstatstatements.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [本地开发环境](/zh/tools/local-dev-environment)
- [客户端驱动](/zh/tools/client-drivers)
- [锁与并发瓶颈](/zh/performance/lock-and-concurrency-bottlenecks)
- [锁系统](/zh/internals/lock-system)
- [logical-replication-ops](/zh/operations/logical-replication-ops)
- [index](/zh/tools/index)
- [local-dev-environment](/zh/tools/local-dev-environment)
官方文档：[golang-migrate](https://github.com/golang-migrate/migrate)、[Flyway 文档](https://documentation.red-gate.com/flyway/)、[Prisma Migrate](https://www.prisma.io/docs/orm/prisma-migrate)。
