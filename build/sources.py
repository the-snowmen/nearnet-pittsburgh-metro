"""Source fetchers — Overture (DuckDB+httpfs), OSM (OSMnx), TIGER (pygris).

Every layer is fetched in EPSG:4326, clipped to the City of Pittsburgh polygon, and
cached under ``data/cache/`` so ``--skip-fetch`` re-runs entirely offline. Geometry
math happens later in geometry.py (in EPSG:2272); this module only acquires + clips.
"""

from __future__ import annotations

import io
from typing import Iterable

import duckdb
import geopandas as gpd
import osmnx as ox
import pandas as pd
from shapely.geometry import box

from . import config as C


# --------------------------------------------------------------------------- #
# Cache helpers
# --------------------------------------------------------------------------- #
def _cache_path(name: str):
    return C.CACHE_DIR / f"{name}.parquet"


def _save(gdf: gpd.GeoDataFrame, name: str) -> None:
    gdf.to_parquet(_cache_path(name))


def _load(name: str) -> gpd.GeoDataFrame:
    return gpd.read_parquet(_cache_path(name))


def _cache_exists(*names: str) -> bool:
    return all(_cache_path(n).exists() for n in names)


# --------------------------------------------------------------------------- #
# Clip boundary — Census TIGER PLACE (pygris)
# --------------------------------------------------------------------------- #
def get_clip_polygon() -> gpd.GeoDataFrame:
    """City of Pittsburgh TIGER PLACE (GEOID 4261000), returned in EPSG:4326."""
    from pygris import places

    pa = places(state=C.CLIP_STATE, year=C.TIGER_YEAR, cache=True)  # EPSG:4269
    pgh = pa[pa["GEOID"] == C.CLIP_GEOID].copy()
    if pgh.empty:
        raise RuntimeError(
            f"No TIGER PLACE with GEOID {C.CLIP_GEOID} in {C.CLIP_STATE} {C.TIGER_YEAR}"
        )
    return pgh.to_crs(C.DISPLAY_CRS)[["GEOID", "NAME", "geometry"]]


# --------------------------------------------------------------------------- #
# Overture via DuckDB (httpfs + spatial)
# --------------------------------------------------------------------------- #
def _duckdb_con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(f"SET s3_region='{C.OVERTURE_S3_REGION}';")
    return con


def _overture_path(theme_key: str) -> str:
    return f"{C.OVERTURE_BASE}/{C.OVERTURE_THEMES[theme_key]}/*"


def _bbox_where(bbox: dict) -> str:
    # bbox is a STRUCT(xmin,xmax,ymin,ymax); these predicates drive partition +
    # row-group pruning, so keep them on the raw struct (no ST_* wrapping).
    return (
        f"bbox.xmin BETWEEN {bbox['xmin']} AND {bbox['xmax']} "
        f"AND bbox.ymin BETWEEN {bbox['ymin']} AND {bbox['ymax']}"
    )


def _read_overture(con, sql: str) -> gpd.GeoDataFrame:
    df = con.execute(sql).df()
    # DuckDB ST_AsWKB -> bytearray; shapely.from_wkb wants bytes (or None for null geom).
    wkb = df.pop("geometry_wkb").map(lambda b: bytes(b) if b is not None else None)
    geom = gpd.GeoSeries.from_wkb(wkb, crs=C.DISPLAY_CRS)
    return gpd.GeoDataFrame(df, geometry=geom, crs=C.DISPLAY_CRS)


def fetch_overture_buildings(bbox: dict, limit: int | None = None) -> gpd.GeoDataFrame:
    con = _duckdb_con()
    limit_clause = f"LIMIT {limit}" if limit else ""
    sql = f"""
        SELECT id AS building_id,
               class AS building_class,
               ST_AsWKB(geometry) AS geometry_wkb
        FROM read_parquet('{_overture_path("buildings")}', filename=true, hive_partitioning=1)
        WHERE {_bbox_where(bbox)}
        {limit_clause}
    """
    return _read_overture(con, sql)


def fetch_overture_places(bbox: dict) -> gpd.GeoDataFrame:
    con = _duckdb_con()
    sql = f"""
        SELECT id AS place_id,
               categories.primary AS category,
               confidence,
               ST_AsWKB(geometry) AS geometry_wkb
        FROM read_parquet('{_overture_path("places")}', filename=true, hive_partitioning=1)
        WHERE {_bbox_where(bbox)}
    """
    return _read_overture(con, sql)


