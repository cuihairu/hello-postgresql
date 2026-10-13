# 特色类型入门

除了数字、字符串、日期这类基础类型，PostgreSQL 还内置了一批「结构化」类型：JSONB、数组、范围、枚举、复合类型。它们让许多原本需要拆表、拼分隔字符串或在应用层处理的建模问题，可以直接落在数据库里并获得类型检查和索引支持。本文只做入门概览，每种类型的深入用法见文末的进阶章节。

## JSONB：二进制 JSON

`jsonb` 把 JSON 解析后以二进制格式存储，支持索引和丰富的操作符；与之相对的 `json` 类型只保存原始文本，逐次解析且不能建索引，一般只用 `jsonb`。`jsonb` 不保留键顺序、去掉重复键和多余空白，比较时按语义而非文本。

常用的提取操作符：

- `->`：按键取值，返回 `jsonb`（保留 JSON 类型）。
- `->>`：按键取值并转成 `text`，可以直接参与比较和输出。
- `@>`：包含判断，左边是否包含右边的 JSON 片段，是 GIN 索引最常配合的操作符。

```sql
CREATE TABLE products (
    id    bigserial PRIMARY KEY,
    name  text NOT NULL,
    attrs jsonb NOT NULL DEFAULT '{}'
);

INSERT INTO products (name, attrs) VALUES
    ('键盘', '{"color": "黑", "switch": "红轴", "tags": ["无线", "背光"]}'),
    ('鼠标', '{"color": "白", "dpi": 16000}');

-- 提取字段：-> 返回 jsonb，->> 返回 text
SELECT name,
       attrs -> 'color'    AS color_jsonb,
       attrs ->> 'color'   AS color_text,
       (attrs ->> 'dpi')::int AS dpi
FROM products;

-- 包含查询：找出红轴键盘
SELECT name FROM products WHERE attrs @> '{"switch": "红轴"}';
```

字段上可以建 GIN 索引加速 `@>`、`?` 等查询：`CREATE INDEX ON products USING gin (attrs);`。细节见 [JSONB 操作](../advanced-sql/jsonb-operations)。

## 数组

PostgreSQL 原生支持任意基础类型的数组，比如 `text[]`、`int[]`。数组下标从 1 开始，用 `ANY` 判断「等于其中任一元素」，用 `@>` 判断「包含这些元素」。

```sql
CREATE TABLE articles (
    id    bigserial PRIMARY KEY,
    title text NOT NULL,
    tags  text[] NOT NULL DEFAULT '{}'
);

INSERT INTO articles (title, tags) VALUES
    ('PG 入门', ARRAY['基础', '入门']),
    ('PG 调优', '{性能, 配置}');

-- 是否包含某个元素
SELECT title FROM articles WHERE '基础' = ANY (tags);

-- 数组包含另一组元素、按下标取值、求长度
SELECT title FROM articles WHERE tags @> ARRAY['基础'];
SELECT tags[1], cardinality(tags) FROM articles;
```

两种字面量写法等价，`ARRAY[...]` 构造器对类型更明确，推荐优先使用。

## 范围类型

范围类型把「一段区间」作为一个值存储，内置 `int4range`、`int8range`、`numrange`、`tsrange`、`tstzrange`、`daterange`。默认边界是「左闭右开」`[)`。常用操作符：`@>` 包含、`&&` 重叠、`-|-` 相邻。

```sql
SELECT int4range(1, 10) @> 5 AS contains_five;   -- t
SELECT daterange('2026-01-01', '2026-02-01') @> '2026-01-15'::date;  -- t

CREATE TABLE room_bookings (
    id      bigserial PRIMARY KEY,
    room_no text NOT NULL,
    period  tsrange NOT NULL
);

INSERT INTO room_bookings (room_no, period) VALUES
    ('301', tsrange('2026-10-12 09:00', '2026-10-12 11:00'));

-- 查询与目标时段重叠的预订
SELECT room_no FROM room_bookings
WHERE period && tsrange('2026-10-12 10:00', '2026-10-12 12:00');
```

