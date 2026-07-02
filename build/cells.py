"""V1.5 — aggregate the per-building facts into H3 cells (DESIGN.md §14).

A SECOND ALTITUDE on top of buildings.parquet. This stage is a **pure aggregation**
of the already-baked per-building facts into per-H3-cell facts + distribution stats:
SUM / MEAN / MEDIAN / percentile / COUNT only — **no inter-cell adjacency, path, or
flow graph** (guardrail #3; aggregation is where routing is tempting to smuggle back
in). It bakes FACTS (per-cell aggregates + the `cell_stats` distribution); the browser
supplies the OPINIONS (weights, normalization method, thresholds, mass<->density).

Strictly additive & removable (§14.2): writes NEW files
(`cells_r{8,9}.parquet` + `cell_stats.parquet`) and adds **no column** to
buildings.parquet — deleting the cell files leaves V1 fully working.

Implementation note: assignment + hex geometry use **h3-py 4.x** and areas use
`geopandas.to_crs(EPSG:2272)` — the same geopandas/shapely stack as geometry.py /
emit.py. (DuckDB's `h3` community extension is an equivalent alternative; the
geopandas path avoids the EPSG:4326 lat/lon axis-order pitfall in ST_Transform.)

Load-bearing aggregate choices (DESIGN.md §14.5 — do not "simplify" them):
  - poi_count -> SUM                 (demand is additive mass)
  - connector_distance_ft -> MEDIAN  (reachability is a central-tendency question;
                                      a sum conflates mass with cost; median is
                                      outlier-robust for the far-bank geometry)
  - barrier axis = MEAN(total_crossings) PER BUILDING, **not a sum** (a summed count
                    is itself a mass feature — would mark dense cells "barriered")
  - bridge_available -> COUNT        (mitigation availability)
  - nearest_bridge_ft is DELIBERATELY NOT aggregated (meaningful-null per §9; a naive
    AVG would poison it — the bridge signal rides on bridge_available_count)
"""

from __future__ import annotations

import duckdb
import geopandas as gpd
import h3
import numpy as np
import pandas as pd
import shapely

from . import config as C

# Per-building fact columns the aggregation reads (no geometry decode needed).
_FACT_COLS = [
    "centroid_lat", "centroid_lon", "connector_distance_ft", "in_range", "poi_count",
    "water_crossings", "rail_crossings", "interstate_crossings", "arterial_crossings",
    "bridge_available",
]


# --------------------------------------------------------------------------- #
# 1) The pure aggregation — buildings -> per-cell facts
# --------------------------------------------------------------------------- #
def _load_buildings(buildings_path) -> pd.DataFrame:
    """Read only the fact columns from buildings.parquet (skip the WKB geometry)."""
    con = duckdb.connect()
    df = con.execute(
        f"SELECT {', '.join(_FACT_COLS)} FROM read_parquet('{buildings_path}')"
    ).df()
    con.close()
    df["total_crossings"] = (
        df["water_crossings"] + df["rail_crossings"]
        + df["interstate_crossings"] + df["arterial_crossings"]
    )
    return df


def _aggregate(df: pd.DataFrame, res: int) -> pd.DataFrame:
    """Pure GROUP BY over cell_id: the §14.5 per-cell feature vector (facts only)."""
    cell_id = np.fromiter(
        (h3.latlng_to_cell(la, lo, res) for la, lo in zip(df["centroid_lat"], df["centroid_lon"])),
        dtype=object, count=len(df),
    )
    df = df.assign(cell_id=cell_id)
    g = df.groupby("cell_id", sort=False)
    dist = g["connector_distance_ft"]
    agg = pd.DataFrame({
        "building_count":          g.size().astype("int64"),
        "in_range_count":          g["in_range"].sum().astype("int64"),
        "poi_count_sum":           g["poi_count"].sum().astype("int64"),
        "conn_dist_median_ft":     dist.median(),
        "conn_dist_p25_ft":        dist.quantile(0.25),
        "conn_dist_min_ft":        dist.min().astype("float64"),
        "conn_dist_mean_ft":       dist.mean(),
        "water_crossings_sum":     g["water_crossings"].sum().astype("int64"),
        "rail_crossings_sum":      g["rail_crossings"].sum().astype("int64"),
        "interstate_crossings_sum": g["interstate_crossings"].sum().astype("int64"),
        "arterial_crossings_sum":  g["arterial_crossings"].sum().astype("int64"),
        "total_crossings_mean":    g["total_crossings"].mean(),
        "bridge_available_count":  g["bridge_available"].sum().astype("int64"),
    }).reset_index()
    agg.insert(1, "h3_res", res)
    return agg


