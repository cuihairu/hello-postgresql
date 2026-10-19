# JSONB 操作

PostgreSQL 提供两种 JSON 类型：`json` 存储输入原文的精确副本，`jsonb` 存储解析后的二进制表示。日常业务几乎都应该选 jsonb：它支持完整的操作符、索引和 jsonpath 查询，代价只是写入时多一次解析。这里按「读取 → 查询 → 修改 → 收窄」的顺序过一遍 jsonb 的核心操作。

## json 与 jsonb 的差异

| 维度 | json | jsonb |
| ---- | ---- | ----- |
| 存储 | 原文副本，保留空格、键顺序、重复键 | 解析后的二进制，键去重、顺序不保证 |
| 写入 | 快（不解析） | 稍慢（要解析、建表示） |
| 查询与操作符 | 基本没有 | 完整支持 |
| 索引 | 只能建表达式索引 | 直接支持 GIN |

只有需要逐字节保留原文（比如存外部系统的报文用于审计比对）才用 json；其余场景默认 jsonb。

## 示例表

```sql
CREATE TABLE products (
    id    int PRIMARY KEY,
    name  text NOT NULL,
    attrs jsonb NOT NULL DEFAULT '{}'::jsonb
);

INSERT INTO products VALUES
    (1, '无线鼠标', '{"color": "black", "weight_g": 98,
                     "tags": ["办公", "2.4G"], "specs": {"dpi": 1600}}'),
    (2, '机械键盘', '{"color": "white", "weight_g": 850,
                     "tags": ["游戏", "客制化"], "specs": {"layout": "75%"}}');
```

## 路径操作符：->、->>、#>、#>>

单箭头返回 jsonb，双箭头返回 text；`#>`/`#>>` 用路径数组取嵌套值：

```sql
SELECT attrs -> 'color'         FROM products WHERE id = 1;  -- "black"（jsonb）
SELECT attrs ->> 'color'        FROM products WHERE id = 1;  -- black（text）
SELECT attrs #> '{specs,dpi}'   FROM products WHERE id = 1;  -- 1600（jsonb）
SELECT attrs #>> '{specs,dpi}'  FROM products WHERE id = 1;  -- '1600'（text）

-- 数组用数字下标（从 0 开始）
SELECT attrs -> 'tags' ->> 0    FROM products WHERE id = 1;  -- 办公
```

PG 13 起还支持下标语法，效果与 `->` 相同，多层嵌套时更直观：

```sql
SELECT attrs['specs']['dpi'] FROM products WHERE id = 1;   -- 1600
```

## containment 与存在性：@>、<@、?

`@>`（containment）判断左边是否整体包含右边的结构与值，是最常用的 jsonb 查询方式；`?` 系列只检查顶层键或顶层字符串：

```sql
-- 整体包含：文档里有 color=black 这部分即可，其余键不管
SELECT * FROM products WHERE attrs @> '{"color": "black"}';          -- 1

-- 嵌套包含同样可行
SELECT * FROM products WHERE attrs @> '{"specs": {"dpi": 1600}}';    -- 1

-- 数组包含：tags 里同时有「办公」
SELECT * FROM products WHERE attrs -> 'tags' @> '["办公"]';          -- 1

-- 顶层键存在
SELECT * FROM products WHERE attrs ? 'weight_g';                     -- 1、2

-- 任一键存在 / 全部键存在
SELECT * FROM products WHERE attrs ?| array['color', 'tags'];
SELECT * FROM products WHERE attrs ?& array['color', 'weight_g'];
```

注意 `?` 的特殊语义：作用在数组上时检查的是「顶层字符串元素」，`'["a","b"]'::jsonb ? 'a'` 为真；这与 `@>` 的整体包含不是一回事。

## jsonb 数组元素

数组可以按下标取值，也可以展开成行，与 SQL 的其余部分衔接：

```sql
-- 展开成行（每个标签一行）
SELECT jsonb_array_elements_text(attrs -> 'tags') FROM products WHERE id = 1;
-- 办公
-- 2.4G

-- 与整表 JOIN 展开统计
SELECT p.name, t.tag
FROM products p, jsonb_array_elements_text(p.attrs -> 'tags') AS t(tag)
ORDER BY p.id;

-- 数组长度
SELECT jsonb_array_length(attrs -> 'tags') FROM products WHERE id = 1;   -- 2
```

## 修改：jsonb_set、jsonb_insert 与 ||

jsonb 是不可变值，「修改」实际上是替换整个值。常用手段：

```sql
-- 改/增：path 不存在时默认创建（create_missing 默认 true）
UPDATE products SET attrs = jsonb_set(attrs, '{specs,dpi}', '3200') WHERE id = 1;
UPDATE products SET attrs = jsonb_set(attrs, '{warranty_months}', '24') WHERE id = 1;

-- 删除：顶层键用 -，嵌套键用 #-
UPDATE products SET attrs = attrs - 'color' WHERE id = 1;
UPDATE products SET attrs = attrs #- '{specs,dpi}' WHERE id = 1;

-- || 合并：右侧同键覆盖左侧（浅合并，不会递归合并嵌套对象）
UPDATE products SET attrs = attrs || '{"color": "grey", "stock": 12}' WHERE id = 1;

-- jsonb_insert：往数组指定下标之前插入元素（第四个参数 true 则插到之后）
UPDATE products SET attrs = jsonb_insert(attrs, '{tags,0}', '"新品"') WHERE id = 1;
```