配合 `EXCLUDE USING` 排他约束可以在数据库层面直接禁止「同一房间时间段重叠」，详见 [范围类型与排他约束](../advanced-sql/range-types-and-exclude)。

## 枚举类型

`CREATE TYPE ... AS ENUM` 定义一个取值固定的有序集合，适合状态、类别这类稳定字段。枚举值之间按声明顺序排序，而不是按字典序。

```sql
CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'closed');

CREATE TABLE orders (
    id     bigserial PRIMARY KEY,
    status order_status NOT NULL DEFAULT 'pending'
);

INSERT INTO orders (status) VALUES ('paid');
SELECT * FROM orders WHERE status = 'paid' ORDER BY status;
```

追加新值用 `ALTER TYPE order_status ADD VALUE 'refunded' AFTER 'closed';`（PG 12 起允许在事务块中执行，只要本次事务内不使用新值）。枚举不支持直接删除已有值，需要重建类型，因此只把「确定稳定」的集合建模为枚举。

## 复合类型一瞥

复合类型把几个字段打包成一个值，常用于函数返回值或表达「地址」这类小结构。

```sql
CREATE TYPE address AS (
    city   text,
    street text
);

CREATE TABLE customers (
    id   bigserial PRIMARY KEY,
    name text NOT NULL,
    addr address
);

INSERT INTO customers (name, addr) VALUES ('张三', ROW('上海', '南京西路 100 号'));

-- 取字段要加括号：(addr).city
SELECT name, (addr).city FROM customers;
```

## hstore 一句带过

`hstore` 是早期的键值对类型，需要 `CREATE EXTENSION hstore;` 启用。在 `jsonb` 成熟之后，新项目基本没有理由再选 hstore，了解即可。

## 适用场景与「别滥用」

| 类型 | 适合 | 不适合 |
| --- | --- | --- |
| JSONB | 结构不确定的外部数据、配置、第三方回调报文 | 核心业务实体（订单、账户等），它们应有明确的列、约束和外键 |
| 数组 | 一组同质的短标签、多值属性 | 需要按元素频繁更新、或元素要被外键引用的场合（应拆子表） |
| 范围 | 时间段、区间计费、有效期 | 单点时间直接用 `timestamptz` 即可 |
| 枚举 | 取值几乎不变的分类 | 会频繁增删的状态机；可考虑加 CHECK 约束的 `text` 列或字典表 |
| 复合类型 | 函数返回结构、临时打包 | 需要独立查询/索引的字段（应作为普通列） |

两个通用提醒：

1. 类型越「自由」，数据库能做的检查越少。JSONB 内部没有 NOT NULL、外键和准确的统计信息，把主数据放进去，数据质量问题会转移到应用层。
2. JSONB 和数组的大值会走 TOAST 机制行外存储，整行频繁更新时带来额外开销，见 [TOAST 与行外存储](../internals/toast)。

## 参考资料

- [PostgreSQL 官方文档 · Part I. Tutorial](https://www.postgresql.org/docs/current/tutorial.html)
- [PostgreSQL 官方文档 · The SQL Language](https://www.postgresql.org/docs/current/sql.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [数据类型总览](./data-types-overview)
- [JSONB 操作](../advanced-sql/jsonb-operations)
- [数组操作](../advanced-sql/array-operations)
- [范围类型与排他约束](../advanced-sql/range-types-and-exclude)
- [data-types-overview](data-types-overview.md)
- [index](index.md)
- [what-is-postgresql](what-is-postgresql.md)
官方文档：[JSON 类型](https://www.postgresql.org/docs/current/datatype-json.html)、[数组](https://www.postgresql.org/docs/current/arrays.html)、[范围类型](https://www.postgresql.org/docs/current/rangetypes.html)、[枚举](https://www.postgresql.org/docs/current/datatype-enum.html)。
