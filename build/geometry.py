"""Build geometry — all math in EPSG:2272 (US survey feet), per DESIGN.md §2/§5/§6.

Produces the per-building facts (the V1/V2 swap point):
  - connector (centroid -> foot-of-perpendicular on nearest corridor segment)
  - connector_distance_ft  (PURE straight-line; circuity is a browser slider, never baked)
  - tiered crossing counts  (ST_Crosses gate + 0-D point count, §5.2)
  - bridge_available / nearest_bridge_ft (§7)
  - in_range (<= D_max)     (§9)
  - poi_count               (nearest-building assignment + category whitelist, §9)
"""

from __future__ import annotations

from collections import defaultdict

import numpy as np
import geopandas as gpd
import shapely

from . import config as C
from . import routing


# --------------------------------------------------------------------------- #
# Small geometry helpers
# --------------------------------------------------------------------------- #
def _count_0d(geom) -> int:
    """Number of 0-dimensional (point) components of an intersection geometry.

    Collinear (1-D) overlap returns LineStrings -> not counted (DESIGN.md §5.2).
    """
    if geom is None or geom.is_empty:
        return 0
    gt = geom.geom_type
    if gt == "Point":
        return 1
    if gt == "MultiPoint":
        return len(geom.geoms)
    if gt == "GeometryCollection":
        return sum(_count_0d(g) for g in geom.geoms)
    return 0


def _points_0d(geom) -> list:
    if geom is None or geom.is_empty:
        return []
    gt = geom.geom_type
    if gt == "Point":
        return [geom]
    if gt == "MultiPoint":
        return list(geom.geoms)
    if gt == "GeometryCollection":
        out = []
        for g in geom.geoms:
            out.extend(_points_0d(g))
        return out
    return []


def _crossings(connectors, barrier_geoms, want_points: bool = False):
    """Per-connector crossing counts against one barrier layer.

    Returns (counts ndarray, points_by_conn dict). points_by_conn is only populated
    when want_points=True (used by the water tier for bridge proximity).
    """
    n = len(connectors)
    counts = np.zeros(n, dtype=np.int64)
    pts_by_conn: dict[int, list] = defaultdict(list)
    if len(barrier_geoms) == 0:
        return counts, pts_by_conn

    btree = shapely.STRtree(barrier_geoms)
    pairs = btree.query(connectors, predicate="intersects")  # (2, m): [conn_idx, bar_idx]
    for ci, bi in zip(pairs[0], pairs[1]):
        conn = shapely.set_precision(connectors[ci], C.SNAP_GRID_FT)  # snap-to-grid (§5.2)
        bar = shapely.set_precision(barrier_geoms[bi], C.SNAP_GRID_FT)
        if not shapely.crosses(conn, bar):  # ST_Crosses gate
            continue
        inter = shapely.intersection(conn, bar)
        counts[ci] += _count_0d(inter)
        if want_points:
            pts_by_conn[int(ci)].extend(_points_0d(inter))
    return counts, pts_by_conn


def _nearest_distance(tree: shapely.STRtree, geom) -> float:
    """Distance from a single geometry to its nearest tree member (nan if tree empty)."""
    res = tree.query_nearest(geom, return_distance=True)
    dist = res[1]
    return float(np.min(dist)) if len(dist) else np.nan


# --------------------------------------------------------------------------- #
# POI assignment
# --------------------------------------------------------------------------- #
def snap_places_to_buildings(buildings_2272, places_4326, category_map):
    """Snap each whitelisted Overture place to its single nearest building
    (<= POI_SNAP_FT), one row per place. Shared by the poi_count aggregation
    (_assign_pois) and the V2.3 per-POI detail bake (build/pois.py).

    Returns (snapped_gdf, stats). `snapped` is in COMPUTE_CRS and carries every
    place column (name/phone/address…) plus `building_id` + `snap_ft`.
    """
    stats = {"places_total": int(len(places_4326)), "places_whitelisted": 0,
             "places_snapped": 0}
    if places_4326.empty:
        return places_4326.iloc[0:0], stats

    places = places_4326.to_crs(C.COMPUTE_CRS).copy()
    places["group"] = places["category"].map(category_map)
    white = places[places["group"].isin(C.POI_WHITELIST_GROUPS)].copy()
    stats["places_whitelisted"] = int(len(white))
    if white.empty:
        return white, stats

    right = buildings_2272[["building_id", "geometry"]].reset_index(drop=True)
    joined = white.sjoin_nearest(
        right, how="left", max_distance=C.POI_SNAP_FT, distance_col="snap_ft"
    )
    snapped = joined.dropna(subset=["building_id"])
    # equidistant ties emit multiple rows -> keep the single nearest per place
    snapped = snapped.sort_values("snap_ft").drop_duplicates(subset=["place_id"], keep="first")
    stats["places_snapped"] = int(len(snapped))
    return snapped, stats


def _assign_pois(buildings_2272, places_4326, category_map):
    snapped, stats = snap_places_to_buildings(buildings_2272, places_4326, category_map)
    poi_count = np.zeros(len(buildings_2272), dtype=np.int64)
    if snapped.empty:
        return poi_count, stats
    counts = snapped.groupby("building_id").size()
    mapped = buildings_2272["building_id"].map(counts).fillna(0).astype(np.int64)
    return mapped.to_numpy(), stats