def fetch_overture_addresses(bbox: dict) -> gpd.GeoDataFrame:
    """Optional labeling/hover layer (DESIGN.md §8). No §9 schema column depends on
    it, so the Phase-0 pipeline does not call this — provided for completeness."""
    con = _duckdb_con()
    sql = f"""
        SELECT id AS address_id, number, street, postcode,
               ST_AsWKB(geometry) AS geometry_wkb
        FROM read_parquet('{_overture_path("addresses")}', filename=true, hive_partitioning=1)
        WHERE {_bbox_where(bbox)}
    """
    return _read_overture(con, sql)


def fetch_overture_category_map() -> dict[str, str]:
    """Overture leaf-category-code -> top-level group, from the published taxonomy CSV.

    Resilient: on any fetch/parse failure returns {} (every place then maps to no
    group -> poi_count 0), and measure.py reports the taxonomy as unavailable.
    """
    try:
        import urllib.request

        with urllib.request.urlopen(C.OVERTURE_CATEGORIES_CSV_URL, timeout=60) as r:
            raw = r.read().decode("utf-8-sig")  # strip BOM on the header
        df = pd.read_csv(io.StringIO(raw), sep=";")
        code_col = df.columns[0]              # "Category code"
        taxo_col = df.columns[1]              # "Overture Taxonomy" — e.g. "[eat_and_drink,restaurant]"
        mapping: dict[str, str] = {}
        for code, taxo in zip(df[code_col], df[taxo_col]):
            if not isinstance(taxo, str):
                continue
            top = taxo.strip().lstrip("[").rstrip("]").split(",")[0].strip()
            if code and top:
                mapping[str(code)] = top
        return mapping
    except Exception as exc:  # noqa: BLE001 - intentional soft fallback
        print(f"  [warn] Overture category taxonomy unavailable ({exc}); poi_count -> 0")
        return {}


# --------------------------------------------------------------------------- #
# OSM via OSMnx 2.x (features_from_polygon)
# --------------------------------------------------------------------------- #
def _fetch_osm_lines(poly_4326, tags: dict) -> gpd.GeoDataFrame:
    ox.settings.use_cache = True
    ox.settings.cache_folder = str(C.CACHE_DIR / "osm_cache")
    try:
        gdf = ox.features_from_polygon(poly_4326, tags)
    except Exception as exc:  # noqa: BLE001 - empty result / no matching features
        print(f"  [warn] OSM fetch for {tags} returned nothing ({exc})")
        return gpd.GeoDataFrame(geometry=[], crs=C.DISPLAY_CRS)
    gdf = gdf[gdf.geometry.type.isin(["LineString", "MultiLineString"])].copy()
    return gdf.reset_index()  # flatten the (element_type, osmid) MultiIndex into columns


def _has_class(cell, wanted: Iterable[str]) -> bool:
    """OSM 'highway' values can be a str or a list (multi-tagged ways)."""
    wanted = set(wanted)
    if isinstance(cell, list):
        return any(v in wanted for v in cell)
    return cell in wanted


def fetch_osm_layers(poly_4326) -> dict[str, gpd.GeoDataFrame]:
    """Fetch roads (split by class), rail, water centerlines, bridges — all EPSG:4326."""
    roads = _fetch_osm_lines(poly_4326, {"highway": list(C.ALL_HIGHWAY)})

    def _split(classes):
        if roads.empty or "highway" not in roads.columns:
            return gpd.GeoDataFrame(geometry=[], crs=C.DISPLAY_CRS)
        mask = roads["highway"].apply(lambda c: _has_class(c, classes))
        return roads[mask].copy()

    return {
        "corridor": _split(C.CORRIDOR_HIGHWAY),
        "interstate": _split(C.INTERSTATE_HIGHWAY),
        "arterial": _split(C.ARTERIAL_HIGHWAY),
        "rail": _fetch_osm_lines(poly_4326, C.RAIL_TAGS),
        "water": _fetch_osm_lines(poly_4326, C.WATER_TAGS),
        "bridges": _fetch_osm_lines(poly_4326, C.BRIDGE_TAGS),
    }


# --------------------------------------------------------------------------- #
# OSM routable street graph — V2 routed connector (DESIGN.md §3/§5.4)
# --------------------------------------------------------------------------- #
def fetch_osm_graph(poly_4326):
    """Routable drivable street graph (networkx MultiDiGraph, EPSG:4326).

    Edges keep their `highway` tag so geometry.py can mark the `primary` corridor
    nodes as routing targets. Separate from the `features_from_polygon` road layer:
    that layer is display/barrier geometry; this is the topology fiber ROW routes over.
    """
    ox.settings.use_cache = True
    ox.settings.cache_folder = str(C.CACHE_DIR / "osm_cache")
    return ox.graph_from_polygon(poly_4326, network_type=C.ROUTING_NETWORK_TYPE, simplify=True)