# --------------------------------------------------------------------------- #
# 2) Hex geometry (h3 boundary) clipped to the City of Pittsburgh (§14.5)
# --------------------------------------------------------------------------- #
def _load_clip_boundary(clip_path) -> shapely.geometry.base.BaseGeometry:
    """City of Pittsburgh polygon (TIGER PLACE), dissolved, in EPSG:4326."""
    clip = gpd.read_parquet(clip_path).to_crs(C.DISPLAY_CRS)
    return clip.union_all()


def _hex_geometry(agg: pd.DataFrame, boundary) -> gpd.GeoDataFrame:
    """Build clipped hex polygons + centroids + clipped_area_frac for each cell."""
    cells = agg["cell_id"].tolist()
    # h3 v4 cell_to_boundary returns ((lat, lng), ...) -> flip to (lng, lat) for shapely.
    full = [shapely.Polygon([(lng, lat) for lat, lng in h3.cell_to_boundary(c)]) for c in cells]
    centroids = [h3.cell_to_latlng(c) for c in cells]   # (lat, lng)
    agg = agg.copy()
    agg["centroid_lat"] = [c[0] for c in centroids]
    agg["centroid_lon"] = [c[1] for c in centroids]

    full_gs = gpd.GeoSeries(full, crs=C.DISPLAY_CRS)
    clipped_gs = full_gs.intersection(boundary)         # edge hexes trimmed to the city
    # Area fraction in EPSG:2272 (US survey feet) — geopandas handles the axis order,
    # so no ST_Transform always_xy pitfall. Interior hexes -> 1.0, edge hexes < 1.0.
    full_area = full_gs.to_crs(C.COMPUTE_CRS).area
    clip_area = clipped_gs.to_crs(C.COMPUTE_CRS).area
    agg["clipped_area_frac"] = (clip_area / full_area).clip(upper=1.0).to_numpy()

    gdf = gpd.GeoDataFrame(agg, geometry=clipped_gs.to_numpy(), crs=C.DISPLAY_CRS)
    return gdf[C.CELL_COLUMNS]


# --------------------------------------------------------------------------- #
# 3) Distribution stats — cell_stats.parquet (§14.6)
# --------------------------------------------------------------------------- #
def _feature_series(cells: pd.DataFrame, feature: str) -> pd.Series:
    """The scorable feature values a browser normalizes (mirrors CELL_STAT_SOURCE)."""
    if feature == "poi_density":
        return cells["poi_count_sum"] / cells["building_count"].replace(0, np.nan)
    if feature == "poi_count_sum":
        return cells["poi_count_sum"].astype("float64")
    if feature == "dist_median":
        return cells["conn_dist_median_ft"].astype("float64")
    if feature == "barrier_mean":
        return cells["total_crossings_mean"].astype("float64")
    if feature == "bldg":
        return cells["building_count"].astype("float64")
    raise KeyError(feature)


def _stats_rows(cells_by_res: dict[int, pd.DataFrame]) -> pd.DataFrame:
    """One row per (h3_res, feature): mean/std/min/max + p05/p25/p50/p75/p95 + iqr.

    Computed over the opinion-free scored set (every emitted cell has
    building_count > 0). The `min_buildings` floor stays a BROWSER opinion (§14.9),
    so it is NOT applied here — baking stats under one floor would invalidate the
    z-scores whenever the user moves the slider.
    """
    ps = C.CELL_STAT_PERCENTILES
    rows = []
    for res, cells in cells_by_res.items():
        for feature in C.CELL_STAT_SOURCE:
            x = _feature_series(cells, feature).dropna().to_numpy()
            q = np.percentile(x, [p * 100 for p in ps]) if len(x) else [np.nan] * len(ps)
            row = {
                "h3_res": res, "feature": feature,
                "mean": float(np.mean(x)) if len(x) else np.nan,
                "std": float(np.std(x, ddof=1)) if len(x) > 1 else 0.0,
                "min": float(np.min(x)) if len(x) else np.nan,
                "max": float(np.max(x)) if len(x) else np.nan,
            }
            row.update({f"p{int(p*100):02d}": float(v) for p, v in zip(ps, q)})
            row["iqr"] = row.get("p75", np.nan) - row.get("p25", np.nan)
            rows.append(row)
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------- #
# 4) The cell closing query (§14.7) — validation twin of emit.run_closing_query
# --------------------------------------------------------------------------- #
def _load_stats_for_res(res: int) -> dict[str, dict]:
    con = duckdb.connect()
    df = con.execute(
        f"SELECT * FROM read_parquet('{C.OUT_CELL_STATS}') WHERE h3_res = {res}"
    ).df()
    con.close()
    return {r["feature"]: r.to_dict() for _, r in df.iterrows()}


