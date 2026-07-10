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


def _dump_geojson(con: duckdb.DuckDBPyConnection, sql: str, props: list[str], out: Path,
                  id_prop: str = "building_id") -> int:
    """Run `sql` (must yield a `g` GeoJSON-string column + `props`), write a FeatureCollection.

    `id_prop` (if present in `props`) becomes each Feature's top-level `id` so MapLibre
    `promoteId` / `feature-state` can key on it (buildings -> building_id, cells -> cell_id).
    """
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
                "id": r[pidx[id_prop]] if id_prop in pidx else None,
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

    # 1b) V2 routed connector polylines, keyed by building_id, as GeoJSON text (no
    #     spatial ext needed in the browser). Fetched one-at-a-time on hover to draw
    #     the real road-following path; the straight cx,cy→nx,ny line is the fallback.
    conn_out = WEB_DATA / "connectors.parquet"
    con.execute(
        f"COPY (SELECT building_id, "
        f"ST_AsGeoJSON(ST_ReducePrecision(connector_geometry, 1e-6)) AS conn_geojson "
        f"FROM read_parquet('{b}')) "
        f"TO '{conn_out}' (FORMAT PARQUET, COMPRESSION ZSTD)"
    )
    print(f"connectors.parquet        : {n_facts:,} routed polylines -> {conn_out.name} "
          f"({conn_out.stat().st_size / 1e6:.1f} MB)")

    # 2) Buildings → TWO GeoJSON inputs for tippecanoe (tiled below): footprint
    #    polygons (zoomed in) and centroid points (overview). Both carry the numeric
    #    facts as properties so the cost surface is colored by a MapLibre paint
    #    expression, plus the connector's corridor endpoint (cx,cy → nx,ny) as the
    #    straight-line hover FALLBACK shown until the real routed polyline (from
    #    connectors.parquet) resolves. nx,ny = the LAST vertex (the corridor end) so
    #    the fallback still points at the corridor, not V1's 2-point 2nd vertex.
    fact_select = (
        "building_id, in_range, "
        "CAST(ROUND(connector_distance_ft) AS INTEGER) AS connector_distance_ft, "
        "water_crossings, rail_crossings, interstate_crossings, arterial_crossings, "
        "bridge_available, "
        "ROUND(centroid_lon, 6) AS cx, ROUND(centroid_lat, 6) AS cy, "
        "ROUND(ST_X(ST_PointN(connector_geometry, CAST(ST_NPoints(connector_geometry) AS INTEGER))), 6) AS nx, "
        "ROUND(ST_Y(ST_PointN(connector_geometry, CAST(ST_NPoints(connector_geometry) AS INTEGER))), 6) AS ny"
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

    # 4) Modeled corridor (primary roads).
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

    # 7.5) V1.5 cell layer (DESIGN.md §14) — additive & removable: skipped cleanly if the
    #      cell files don't exist, so a V1-only build still exports without them.
    _export_cells(con)

    con.close()

    # 8) Tile the two heavy building layers to PMTiles (the small layers stay GeoJSON).
    _build_tiles()

    print(f"\nWeb assets written to {WEB_DATA}")


def _export_cells(con: duckdb.DuckDBPyConnection) -> None:
    """V1.5 cell layer -> browser assets (DESIGN.md §14). Same split as buildings:
    facts-only parquet for DuckDB-WASM + hex-geometry GeoJSON for MapLibre.

    GeoJSON (not PMTiles) for the hexes: at ~260 (r8) / ~1,440 (r9) features the file is
    tiny, and MapLibre `feature-state` needs a clean per-feature `promoteId: cell_id`
    with no tile-boundary feature splitting.
    """
    any_cells = False
    for res, src in config.OUT_CELLS.items():
        if not src.exists():
            continue
        any_cells = True
        # (a) facts-only parquet for DuckDB-WASM (drop geometry), twin of buildings.parquet.
        fact_cols = ", ".join(config.CELL_FACT_COLUMNS)
        con.execute(
            f"COPY (SELECT {fact_cols} FROM read_parquet('{src}')) "
            f"TO '{WEB_DATA / f'cells_r{res}.parquet'}' (FORMAT PARQUET, COMPRESSION ZSTD)"
        )
        # (b) hex geometry GeoJSON, cell_id promoted to Feature.id for feature-state.
        #     Raw facts ride along as properties (ranked table + hover need no 2nd fetch);
        #     the SCORE is computed live in the browser (§14.7).
        n = _dump_geojson(
            con,
            f"SELECT cell_id, h3_res, building_count, poi_count_sum, "
            f"conn_dist_median_ft, total_crossings_mean, clipped_area_frac, "
            f"ROUND(centroid_lon, 6) AS clon, ROUND(centroid_lat, 6) AS clat, "
            f"ST_AsGeoJSON(geometry) AS g FROM read_parquet('{src}')",
            ["cell_id", "h3_res", "building_count", "poi_count_sum",
             "conn_dist_median_ft", "total_crossings_mean", "clipped_area_frac", "clon", "clat"],
            WEB_DATA / f"cells_r{res}.geojson",
            id_prop="cell_id",
        )
        print(f"cells_r{res}.geojson         : {n:,} hexes")
    # (c) cell_stats.parquet — copied verbatim for DuckDB-WASM normalization binding.
    if any_cells and config.OUT_CELL_STATS.exists():
        shutil.copy2(config.OUT_CELL_STATS, WEB_DATA / "cell_stats.parquet")
        print("cell_stats.parquet        : copied")
    if not any_cells:
        print("cells                     : none found (V1-only build) — skipped")


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
    # Tight zoom ranges keep the tilesets small (features are stored per zoom
    # level, so every extra level multiplies size + the deploy payload). MapLibre
    # overzooms the top level, so a narrow range still renders when zoomed past it.
    runs = [
        # Centroid points — overview surface (layer is visible only below z14).
        ["tippecanoe", "-o", str(WEB_DATA / "points.pmtiles"), "-l", "buildings_pts",
         "-Z11", "-z13", "--drop-densest-as-needed", "-f", str(points_in)],
        # Footprint polygons — fade in at z12 (layer minzoom 12); z12-15, overzoomed
        # past 15. Raise the per-tile byte/feature ceilings (default 500KB/200k) so
        # the dense downtown tiles keep (nearly) every footprint at low zoom instead
        # of being thinned — bigger tileset (~31MB) for a fuller z12/z13 surface.
        # drop-densest stays as a backstop only if a tile still blows past 3MB.
        ["tippecanoe", "-o", str(WEB_DATA / "footprints.pmtiles"), "-l", "buildings",
         "-Z12", "-z15", "--drop-densest-as-needed",
         "--maximum-tile-bytes=3000000", "--maximum-tile-features=500000",
         "-f", str(foot_in)],
    ]
    for cmd in runs:
        out = Path(cmd[2]).name
        print(f"  [tiles] tippecanoe -> {out}")
        subprocess.run(cmd, check=True, capture_output=True, text=True)
        print(f"          {out}: {Path(cmd[2]).stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
