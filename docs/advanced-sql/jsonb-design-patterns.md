# JSONB 设计模式

jsonb 本身只是存储格式，用得好不好取决于建模纪律：哪些字段进关系列、哪些进 jsonb、谁来保证结构正确、索引怎么补。这一页给出一套经过验证的混合建模模式，以及判断「什么时候该用、什么时候不该用」的标准。

## 文档列模式：关系列 + 扩展属性

最常用的形态：稳定、参与查询和约束的字段放关系列，多变的、可选的、只随行整体读写的字段放一列 jsonb：

```sql
CREATE TABLE orders (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     bigint NOT NULL,
    status      text NOT NULL,
    total_cents bigint NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    attributes  jsonb NOT NULL DEFAULT '{}'::jsonb
);

INSERT INTO orders (user_id, status, total_cents, attributes) VALUES
    (101, 'paid',    19900, '{"channel": "app", "coupon": {"code": "NEW10", "off_cents": 1000}}'),
    (102, 'pending',  8800, '{"channel": "web"}'),
    (103, 'paid',    45000, '{"channel": "web", "gift_wrap": true}');
```

划分标准一句话：**这个字段要不要进 WHERE、JOIN、GROUP BY、外键或 CHECK？要，就放关系列；只是随行读写的展示性数据，才进 jsonb。** 上例里 `status`、`total_cents` 明显要参与过滤与统计，`coupon` 这类低频、结构多变的属性留在 jsonb 合理。

## 用生成列把热字段抽回关系列

一旦某个 jsonb 字段开始频繁参与过滤或排序，就把它抽成生成列（PG 12 起支持 STORED），既保留写入侧的灵活，又拿回关系列的索引与统计信息：

```sql
CREATE TABLE products (
    id    int PRIMARY KEY,
    name  text NOT NULL,
    attrs jsonb NOT NULL DEFAULT '{}'::jsonb,
    color text GENERATED ALWAYS AS (attrs ->> 'color') STORED
);

CREATE INDEX products_color_idx ON products (color);

-- 普通等值查询，走 B-tree 索引
SELECT * FROM products WHERE color = 'black';
```

要点：

- 生成列不能手动写入，插入/更新只管 `attrs`，`color` 自动跟随。
- 生成列表达式必须 IMMUTABLE，所以 `attrs ->> 'color'` 可以（操作符本身 immutable），`now()`、子查询不行。
- `to_tsvector` 单参数版本是 stable，用在生成列里必须写成带配置的两参数形式。
- 生成列可以再建索引，也可以参与外键引用的查询路径，统计信息照常 ANALYZE。

更多生成列用法见 [生成列与 CHECK 约束](./generated-columns-and-check)。

## 用部分索引覆盖 jsonb 条件

某些 jsonb 条件只对特定状态的行有意义，部分索引能把索引体积压到最小：

```sql
-- 只索引带优惠券的订单的创建时间，服务「查最近用券订单」
CREATE INDEX orders_with_coupon
    ON orders (created_at)
    WHERE attributes ? 'coupon';

-- 只索引待支付订单的渠道
CREATE INDEX orders_pending_channel
    ON orders (user_id, (attributes ->> 'channel'))
    WHERE status = 'pending';
```

查询的谓词要与索引谓词一致（或被推导包含）才会被选中，比如 `WHERE status = 'pending' AND attributes ->> 'channel' = 'app'` 命中第二个索引。写法细节见 [局部（部分）索引](../indexing/partial-indexes)。

## 在数据库里校验 jsonb 结构

jsonb 默认什么都装，第一道防线是 CHECK 约束把顶层形状钉死：

```sql
-- 至少保证是对象，防止数组、标量混进来
ALTER TABLE orders
    ADD CONSTRAINT attributes_is_object
    CHECK (jsonb_typeof(attributes) = 'object');

-- 对关心的子结构做形状校验：coupon 若存在，必须是对象且带 code 键
ALTER TABLE orders
    ADD CONSTRAINT coupon_shape
    CHECK (attributes -> 'coupon' IS NULL
           OR (jsonb_typeof(attributes -> 'coupon') = 'object'
               AND attributes -> 'coupon' ? 'code'));
```

更完整的 schema 校验可以用社区扩展（如实现 JSON Schema 校验的 pg_jsonschema）在写入前整体验证，但多数业务用几条 CHECK 锁住关键字段的类型与存在性已经够用。校验的完整思路见 [CHECK 与域](../database-design/check-and-domains)。

## 何时纯文档、何时混合建模

- **纯文档**：整行就是一个文档——配置存档、外部系统报文快照、日志载荷。表只有主键 + jsonb（或再加时间戳），不做关系查询，也不拆字段。
- **混合建模**：绝大多数业务表。稳定字段关系列，易变/可选字段 jsonb，热字段用生成列抽回。
- 判断顺序：先问「会不会被过滤、JOIN、约束」，再问「结构会不会变」，最后问「更新频率」。三个问题都倾向「否」，jsonb 才是答案。

## 避免「万能 JSONB 表」

反模式长这样：一张表只有 `id` 和 `data` 两列，所有业务实体都塞进 `data`。后果是系统性的：

- 没法加外键、没法对内层字段做 CHECK，数据质量全靠应用层自觉。
- 优化器看不到 jsonb 内部的统计信息，行数估算失准，计划不稳。
- 每个查询都要从 jsonb 里挖字段，到处是 `->>` 加 cast，索引跟着膨胀。
- 表结构失去文档价值，新同事只能靠读代码反推 schema。

jsonb 的正确定位是关系模型的补充，不是替代；更多类似陷阱见 [反模式清单](../database-design/anti-patterns)。

## 注意事项与常见坑

- 把频繁过滤/JOIN 的字段埋进 jsonb 再补一堆表达式索引，不如一开始就放关系列。
- 生成列抽字段会让写入变慢（每次更新都要重算），只对真正的「热字段」做，不要全表字段都抽。
- 部分索引谓词里的字面量要与查询完全一致（`'pending'` vs `"pending"` 拼写、类型），否则计划器不认。
- CHECK 校验的是「写入那一刻」，历史数据不受新约束管（加约束时默认全表校验，可加 NOT VALID 分步走）。
- 大 jsonb 列的高频小更新会反复重写 TOAST 值，更新密集的场景考虑把热字段挪出去。

## 相关页面

- [JSONB 操作](./jsonb-operations)
- [生成列与 CHECK 约束](./generated-columns-and-check)
- [反模式清单](../database-design/anti-patterns)
- [GIN 索引](../indexing/gin)

官方文档：[生成列](https://www.postgresql.org/docs/current/ddl-generated-columns.html)、[JSON 类型](https://www.postgresql.org/docs/current/datatype-json.html)。
