# 主键设计

主键（Primary Key）是行的唯一标识，是外键引用的锚点，也常常决定分页方式与索引形态。这一页对比三种常见方案——`BIGINT GENERATED AS IDENTITY`、UUID、复合主键——并讨论主键对堆表与索引的影响、业务键与代理键之争，以及 keyset 分页对主键顺序的要求。

## 默认选择：BIGINT GENERATED AS IDENTITY

```sql
CREATE TABLE users (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username   text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO users (username) VALUES ('alice'), ('bob');

SELECT id, username FROM users;
--  id | username
-- ----+----------
--   1 | alice
--   2 | bob
```

IDENTITY 是 PG 10 起的标准语法，语义上等价于 `serial`，但更符合 SQL 标准：序列由列定义托管，`INSERT` 不填即自动分配，也不容易出现「把序列值当普通列赋值」的误用。它作为默认主键的实际好处：

- **紧凑**：8 字节，外键引用它同样只占 8 字节，索引条目小。
- **写友好**：单调递增，新行总是追加到 B-tree 最右侧，页分裂少、缓存命中好。
- **简单可控**：`GENERATED ALWAYS` 挡住应用层乱写 ID，`OVERRIDING SYSTEM VALUE` 才能显式指定。

类型语法细节见官方文档 [CREATE TABLE](https://www.postgresql.org/docs/current/sql-createtable.html)。

## UUID：分布式安全，但默认无序

UUID 适合「多个写入方各自生成 ID、无法共用一个序列」的场景：微服务各自造 ID、客户端预生成、跨库合并。生成方式 PG 13 起内置：

```sql
CREATE TABLE events (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    payload    jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO events (payload) VALUES ('{"type": "login"}');
```

代价在于 UUID v4 本质是随机数：16 字节，插入位置在 B-tree 里随机分布，带来页分裂、索引膨胀和缓存不友好，写密集表上与自增整数的差距明显。改善手段：

- **PG 18 起**内置时间有序的 `uuidv7()`，插入接近单调递增，兼顾分布式生成与索引友好；
- PG 17 及更早可用第三方扩展 [pg_uuidv7](https://github.com/fboulnois/pg_uuidv7) 在库内生成 v7；
- 或退一步在应用层生成带时间前缀的有序 ID（如 ULID）再存入 uuid 列。

UUID 还适合对外暴露：不可枚举，别人无法靠 `id+1` 遍历你的数据。类型与函数细节见 [UUID 类型文档](https://www.postgresql.org/docs/current/datatype-uuid.html)。

## 复合主键

当一行天然由多个字段共同唯一确定时，复合主键是合理选择：

```sql
CREATE TABLE enrollments (
    student_id int REFERENCES students(id),
    course_id  int REFERENCES courses(id),
    enrolled_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (student_id, course_id)
);
```

经验是保持主键「窄」：主键列会被所有引用它的外键和二级索引复制，列越多、越长，下游成本越大。如果复合键超过三四列、或包含长文本列，通常改成代理键 + `UNIQUE (列…)` 更划算。

## 主键对堆表与索引的影响

- 声明主键会自动建一个唯一 B-tree 索引，但**不会**让堆表按主键物理排序；堆的写入顺序与主键无关（想按主键物理聚簇得靠 `CLUSTER`，且只一次性生效，后续写入照样乱序追加）。
- 被引用列（如 `users.id`）必须有唯一索引外键才能建立，主键天然满足；引用列（如 `orders.user_id`）则不会自动建索引，要自己补（见 [外键与引用动作](./foreign-keys-and-referential-actions)）。
- 更新主键值要同时改堆行和全部索引，所以主键应当「写入后不变」——这也是代理键优于业务键的原因之一。

## 业务键与代理键

- **代理键（surrogate key）**：与业务无关、由数据库或算法生成的标识（identity、uuid）。优点：稳定不变、宽度可控。
- **业务键（natural key）**：有业务含义的标识（邮箱、订单号、证件号）。优点：语义直观，天然可用于去重。

实践中常见做法是两者都要：代理键做主键和外键锚点，业务键加 `UNIQUE` 约束保证业务唯一性：

```sql
CREATE TABLE users (
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email text NOT NULL UNIQUE   -- 业务键：对外唯一；内部引用一律用 id
);
```

业务键的风险是「会变」：邮箱要换、证件号要改。一旦它被外键引用，级联修改的代价远高于改一个没人引用的代理键。

## keyset 分页对主键顺序的要求

`OFFSET` 翻页越翻越慢，keyset（游标）翻页则要求排序列上有索引、且顺序稳定可比较：

```sql
SELECT id, username, created_at
FROM users
WHERE (created_at, id) < (now() - interval '7 days', 9223372036854775807)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

关键点：`ORDER BY` 的最后一列必须能打破并列（这里用 `id` 兜底），否则 `created_at` 相同的记录会在翻页时丢行或重行。若排序键重复度高，更稳的做法是直接拿主键当游标：`WHERE id < :cursor ORDER BY id DESC LIMIT 20`——这要求主键本身有序，正是 identity 或 uuidv7 的强项，随机 uuidv4 做 keyset 游标则毫无意义。分页的完整模式见 [分页与排序](../advanced-sql/pagination-and-sorting)。

## 最终一致性场景的 UUID 去重

多写入方各自生成 UUID 主键，冲突概率极低但非零；更常见的重复来自同一逻辑记录被投递两次（重试、双写、消息重放）。做法是把去重交给唯一约束：

```sql
-- 幂等写入：同一 UUID 重复投递只保留第一份
INSERT INTO events (id, payload, created_at)
VALUES (gen_random_uuid(), '{"type": "login"}', now())
ON CONFLICT DO NOTHING;
```

配合 `ON CONFLICT DO NOTHING`（见 [CRUD 与 ON CONFLICT](../basics/crud-and-on-conflict)）实现「至少一次投递 + 幂等落库」。逻辑复制、多主合并场景选 UUID 主键，正是为了避开不同节点自增序列的区间冲突。

## 相关页面

- [外键与引用动作](./foreign-keys-and-referential-actions)
- [B-tree 结构](../indexing/btree-structure)
- [软删与墓碑](./soft-delete-and-tombstone)
- [分页与排序](../advanced-sql/pagination-and-sorting)
