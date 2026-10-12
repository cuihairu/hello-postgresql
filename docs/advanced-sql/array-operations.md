# 数组操作

PostgreSQL 的数组类型允许一列存多个同类型值，常用于标签、权限列表、多值属性这类「一对少量值」的场景。它不是多对多关系的替代品，但在「值不需要约束、只随行整体读写」时比子表轻得多。这一页覆盖构造、下标、包含/重叠判断、与行集互转，以及配套的 GIN 索引。

## 示例表与数组构造

```sql
CREATE TABLE articles (
    id    int PRIMARY KEY,
    title text NOT NULL,
    tags  text[] NOT NULL DEFAULT '{}'
);

INSERT INTO articles VALUES
    (1, 'PG 索引入门', '{"postgres", "index", "入门"}'),
    (2, '慢查询排查',  '{"postgres", "performance"}'),
    (3, 'Redis 缓存',  '{"redis", "performance"}');
```

构造数组的几种写法：

```sql
SELECT ARRAY['postgres', 'index'];        -- {postgres,index}，推荐
SELECT '{a,b,c}'::text[];                 -- 字面量，注意显式类型
SELECT string_to_array('a,b,c', ',');     -- 拆字符串
SELECT array_append(ARRAY[1, 2], 3);      -- {1,2,3}
SELECT ARRAY(SELECT id FROM articles);    -- 子查询结果聚成数组
```

`ARRAY[]` 构造器必须能推出类型，空数组写成 `ARRAY[]::text[]`。

## 下标、切片与多维

下标从 1 开始（不是 0）：

```sql
SELECT tags[1]    FROM articles WHERE id = 1;   -- postgres
SELECT tags[1:2]  FROM articles WHERE id = 1;   -- {postgres,index}（切片含两端）
SELECT cardinality(tags)               FROM articles WHERE id = 1;   -- 3
SELECT array_length(tags, 1)           FROM articles WHERE id = 1;   -- 3

-- 单个元素赋值是合法的 UPDATE 写法
UPDATE articles SET tags[1] = 'postgresql' WHERE id = 1;
```

多维数组用嵌套字面量表示，各维必须等长（矩形）：

```sql
SELECT ('{{1,2},{3,4}}'::int[])[2][1];          -- 3
SELECT array_length('{{1,2},{3,4}}'::int[], 2); -- 2（第二维长度）
```

## 包含与重叠：@>、<@、&&

三个操作符覆盖了数组查询的大部分需求：

```sql
-- @> 包含：tags 同时有这两个标签
SELECT * FROM articles WHERE tags @> ARRAY['postgres', 'performance'];   -- 2

-- <@ 被包含：tags 是右边集合的子集
SELECT * FROM articles WHERE tags <@ ARRAY['postgres', 'index', '入门']; -- 1

-- && 重叠：tags 与右边有任意交集
SELECT * FROM articles WHERE tags && ARRAY['redis', 'index'];            -- 1、3
```

`@>` 与 `&&` 的区别要记牢：「必须全都有」用包含，「有一个就行」用重叠。

## ANY/ALL 匹配与 unnest 展开

`= ANY (数组)` 判断「任一元素等于给定值」；要把数组当行集处理就用 unnest 展开：

```sql
-- 任意元素等于 'postgres'
SELECT * FROM articles WHERE 'postgres' = ANY (tags);    -- 1、2

-- 所有元素都满足条件（此处演示：全部非空）
SELECT * FROM articles WHERE true = ALL (SELECT unnest(tags) IS NOT NULL);

-- unnest 把数组展开成行（函数写在 FROM 里可隐式引用前面的表）
SELECT t.tag, count(*)
FROM articles a, unnest(a.tags) AS t(tag)
GROUP BY t.tag
ORDER BY count(*) DESC, t.tag;
-- performance | 2
-- postgres    | 2
-- ...

-- WITH ORDINALITY 保留原位置（PG 9.4 起）
SELECT * FROM unnest(ARRAY['a', 'b']) WITH ORDINALITY AS t(v, n);
-- a | 1
-- b | 2
```

`ALL (数组)` 配合比较符的语义与子查询版 ANY/ALL 一致，NULL 混入时的三值逻辑同样适用。

## array_agg 与 array_to_string

聚合方向（行集 → 数组）与展开方向（数组 → 字符串）互补：

```sql
-- 行聚成数组：每个标签下所有文章标题
SELECT t.tag, array_agg(a.title ORDER BY a.title)
FROM articles a, unnest(a.tags) AS t(tag)
GROUP BY t.tag;

-- 数组拼成字符串（展示用）
SELECT array_to_string(tags, ', ') FROM articles WHERE id = 1;
-- postgres, index, 入门

-- 聚合时去重
SELECT array_agg(DISTINCT t.tag) FROM articles a, unnest(a.tags) AS t(tag);
```

`array_agg` 与 `unnest` 近似互逆：前者把一列收进一行，后者把一行摊成一列。分组聚合 + 数组返回，是在应用侧少发一次查询的常用手法。

## GIN 索引与标签查询

数组上的 `@>`/`<@`/`&&` 顺序扫描很慢，GIN 索引把它们变成索引查找：

```sql
CREATE INDEX articles_tags_gin ON articles USING gin (tags);

-- 三种写法都能走 GIN
SELECT * FROM articles WHERE tags @> ARRAY['postgres', 'performance'];
SELECT * FROM articles WHERE tags && ARRAY['redis', 'index'];
SELECT * FROM articles WHERE tags <@ ARRAY['postgres', 'index', '入门'];
```

默认的 `array_ops` opclass 服务包含、重叠、被包含与整体等值。要让查询稳定命中索引，条件就写成上面这些操作符形态；`'postgres' = ANY(tags)` 是另一种表达式，不保证被改写，等值场景优先写 `tags @> ARRAY['postgres']`。GIN 的结构与维护成本见 [GIN 索引](../indexing/gin)。

## 标签与多值属性的使用边界

数组适合：标签、分类列表、权限/角色集合、一个实体的多个联系方式——值不需要约束、只随行整体读写、查询模式是「包含/重叠」。

数组不适合：

- 值需要外键引用、唯一约束或在别处反向查询 → 用真正的多对多表。
- 数组会无限增长（如日志追加）→ 单行膨胀，更新整列重写，见 [TOAST 与大字段存储](../internals/toast)。
- 要按「值 → 行」高频检索且需要精确统计 → 展开成行建 B-tree 更直接。

## 注意事项与常见坑

- 下标从 1 开始；`tags[0]` 是 NULL，不会报错，静默出错最难受。
- NULL 数组与空数组是两回事：`tags IS NULL` 与 `tags = '{}'` 不同，聚合前用 `coalesce(tags, '{}')` 归一。
- 多维数组必须矩形，行内长度不一致直接报错。
- `&&` 与 `@>` 语义不同，写错不会报错、只会返回「看起来不对」的结果。
- unnest 之后再过滤，数组形态已经没了，GIN 帮不上忙；要索引就保持数组操作符查询。
- 更新数组任意一个元素都要重写整列存储，大数组高频更新是写放大来源。

## 相关页面

- [GIN 索引](../indexing/gin)
- [JSONB 操作](./jsonb-operations)
- [LATERAL 与 FROM 子查询](./lateral-and-from-subquery)
- [范围类型与 EXCLUDE](./range-types-and-exclude)

官方文档：[数组类型](https://www.postgresql.org/docs/current/arrays.html)、[数组函数与操作符](https://www.postgresql.org/docs/current/functions-array.html)。
