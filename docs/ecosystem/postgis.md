# 空间扩展 PostGIS

PostGIS 把 PostgreSQL 变成一个空间数据库：新增 `geometry` / `geography` 类型存储点线面，配几百个空间函数（距离、面积、相交、缓冲区……）与 GiST 空间索引。它是 PostGIS 生态中最成熟的方案，「附近的人」「配送范围」「电子围栏」这类需求都可以在数据库内完成，而不是把坐标拉到应用层算。官方文档见 [postgis.net](https://postgis.net/documentation/)。

## 安装与建表

```bash
# Debian/Ubuntu（PGDG 仓库）
sudo apt install postgresql-16-postgis-3
```

```sql
CREATE EXTENSION postgis;

CREATE TABLE places (
    id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    geom geometry(Point, 4326) NOT NULL   -- WGS84 经纬度
);

CREATE INDEX places_geom_gist ON places USING gist (geom);
```

PostGIS 3 起 raster、topology 是独立扩展（`postgis_raster`、`postgis_topology`），按需安装。

## geometry 与 geography

两种类型都存经纬度，但计算模型不同：

- **geometry**：平面（投影坐标系）计算，结果单位取决于 SRID。函数齐全、速度快，但必须想清楚坐标系。
- **geography**：直接在 WGS84 椭球上做测地计算，单位固定为米，全球任意位置结果都准确。代价是支持的函数较少、计算更慢。

SRID 4326 的 geometry 里，`ST_Distance` 返回的是「度」——不是米，直接当米用是最常见的错误。要么像上面一样用 geography 拿到米，要么把数据投影到米制投影系（如 UTM 的 `ST_Transform(geom, 32650)`）再算。`ST_SetSRID` 只是给数据打坐标系标签，不做坐标转换；真正转换用 `ST_Transform`，依赖内置的 `spatial_ref_sys` 坐标系字典。

```sql
CREATE TABLE places_geog (
    id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    geog geography(Point, 4326) NOT NULL
);
CREATE INDEX places_geog_gist ON places_geog USING gist (geog);

INSERT INTO places_geog (name, geog)
SELECT name, ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography
FROM (VALUES ('天安门', 116.391, 39.907),
             ('王府井', 116.411, 39.909)) AS v(name, lon, lat);
```

## 常用函数速览

```sql
-- 距离（geography，单位米）
SELECT ST_Distance(geog, ST_SetSRID(ST_MakePoint(116.40, 39.91), 4326)::geography)
FROM places_geog;

-- 范围判断：1000 米以内
SELECT name FROM places_geog
WHERE ST_DWithin(geog, ST_SetSRID(ST_MakePoint(116.40, 39.91), 4326)::geography, 1000);

-- 面积：投影到米制坐标系后单位为平方米
SELECT ST_Area(ST_Transform(the_geom, 32650)) AS m2 FROM parcels;

-- 包含：判断点是否落在行政区内
SELECT name FROM districts
WHERE ST_Contains(boundary, ST_SetSRID(ST_MakePoint(116.40, 39.91), 4326));

-- 输出 GeoJSON 给 API 层
SELECT ST_AsGeoJSON(geog::geometry) FROM places_geog;
```

几何校验与拆解各记一句：外部数据入库先跑 `ST_IsValid` 检查自相交等非法几何（坏了用 `ST_MakeValid` 修复），否则空间判断可能给出错误结果；`ST_Dump` 把 MULTIPOLYGON 等复合几何拆成单件行，便于按部件建索引或统计。

## 索引与查询的正确姿势

GiST 索引（原理见 [GiST 索引](../indexing/gist)）按几何的外接矩形组织，能否用上索引取决于查询写法：

- **`ST_DWithin` 走索引**：它内部展开外接框（等价于 `&&` 运算），先按索引缩小候选集再算精确距离。「附近 N 米」一律写成 `ST_DWithin`。
- **`ST_Distance(...) < n` 不走索引**：对每一行都要算距离，等价于全表扫描。两者结果一样，性能差一个数量级。
- **最近邻查询用 KNN 操作符 `<->`**：`ORDER BY geom <-> 点 LIMIT k` 可以直接利用 GiST 索引返回最近的 k 条，不需要给一个搜索半径，配合 `ST_DWithin` 可以做「先半径过滤再排序」的两段式查询。

```sql
-- 附近 3 公里内按距离排序的门店（索引可用）
SELECT name,
       ST_Distance(geog, :center) AS meters
FROM stores
WHERE ST_DWithin(geog, :center, 3000)
ORDER BY geog <-> :center
LIMIT 20;
```

注意 geography 的 KNN（`<->`）在旧版本 PostGIS 中按外接框中心近似，精确排序可在小候选集上再用 `ST_Distance` 排一次；另外数据倾斜严重（绝大多数行属于同一个城市）时，按城市列建分区或加过滤条件比单纯依赖空间索引更有效，思路见 [索引失效与误用](../indexing/index-failure-and-misuse)。

## 典型应用模式

- **附近的人/门店（KNN + 半径）**：geography 列 + GiST + `ST_DWithin` + `<->` 排序，即上一节的查询。用户位置更新频繁时，位置表与资料表分开，位置表可以只保留最近一次坐标。
- **配送范围/服务区**：把运营边界存成 POLYGON，订单地址转点后用 `ST_Contains` / `ST_Intersects` 判定是否在范围内；用 `ST_Buffer` 可以由中心点生成近似圆，但精确范围建议用真实边界数据（如行政区划、自绘多边形）。
- **按区域统计**：订单点与区域面做空间 JOIN（`ST_Contains(region, point)`），配合 GROUP BY 出各区域指标；大表先按区域分片或预投影，能显著降低计算量。

## 相关页面

- [扩展管理](./extension-management)
- [GiST 索引](../indexing/gist)
- [范围类型与排他约束](../advanced-sql/range-types-and-exclude)
- [索引失效与误用](../indexing/index-failure-and-misuse)