一个静默坑：`jsonb_set` 的路径中间层级不存在时不会自动创建，而是原值返回、不报错，批量更新前先确认结构存在。

## jsonpath：SQL/JSON Path（PG 12 起）

jsonpath 是一套独立的路径语言，支持变量、过滤器和数学运算，比 `#>` 表达力强得多：

```sql
-- 展开数组元素
SELECT jsonb_path_query(attrs, '$.tags[*]') FROM products WHERE id = 1;

-- 带过滤条件的存在性判断：dpi 大于 1500
SELECT id FROM products
WHERE jsonb_path_exists(attrs, '$.specs.dpi ? (@ > 1500)');        -- 1

-- @? 是 jsonb_path_exists 的操作符写法
SELECT id FROM products WHERE attrs @? '$.tags[*] ? (@ == "办公")';

-- 取第一个匹配值
SELECT jsonb_path_query_first(attrs, '$.tags[*]') FROM products WHERE id = 1;
```

配套还有 `jsonb_path_query_array`（结果聚成数组）和 `@@`（把路径谓词结果直接当 boolean）。默认 lax 模式会自动拆包数组，写 `$.tags[*]` 与 `$.tags` 常等价；需要严格结构校验时用 `$strict.` 开头。

## containment 与 GIN 索引配合

`@>` 和 `?` 系列没有普通 B-tree 索引可用，配 GIN 才能在大表上工作：

```sql
CREATE INDEX products_attrs_gin ON products USING gin (attrs);

-- 下面两种写法都能走上面的索引
SELECT * FROM products WHERE attrs @> '{"color": "black"}';
SELECT * FROM products WHERE attrs ? 'weight_g';
```

默认的 `jsonb_ops` 支持 `@>`/`?`/`?|`/`?&`；只查 containment 时可改用 `jsonb_path_ops`，索引更小、点查更快，但不支持 `?` 系列。两种 opclass 的取舍见 [GIN 索引](../indexing/gin)；若热点是「取某个键的 text 值做等值查询」，表达式索引往往比 GIN 更划算，见 [表达式索引](../indexing/expression-indexes)。

## 类型收窄与 cast

`->>`/`#>>` 取出来的都是 text，参与数值或时间比较前必须显式 cast：

```sql
-- 坑：text 比较是字符串序，'98' > '850' 为真
SELECT attrs ->> 'weight_g' > '850' FROM products WHERE id = 1;       -- true（错）

-- 先收窄成数字再比较
SELECT (attrs ->> 'weight_g')::int > 850 FROM products WHERE id = 1;  -- false（对）
```

反过来，把 jsonb 摊平成关系行用 `jsonb_to_record`：

```sql
SELECT * FROM jsonb_to_record('{"color": "black", "weight_g": 98}')
    AS x(color text, weight_g int);
--  color | weight_g
-- -------+----------
--  black |       98
```

## 注意事项与常见坑

- `->` 返回 jsonb、`->>` 返回 text，拿 jsonb 和 text 直接比较会报 `operator does not exist: jsonb = text`。
- 数字值从 jsonb 里取出后是 text，字符串序比较会得出错误结论，比较前 cast。
- jsonb 不保留键顺序、重复键只保留最后一个；任何依赖键顺序的逻辑都不可靠。
- `@>` 对数组是整体包含，判断「数组里有某个元素」要么用 `?`，要么写单元素数组 `'["办公"]'`。
- 高频局部更新一个大 jsonb 列，每次都会重写整个 TOAST 值，写放大明显，见 [TOAST 与大字段存储](../internals/toast)。
- 更新某个键走 `jsonb_set`/`||`，直接 `SET attrs = '{"a":1}'` 会把其他键整个覆盖掉。

## 参考资料

- [PostgreSQL 官方文档 · 7.8. WITH Queries (Common Table Expressions)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL 官方文档 · 9.22. Window Functions](https://www.postgresql.org/docs/current/functions-window.html)

<!-- BACKLINKS-AUTO -->
## 相关页面

- [JSONB 设计模式](./jsonb-design-patterns)
- [GIN 索引](../indexing/gin)
- [生成列与 CHECK 约束](./generated-columns-and-check)
- [TOAST 与大字段存储](../internals/toast)
- [array-operations](array-operations.md)
- [index](index.md)
- [jsonb-design-patterns](jsonb-design-patterns.md)
- [special-types-intro](/basics/special-types-intro.md)
- [anti-patterns](/database-design/anti-patterns.md)
- [postgresql-17-features](/ecosystem/postgresql-17-features.md)
- [gin](/indexing/gin.md)
- [toast](/internals/toast.md)
- [knowledge](/knowledge.md)
官方文档：[JSON 类型](https://www.postgresql.org/docs/current/datatype-json.html)、[JSON 函数与操作符](https://www.postgresql.org/docs/current/functions-json.html)。
