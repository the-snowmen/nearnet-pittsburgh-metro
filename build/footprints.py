"""Export per-building footprint polygons as GeoJSON text (additive, removable).

Emits ``web/public/data/footprints.parquet``: one row per building, ``building_id``
+ ``footprint_geojson`` (a GeoJSON Polygon/MultiPolygon **string**). The browser
reads the text column and ``JSON.parse``s it — **no spatial extension needed in
DuckDB-WASM**, exactly like ``connectors.parquet`` carries ``conn_geojson``.

Why text, not a GEOMETRY column: DuckDB-WASM in the browser has no spatial
extension (the whole design keeps geometry out of the browser query engine). The
export feature (KMZ / GeoJSON) needs real building shapes to draw cost-colored
footprints in Google Earth, so we bake the polygon as a string keyed by
``building_id`` and join it back to the reachable set at export time.

STANDALONE & removable, same additive contract as ``build/pois.py`` /
``connectors.parquet``: it only reads the authoritative ``data/buildings.parquet``
and writes one new web asset. Deleting ``footprints.parquet`` leaves the app fully
working (the export falls back to centroid points).

Run inside the ``nearnet`` env (needs duckdb + the spatial extension that wrote the
parquet):  ``python -m build.footprints``
"""

from __future__ import annotations

import duckdb

from . import config

WEB_DATA = config.REPO_ROOT / "web" / "public" / "data"

# Light topology-preserving simplify (in 4326 degrees; ~0.5 m at this latitude)
# then coordinate rounding — footprints are small, so this keeps shape crisp for
# display while holding the file to a few MB. 1e-6 deg ≈ 0.11 m (lossless for view).
SIMPLIFY_TOL_DEG = 0.000005
COORD_PRECISION = 1e-6


def main() -> None:
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")

    src = str(config.OUT_BUILDINGS)
    out = WEB_DATA / "footprints.parquet"
    con.execute(
        f"COPY (SELECT building_id, "
        f"ST_AsGeoJSON(ST_ReducePrecision("
        f"ST_SimplifyPreserveTopology(geometry, {SIMPLIFY_TOL_DEG}), {COORD_PRECISION})"
        f") AS footprint_geojson "
        f"FROM read_parquet('{src}')) "
        f"TO '{out}' (FORMAT PARQUET, COMPRESSION ZSTD)"
    )
    n = con.execute(f"SELECT count(*) FROM read_parquet('{src}')").fetchone()[0]
    con.close()
    size_mb = out.stat().st_size / 1e6
    print(f"footprints.parquet        : {n:,} footprints -> {out.name} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