# --------------------------------------------------------------------------- #
# Main entry
# --------------------------------------------------------------------------- #
def build(layers: dict) -> dict:
    buildings = layers["buildings"]
    if buildings.empty:
        raise RuntimeError("No buildings after clip — nothing to build.")

    corridor = layers["corridor"]
    if corridor.empty:
        raise RuntimeError(
            "No `primary` corridor segments in the clip — cannot compute connectors. "
            "Consider the §4 escape hatch (promote `secondary` into the corridor set)."
        )

    # ---- reproject to compute CRS (feet) ---------------------------------- #
    buildings_2272 = buildings.to_crs(C.COMPUTE_CRS).reset_index(drop=True)
    corridor_2272 = (
        corridor.to_crs(C.COMPUTE_CRS).explode(index_parts=False).reset_index(drop=True)
    )
    corridor_2272["network_id"] = [f"net_{i}" for i in range(len(corridor_2272))]

    def _lines(name):
        g = layers[name].to_crs(C.COMPUTE_CRS).explode(index_parts=False)
        return g.geometry.to_numpy()

    barrier_geoms = {
        "water": _lines("water"),
        "rail": _lines("rail"),
        "interstate": _lines("interstate"),
        "arterial": _lines("arterial"),
    }
    bridge_geoms = _lines("bridges")

    # ---- connectors: REAL road-following routed path (V2, DESIGN §3/§5.4) -- #
    # Offline shortest path over the OSM street graph, centroid -> nearest point of
    # the `primary` corridor. Baked into the SAME columns as V1's straight line;
    # NEVER null (disconnected components fall back to the straight-line connector).
    cent_geoms = buildings_2272.geometry.centroid.to_numpy()  # for centroid_lon/lat output
    connector_distance_ft, connectors, nearest_network_id, route_stats = routing.route_to_corridor(
        buildings_2272, layers["road_graph"], corridor_2272
    )

    # ---- tiered crossings (recomputed against the ROUTED path) ------------- #
    crossing_counts = {}
    water_points = {}
    for tier, geoms in barrier_geoms.items():
        counts, pts = _crossings(connectors, geoms, want_points=(tier == "water"))
        crossing_counts[tier] = counts
        if tier == "water":
            water_points = pts

    # ---- bridge mechanic (proximity at the water-crossing point) ---------- #
    n = len(buildings_2272)
    bridge_available = np.zeros(n, dtype=bool)
    nearest_bridge_ft = np.full(n, np.nan)
    if len(bridge_geoms) and water_points:
        btree = shapely.STRtree(bridge_geoms)
        for ci, pts in water_points.items():
            dmin = min((_nearest_distance(btree, p) for p in pts), default=np.nan)
            nearest_bridge_ft[ci] = dmin
            bridge_available[ci] = (not np.isnan(dmin)) and dmin <= C.BRIDGE_PROXIMITY_FT

    # ---- reachability + POIs ---------------------------------------------- #
    in_range = connector_distance_ft <= C.D_MAX_FT
    poi_count, poi_stats = _assign_pois(buildings_2272, layers["places"], layers["category_map"])

    # ---- assemble buildings.parquet (geometry back to 4326) --------------- #
    cent_4326 = gpd.GeoSeries(cent_geoms, crs=C.COMPUTE_CRS).to_crs(C.DISPLAY_CRS)
    conn_4326 = gpd.GeoSeries(connectors, crs=C.COMPUTE_CRS).to_crs(C.DISPLAY_CRS)

    out = buildings[["building_id", "building_class", "geometry"]].copy().reset_index(drop=True)
    out["centroid_lon"] = cent_4326.x.to_numpy()
    out["centroid_lat"] = cent_4326.y.to_numpy()
    out["connector_distance_ft"] = connector_distance_ft
    out["nearest_network_id"] = nearest_network_id
    out["connector_geometry"] = gpd.GeoSeries(conn_4326.to_numpy(), crs=C.DISPLAY_CRS)
    out["water_crossings"] = crossing_counts["water"]
    out["rail_crossings"] = crossing_counts["rail"]
    out["interstate_crossings"] = crossing_counts["interstate"]
    out["arterial_crossings"] = crossing_counts["arterial"]
    out["in_range"] = in_range
    out["bridge_available"] = bridge_available
    out["nearest_bridge_ft"] = nearest_bridge_ft
    out["poi_count"] = poi_count
    out = out[C.BUILDING_COLUMNS]
    out = out.set_geometry("geometry")

    # ---- companion layers (4326) for emit --------------------------------- #
    network_4326 = corridor_2272[["network_id", "highway", "geometry"]].to_crs(C.DISPLAY_CRS) \
        if "highway" in corridor_2272.columns else corridor_2272[["network_id", "geometry"]].to_crs(C.DISPLAY_CRS)
    barriers_out = {
        tier: layers[tier].to_crs(C.DISPLAY_CRS) for tier in C.BARRIER_COLUMNS
    }
    bridges_out = layers["bridges"].to_crs(C.DISPLAY_CRS)

    stats = {
        "n_buildings": int(n),
        "n_corridor_segments": int(len(corridor_2272)),
        "corridor_length_ft": float(corridor_2272.length.sum()),
        "poi": poi_stats,
        "barrier_counts": {t: int((crossing_counts[t] > 0).sum()) for t in barrier_geoms},
        "n_bridge_available": int(bridge_available.sum()),
        "routing": route_stats,
    }

    return {
        "buildings": out,
        "network": network_4326,
        "barriers": barriers_out,
        "bridges": bridges_out,
        "stats": stats,
    }
