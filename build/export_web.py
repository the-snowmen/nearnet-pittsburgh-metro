"""Export browser-ready assets from the Phase-0 GeoParquet (DESIGN.md §2, §9).

The build (`precompute.py`) emits authoritative GeoParquet in `data/` with DuckDB
``GEOMETRY`` columns (EPSG:4326). This step splits those into two browser-native
shapes so the front end needs **no spatial extension in the browser**:

* ``buildings.parquet`` — facts only (numeric/varchar, the two GEOMETRY columns
  dropped). DuckDB-WASM reads this with zero extensions and runs the §9 closing
  query over it (the documented "browser does arithmetic over baked facts").
* ``*.geojson`` — geometry for MapLibre (footprints, connectors, modeled
  corridor, barrier centerlines, bridges). MapLibre reads GeoJSON natively; the
  per-building cost result joins back onto footprints by ``building_id`` via
  ``feature-state``.

Run inside the ``nearnet`` env (needs duckdb + the spatial extension that wrote
the parquet):  ``python -m build.export_web``
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import duckdb

from . import config

# Browser asset dir — served statically by Vite (dev) / copied into dist (build).
# Derived + large -> gitignored (see .gitignore web/public/data rule).
WEB_DATA = config.REPO_ROOT / "web" / "public" / "data"
# tippecanoe inputs (big building GeoJSON) live OUTSIDE the served dir so they are
# NOT copied into the production dist — only the .pmtiles + small GeoJSON ship.
TILE_SRC = config.DATA_DIR / "_web_tiles_src"

COORD_PRECISION = 6  # ~0.11 m at this latitude; shrinks GeoJSON a lot, lossless for display


def _round_coords(obj):
    """Recursively round every coordinate in a parsed GeoJSON geometry."""
    if isinstance(obj, float):
        return round(obj, COORD_PRECISION)
    if isinstance(obj, list):
        return [_round_coords(x) for x in obj]
    return obj


def _dump_geojson(con: duckdb.DuckDBPyConnection, sql: str, props: list[str], out: Path) -> int:
    """Run `sql` (must yield a `g` GeoJSON-string column + `props`), write a FeatureCollection."""
    rows = con.execute(sql).fetchall()
    cols = [d[0] for d in con.description]
    gi = cols.index("g")
    pidx = {p: cols.index(p) for p in props}
    features = []
    for r in rows:
        gj = r[gi]
        if gj is None:
            continue
        geom = _round_coords(json.loads(gj))
        features.append(
            {
                "type": "Feature",
                "id": r[pidx["building_id"]] if "building_id" in pidx else None,
                "properties": {p: r[pidx[p]] for p in props},
                "geometry": geom,
            }
        )
    fc = {"type": "FeatureCollection", "features": features}
    out.write_text(json.dumps(fc, separators=(",", ":")))
    return len(features)


def main() -> None:
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")

    b = str(config.OUT_BUILDINGS)

    # 1) Facts-only parquet for DuckDB-WASM (drop both GEOMETRY columns).
    fact_cols = [c for c in config.BUILDING_COLUMNS if c not in ("geometry", "connector_geometry")]
    facts_out = WEB_DATA / "buildings.parquet"
    con.execute(
        f"COPY (SELECT {', '.join(fact_cols)} FROM read_parquet('{b}')) "
        f"TO '{facts_out}' (FORMAT PARQUET, COMPRESSION ZSTD)"
    )
    n_facts = con.execute(f"SELECT count(*) FROM read_parquet('{b}')").fetchone()[0]
    print(f"buildings.parquet (facts) : {n_facts:,} rows -> {facts_out.name}")

    # 2) Buildings → TWO GeoJSON inputs for tippecanoe (tiled below): footprint
    #    polygons (zoomed in) and centroid points (overview). Both carry the numeric
    #    facts as properties so the cost surface is colored by a MapLibre paint
    #    expression, plus the connector endpoints (cx,cy → nx,ny) so the hovered
    #    connector is drawn in JS — no separate 28 MB connectors layer needed.
    fact_select = (
        "building_id, in_range, "
        "CAST(ROUND(connector_distance_ft) AS INTEGER) AS connector_distance_ft, "
        "water_crossings, rail_crossings, interstate_crossings, arterial_crossings, "
        "bridge_available, "
        "ROUND(centroid_lon, 6) AS cx, ROUND(centroid_lat, 6) AS cy, "
        "ROUND(ST_X(ST_PointN(connector_geometry, 2)), 6) AS nx, "
        "ROUND(ST_Y(ST_PointN(connector_geometry, 2)), 6) AS ny"
    )
    bldg_props = [
        "building_id", "in_range", "connector_distance_ft",
        "water_crossings", "rail_crossings", "interstate_crossings",
        "arterial_crossings", "bridge_available", "cx", "cy", "nx", "ny",
    ]
    TILE_SRC.mkdir(parents=True, exist_ok=True)
    n = _dump_geojson(
        con,
        f"SELECT {fact_select}, ST_AsGeoJSON(geometry) AS g FROM read_parquet('{b}')",
        bldg_props,
        TILE_SRC / "buildings.geojson",
    )
    print(f"buildings.geojson (tile src): {n:,} footprints")
    n = _dump_geojson(
        con,
        f"SELECT {fact_select}, ST_AsGeoJSON(ST_Point(centroid_lon, centroid_lat)) AS g "
        f"FROM read_parquet('{b}')",
        bldg_props,
        TILE_SRC / "points.geojson",
    )
    print(f"points.geojson    (tile src): {n:,} centroids")

    # 4) Modeled fiber corridor (primary roads).
    n = _dump_geojson(
        con,
        f"SELECT network_id, highway, ST_AsGeoJSON(geometry) AS g "
        f"FROM read_parquet('{config.OUT_NETWORK}')",
        ["network_id", "highway"],
        WEB_DATA / "network.geojson",
    )
    print(f"network.geojson           : {n:,} corridor segments")

    # 5) Barrier centerlines, one file per tier (geometry only — drop the OSM tag bloat).
    for tier, path in config.OUT_BARRIERS.items():
        n = _dump_geojson(
            con,
            f"SELECT ST_AsGeoJSON(geometry) AS g FROM read_parquet('{path}')",
            [],
            WEB_DATA / f"barriers_{tier}.geojson",
        )
        print(f"barriers_{tier}.geojson{' ' * (max(0, 9 - len(tier)))}: {n:,} features")

    # 6) Bridges (potential lower-cost crossings).
    n = _dump_geojson(
        con,
        f"SELECT COALESCE(name, \"bridge:name\") AS bridge_name, "
        f"ST_AsGeoJSON(geometry) AS g FROM read_parquet('{config.OUT_BRIDGES}')",
        ["bridge_name"],
        WEB_DATA / "bridges.geojson",
    )
    print(f"bridges.geojson           : {n:,} bridges")

    # 7) Clip boundary — City of Pittsburgh outline (TIGER PLACE 4261000), the
    #    geographic extent of the project. Cached as a GeoPandas parquet, so read
    #    it that way and write a dissolved single-polygon GeoJSON.
    import geopandas as gpd

    clip = gpd.read_parquet(config.CACHE_DIR / "clip.parquet").to_crs(config.DISPLAY_CRS)
    boundary_fc = json.loads(clip.dissolve().to_json())
    for feat in boundary_fc["features"]:
        feat["geometry"] = _round_coords(feat["geometry"])
        feat["properties"] = {"name": "City of Pittsburgh"}
    (WEB_DATA / "boundary.geojson").write_text(json.dumps(boundary_fc, separators=(",", ":")))
    print(f"boundary.geojson          : City of Pittsburgh clip outline")

    con.close()

    # 8) Tile the two heavy building layers to PMTiles (the small layers stay GeoJSON).
    _build_tiles()

    print(f"\nWeb assets written to {WEB_DATA}")


def _build_tiles() -> None:
    """tippecanoe -> points.pmtiles (overview cost surface) + footprints.pmtiles (zoom-in).

    Soft-fails with a warning if tippecanoe is absent so the GeoJSON export still
    succeeds. Hybrid render: centroid points carry the surface at overview zooms
    (fast recolor), footprint polygons fade in when zoomed in.
    """
    if not shutil.which("tippecanoe"):
        print("\n  [tiles] tippecanoe not found — skipping PMTiles "
              "(install: `brew install tippecanoe`). GeoJSON still emitted.")
        return

    points_in = TILE_SRC / "points.geojson"
    foot_in = TILE_SRC / "buildings.geojson"
    runs = [
        # Centroid points — overview surface. Keep full detail by z12; thin only the
        # densest cells at the lowest zooms so tiles stay small.
        ["tippecanoe", "-o", str(WEB_DATA / "points.pmtiles"), "-l", "buildings_pts",
         "-Z10", "-z14", "--drop-densest-as-needed", "--extend-zooms-if-still-dropping",
         "-f", str(points_in)],
        # Footprint polygons — only needed when zoomed in (z13+).
        ["tippecanoe", "-o", str(WEB_DATA / "footprints.pmtiles"), "-l", "buildings",
         "-Z13", "-z16", "--drop-densest-as-needed", "--extend-zooms-if-still-dropping",
         "-f", str(foot_in)],
    ]
    for cmd in runs:
        out = Path(cmd[2]).name
        print(f"  [tiles] tippecanoe -> {out}")
        subprocess.run(cmd, check=True, capture_output=True, text=True)
        print(f"          {out}: {Path(cmd[2]).stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
