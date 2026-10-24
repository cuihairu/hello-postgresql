# PostGIS: Geospatial

PostGIS turns PostgreSQL into a spatial database: new `geometry` / `geography` types store points, lines, and polygons, backed by hundreds of spatial functions (distance, area, intersection, buffering, and more) and GiST spatial indexes. It is the most mature option in the PostGIS ecosystem — needs like "people nearby", "delivery coverage", and "geofences" can all be handled inside the database instead of pulling coordinates into the application layer. Official documentation is at [postgis.net](https://postgis.net/documentation/).

## Installation and Table Setup

```bash
# Debian/Ubuntu (PGDG repository)
sudo apt install postgresql-16-postgis-3
```

```sql
CREATE EXTENSION postgis;

CREATE TABLE places (
    id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    geom geometry(Point, 4326) NOT NULL   -- WGS84 longitude/latitude
);

CREATE INDEX places_geom_gist ON places USING gist (geom);
```

Since PostGIS 3, raster and topology are separate extensions (`postgis_raster`, `postgis_topology`); install them as needed.

## geometry vs. geography

Both types store longitude/latitude, but the computation model differs:

- **geometry**: planar computation (projected coordinate system); the result unit depends on the SRID. Full function set and fast, but you must think clearly about the coordinate system.
- **geography**: geodesic computation directly on the WGS84 ellipsoid; the unit is fixed to meters, and results are accurate anywhere on earth. The cost is fewer supported functions and slower computation.

For a geometry with SRID 4326, `ST_Distance` returns "degrees" — not meters, and treating it as meters is the most common mistake. Either use geography as above to get meters, or project the data into a metric projection (such as UTM via `ST_Transform(geom, 32650)`) and then compute. `ST_SetSRID` only labels the data with a coordinate system; it does not transform coordinates. Use `ST_Transform` for real transformation, which relies on the built-in `spatial_ref_sys` coordinate system dictionary.

```sql
CREATE TABLE places_geog (
    id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    geog geography(Point, 4326) NOT NULL
);
CREATE INDEX places_geog_gist ON places_geog USING gist (geog);

INSERT INTO places_geog (name, geog)
SELECT name, ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography
FROM (VALUES ('Tiananmen Square', 116.391, 39.907),
             ('Wangfujing', 116.411, 39.909)) AS v(name, lon, lat);
```

## Common Functions at a Glance

```sql
-- Distance (geography, in meters)
SELECT ST_Distance(geog, ST_SetSRID(ST_MakePoint(116.40, 39.91), 4326)::geography)
FROM places_geog;

-- Range test: within 1000 meters
SELECT name FROM places_geog
WHERE ST_DWithin(geog, ST_SetSRID(ST_MakePoint(116.40, 39.91), 4326)::geography, 1000);

-- Area: after projecting to a metric coordinate system the unit is square meters
SELECT ST_Area(ST_Transform(the_geom, 32650)) AS m2 FROM parcels;

-- Containment: is the point inside an administrative district?
SELECT name FROM districts
WHERE ST_Contains(boundary, ST_SetSRID(ST_MakePoint(116.40, 39.91), 4326));

-- Output GeoJSON for the API layer
SELECT ST_AsGeoJSON(geog::geometry) FROM places_geog;
```

Remember one thing each for geometry validation and decomposition: before loading external data, run `ST_IsValid` to check for illegal geometries such as self-intersection (fix broken ones with `ST_MakeValid`), or spatial tests may return wrong results; `ST_Dump` breaks up composite geometries such as MULTIPOLYGON into single-part rows, which makes it easier to index or aggregate by part.

## Indexes and the Right Way to Query

A GiST index (see [GiST Indexes](../indexing/gist)) organizes by the geometry's bounding box, and whether the index is usable depends on how you write the query:

- **`ST_DWithin` uses the index**: internally it expands the bounding box (equivalent to the `&&` operator), narrowing the candidate set with the index first and then computing exact distances. Write "within N meters" as `ST_DWithin`, always.
- **`ST_Distance(...) < n` does not use the index**: distance must be computed for every row, which is equivalent to a full table scan. The results are the same, but performance differs by an order of magnitude.
- **Use the KNN operator `<->` for nearest-neighbor queries**: `ORDER BY geom <-> point LIMIT k` uses the GiST index to return the k nearest rows directly, with no search radius to guess; pair it with `ST_DWithin` for a two-stage "filter by radius, then sort" query.

```sql
-- Stores sorted by distance within 3 km (index is usable)
SELECT name,
       ST_Distance(geog, :center) AS meters
FROM stores
WHERE ST_DWithin(geog, :center, 3000)
ORDER BY geog <-> :center
LIMIT 20;
```

Note that geography's KNN (`<->`) is approximated by the bounding box center in older PostGIS versions; you can re-sort with `ST_Distance` on the small candidate set for exact ordering. Also, when the data is heavily skewed (the vast majority of rows belong to one city), partitioning or filtering on a city column works better than relying on the spatial index alone. See [Index Failure and Misuse](../indexing/index-failure-and-misuse) for the reasoning.

## Typical Application Patterns

- **Nearby people / stores (KNN + radius)**: a geography column + GiST + `ST_DWithin` + `<->` ordering, i.e. the query above. If user locations update frequently, keep the location table separate from the profile table, and let the location table hold only the most recent coordinate.
- **Delivery coverage / service areas**: store operating boundaries as POLYGONs, turn order addresses into points, and use `ST_Contains` / `ST_Intersects` to test membership; `ST_Buffer` can approximate a circle around a center point, but real boundary data (administrative districts, hand-drawn polygons) is the better basis for precise coverage.
- **Aggregation by region**: spatial JOIN between order points and region polygons (`ST_Contains(region, point)`), combined with GROUP BY for per-region metrics; on large tables, pre-shard or pre-project by region to cut the computation substantially.

## References

- [wiki.postgresql.org/wiki/Foreign_data_wrappers](https://wiki.postgresql.org/wiki/Foreign_data_wrappers)
- [GitHub · pgvector/pgvector](https://github.com/pgvector/pgvector)

<!-- BACKLINKS-AUTO -->
## Related Pages

- [Extension Management](./extension-management)
- [GiST Indexes](../indexing/gist)
- [Range Types and Exclusion Constraints](../advanced-sql/range-types-and-exclude)
- [Index Failure and Misuse](../indexing/index-failure-and-misuse)
- [index](index.md)
- [gist](/indexing/gist.md)
- [knowledge](/knowledge.md)