def _fetch_and_cache_graph(poly_4326):
    """Fresh graph fetch + write to cache (fetch branch — mirrors _save for parquet layers).

    Always refetches so a `--sample` run's small confluence graph never leaks into a
    later `--full` run (same gotcha the parquet cache avoids by re-saving every fetch).
    """
    print("  fetching OSM road graph (osmnx graph_from_polygon) ...")
    G = fetch_osm_graph(poly_4326)
    ox.save_graphml(G, C.OSM_GRAPH_CACHE)
    return G


def _load_cached_graph(poly_4326):
    """skip-fetch road graph: reuse data/cache/road_graph.graphml (fetch once if absent)."""
    if C.OSM_GRAPH_CACHE.exists():
        print("  [cache] loading road_graph.graphml")
        return ox.load_graphml(C.OSM_GRAPH_CACHE)
    return _fetch_and_cache_graph(poly_4326)


# --------------------------------------------------------------------------- #
# Clipping
# --------------------------------------------------------------------------- #
def _clip_lines(gdf: gpd.GeoDataFrame, clip_gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    if gdf.empty:
        return gdf
    return gpd.clip(gdf, clip_gdf).reset_index(drop=True)


def _clip_buildings(buildings: gpd.GeoDataFrame, clip_gdf: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    poly = clip_gdf.geometry.union_all()
    return buildings[buildings.intersects(poly)].reset_index(drop=True)


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #
_LAYER_NAMES = ["buildings", "places", "corridor", "interstate", "arterial", "rail",
                "water", "bridges", "clip"]


def load_layers(sample: int | None = None, skip_fetch: bool = False) -> dict:
    """Return every clipped source layer (EPSG:4326) + the category map.

    skip_fetch reuses data/cache/*.parquet from a prior run (fully offline).
    """
    C.ensure_dirs()

    if skip_fetch and _cache_exists(*_LAYER_NAMES):
        print("  [skip-fetch] loading cached layers")
        layers = {n: _load(n) for n in _LAYER_NAMES}
        layers["road_graph"] = _load_cached_graph(layers["clip"].geometry.union_all())
        layers["category_map"] = fetch_overture_category_map()
        return layers

    city = get_clip_polygon()
    city_poly = city.geometry.union_all()

    if sample:
        # Restrict to the confluence region (inside the city, spans the rivers). Using a
        # spatial window — not a SQL LIMIT — avoids the quadkey-contiguous-slice bias.
        region_poly = city_poly.intersection(
            box(C.SAMPLE_BBOX["xmin"], C.SAMPLE_BBOX["ymin"],
                C.SAMPLE_BBOX["xmax"], C.SAMPLE_BBOX["ymax"])
        )
        clip = gpd.GeoDataFrame(geometry=[region_poly], crs=C.DISPLAY_CRS)
        bbox = dict(C.SAMPLE_BBOX)
    else:
        region_poly = city_poly
        clip = city
        bbox = _bbox_from_polygon(city)

    print("  fetching Overture buildings ...")
    buildings = _clip_buildings(fetch_overture_buildings(bbox), clip)
    if sample and len(buildings) > sample:
        buildings = buildings.sample(sample, random_state=42).reset_index(drop=True)

    print("  fetching Overture places ...")
    places = _clip_buildings(fetch_overture_places(bbox), clip)  # points: intersects-clip

    print("  fetching OSM roads / rail / water / bridges ...")
    osm = fetch_osm_layers(region_poly)
    osm = {k: _clip_lines(v, clip) for k, v in osm.items()}

    layers = {
        "buildings": buildings,
        "places": places,
        "clip": clip,
        **osm,
    }
    for name in _LAYER_NAMES:
        _save(layers[name], name)

    layers["road_graph"] = _fetch_and_cache_graph(region_poly)
    layers["category_map"] = fetch_overture_category_map()
    return layers


def _bbox_from_polygon(clip_gdf: gpd.GeoDataFrame) -> dict:
    minx, miny, maxx, maxy = clip_gdf.to_crs(C.DISPLAY_CRS).total_bounds
    return {"xmin": minx, "xmax": maxx, "ymin": miny, "ymax": maxy}