def _score_sql(res: int, s: dict, st: dict[str, dict]) -> str:
    """Assemble the §14.7 scoring query over cells_r{res}.parquet + baked stats.

    Pure arithmetic over baked facts — no h3, no routing (this is exactly the shape
    the browser runs). Demand axis = density (default) or mass; cost-like features
    (dist, barrier) are z-negated so every weight stays >= 0.
    """
    density = s.get("demand_mode", "density") == "density"
    poi_expr = ("CAST(poi_count_sum AS double)/NULLIF(building_count,0)"
                if density else "CAST(poi_count_sum AS double)")
    poi_key = "poi_density" if density else "poi_count_sum"

    def z(expr: str, feat: str) -> str:
        f = st[feat]
        if s.get("norm", "z") == "minmax":
            lo, span = f["min"], (f["max"] - f["min"])
            return f"COALESCE(({expr} - {lo})/NULLIF({span},0), 0)"
        return f"COALESCE(({expr} - {f['mean']})/NULLIF({f['std']},0), 0)"

    return f"""
    WITH base AS (
        SELECT * FROM read_parquet('{C.OUT_CELLS[res]}')
        WHERE building_count >= {s['min_buildings']}
    ), z AS (
        SELECT cell_id, centroid_lon, centroid_lat, building_count, poi_count_sum,
               conn_dist_median_ft, total_crossings_mean,
               {z(poi_expr, poi_key)}                    AS z_poi,
               {z('conn_dist_median_ft', 'dist_median')} AS z_dist,
               {z('total_crossings_mean', 'barrier_mean')} AS z_barrier,
               {z('CAST(building_count AS double)', 'bldg')} AS z_bldg
        FROM base
    )
    SELECT cell_id, centroid_lon, centroid_lat,
           building_count, poi_count_sum, conn_dist_median_ft, total_crossings_mean,
           ({s['w_poi']}     * z_poi)      AS c_poi,
           ({s['w_dist']}    * -z_dist)    AS c_dist,
           ({s['w_barrier']} * -z_barrier) AS c_barrier,
           ({s['w_bldg']}    * z_bldg)     AS c_bldg,
           ({s['w_poi']}*z_poi)+({s['w_dist']}*-z_dist)
             +({s['w_barrier']}*-z_barrier)+({s['w_bldg']}*z_bldg) AS opportunity_index,
           (z_poi >= {s['g_demand']}
             AND (z_dist >= {s['g_cost']} OR z_barrier >= {s['g_barrier']})) AS is_gap
    FROM z
    ORDER BY opportunity_index DESC
    """


def score_cells(res: int, sliders: dict | None = None) -> pd.DataFrame:
    """Run the §14.7 scoring query over the emitted cell files. Read-only; bakes nothing."""
    s = sliders or C.SAMPLE_CELL_SLIDERS
    st = _load_stats_for_res(res)
    con = duckdb.connect()
    df = con.execute(_score_sql(res, s, st)).df()
    con.close()
    return df


# --------------------------------------------------------------------------- #
# Public entry point
# --------------------------------------------------------------------------- #
def build_cells(buildings_path=None, resolutions=None, clip_path=None) -> dict:
    """Aggregate buildings.parquet into per-cell facts + stats; write the cell files.

    Returns {"cells": {res: gdf}, "stats": stats_df, "validation": {res: hot_count}}
    for measure.report_cells (Phase-0.5).
    """
    C.ensure_dirs()
    buildings_path = str(buildings_path or C.OUT_BUILDINGS)
    resolutions = resolutions or C.H3_RESOLUTIONS
    clip_path = clip_path or (C.CACHE_DIR / "clip.parquet")

    df = _load_buildings(buildings_path)
    boundary = _load_clip_boundary(clip_path)

    cells_by_res: dict[int, gpd.GeoDataFrame] = {}
    for res in resolutions:
        agg = _aggregate(df, res)
        gdf = _hex_geometry(agg, boundary)
        gdf.to_parquet(C.OUT_CELLS[res])          # GeoParquet (geopandas >= 1.0)
        cells_by_res[res] = gdf

    stats_df = _stats_rows(cells_by_res)
    stats_df.to_parquet(C.OUT_CELL_STATS)         # plain parquet (no geometry)

    # Validate the §14.7 contract executes as pure arithmetic over the baked facts.
    validation = {}
    for res in resolutions:
        scored = score_cells(res, C.SAMPLE_CELL_SLIDERS)
        thr = C.SAMPLE_CELL_SLIDERS["score_threshold"]
        validation[res] = int((scored["opportunity_index"] >= thr).sum())

    return {"cells": cells_by_res, "stats": stats_df, "validation": validation}
