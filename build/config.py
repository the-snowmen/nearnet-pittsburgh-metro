"""Locked constants + Phase-0 tunable starting guesses for the near-net build.

Single source of truth for the build code. Every value here is traceable to
``docs/DESIGN.md`` (cited inline). Numbers marked *Phase-0 tunable* are starting
guesses that ``measure.py`` is meant to refine against the real data — they do
not block the build, only the final data emission.
"""

from __future__ import annotations

from pathlib import Path

# --------------------------------------------------------------------------- #
# Coordinate reference systems (DESIGN.md §2)
# --------------------------------------------------------------------------- #
COMPUTE_CRS = 2272  # NAD83 / PA State Plane South, US survey feet. ALL geometry math.
DISPLAY_CRS = 4326  # lon/lat for MapLibre. Geometry written back to this on emit.
# Source CRSs of incoming layers (documented; .to_crs handles the conversion):
#   Overture / OSM  -> EPSG:4326
#   pygris TIGER    -> EPSG:4269 (NAD83)

# --------------------------------------------------------------------------- #
# Scope boundary — City of Pittsburgh, Census TIGER PLACE (DESIGN.md §7)
# --------------------------------------------------------------------------- #
CLIP_STATE = "PA"
CLIP_GEOID = "4261000"  # state FIPS 42 + place FIPS 61000 = Pittsburgh city
TIGER_YEAR = 2024       # pygris default; full-res TIGER/Line (cb=False)

# Coarse fallback bbox (lon/lat) used ONLY to pre-prune Overture before the exact
# TIGER clip. At runtime we derive the real bbox from the clip polygon; this is the
# offline/no-network fallback. Envelope of the City of Pittsburgh.
PITTSBURGH_BBOX = {"xmin": -80.10, "xmax": -79.85, "ymin": 40.36, "ymax": 40.50}

# --sample restricts the build to the three-rivers CONFLUENCE (Golden Triangle +
# North Shore + South Side). This is inside the city polygon (so the clip keeps rows,
# unlike a quadkey-LIMIT slice) and spans the Allegheny + Mon so the crossing/bridge
# mechanic is actually exercised by the smoke test.
SAMPLE_BBOX = {"xmin": -80.03, "xmax": -79.97, "ymin": 40.42, "ymax": 40.46}

# --------------------------------------------------------------------------- #
# Overture Maps source (DESIGN.md §8; verified release pin)
# --------------------------------------------------------------------------- #
OVERTURE_RELEASE = "2026-06-17.0"          # pinned; no "latest" alias exists
OVERTURE_S3_REGION = "us-west-2"           # anonymous public bucket; region required
OVERTURE_BASE = f"s3://overturemaps-us-west-2/release/{OVERTURE_RELEASE}"
# theme is PLURAL, type is SINGULAR:
OVERTURE_THEMES = {
    "buildings": "theme=buildings/type=building",
    "places": "theme=places/type=place",
    "addresses": "theme=addresses/type=address",
}

# Overture leaf-category -> top-level group taxonomy (for the POI whitelist).
# The string reconciliation against this CSV is the Phase-0 mechanical step noted
# in docs/POI_CATEGORIES.md.
OVERTURE_CATEGORIES_CSV_URL = (
    "https://raw.githubusercontent.com/OvertureMaps/schema/main/"
    "docs/schema/concepts/by-theme/places/overture_categories.csv"
)

# POI opportunity-signal whitelist — Overture top-level category GROUPS that count
# toward poi_count. Mirrors docs/POI_CATEGORIES.md (the tunable source of truth).
# A place is counted iff its primary leaf category maps to a group in this set.
POI_WHITELIST_GROUPS = {
    # INCLUDE — core (connectivity buyers)
    "eat_and_drink", "retail", "accommodation", "professional_services",
    "business_to_business", "financial_service", "health_and_medical", "education",
    "public_service_and_government", "arts_and_entertainment", "real_estate", "mass_media",
    # INCLUDE — borderline (defaulted IN)
    "automotive", "beauty_and_spa", "active_life", "religious_organization", "pets",
}

# --------------------------------------------------------------------------- #
# Network & barrier classes — one role per OSM class (DESIGN.md §4, §5.3)
# --------------------------------------------------------------------------- #
CORRIDOR_HIGHWAY = {"primary"}                 # modeled corridor (§4 escape hatch measured:
                                               # promoting secondary over-densifies — 86.3% in-range,
                                               # arterial-crossing story collapses — so kept sparse)

# V2 routing (DESIGN.md §3/§5.4) — the connector is a REAL road-following path,
# solved offline over an OSM street graph. network_type="drive" is the connected
# drivable street network the model follows to reach the primary backbone.
ROUTING_NETWORK_TYPE = "drive"
INTERSTATE_HIGHWAY = {"motorway", "trunk"}     # -> interstate_crossings
ARTERIAL_HIGHWAY = {"secondary"}               # -> arterial_crossings
ALL_HIGHWAY = CORRIDOR_HIGHWAY | INTERSTATE_HIGHWAY | ARTERIAL_HIGHWAY

RAIL_TAGS = {"railway": "rail"}                # -> rail_crossings
BRIDGE_TAGS = {"bridge": "yes"}                # discounted-crossing proxy (§7); ALL bridge ways
# Water barrier as CENTERLINES (DESIGN.md §5.2): OSM river/canal centerlines, not area polygons.
# (NHD is the V2/optional upgrade noted in DESIGN.md §8.)
WATER_TAGS = {"waterway": ["river", "canal"]}

# Barrier tier -> output column (DESIGN.md §9 schema)
BARRIER_COLUMNS = {
    "water": "water_crossings",
    "rail": "rail_crossings",
    "interstate": "interstate_crossings",
    "arterial": "arterial_crossings",
}

# --------------------------------------------------------------------------- #
# Phase-0 tunable starting guesses (measure.py refines these)
# --------------------------------------------------------------------------- #
POI_SNAP_FT = 150.0                            # nearest-building assignment max distance (DESIGN.md §9)
D_MAX_CANDIDATES_FT = [500.0, 1000.0, 1500.0, 2000.0, 3000.0]  # report in-range fraction at each
D_MAX_FT = 4000.0                              # V2 RE-LOCK vs the ROUTED distribution: 61.8% in-range,
                                               # median routed building (p50 3,011 ft) well inside; grays the
                                               # clearly-far tail; primary-only corridor. (V1 straight-line
                                               # lock was 2,000 ft → 57.5% in-range on p50 1,674 ft.)
BRIDGE_PROXIMITY_FT = 200.0                    # a bridge within this of a water crossing -> bridge_available (§7)
SNAP_GRID_FT = 0.01                            # snap-to-grid so a true crossing never degrades to a FP tangent (§5.2)

# --------------------------------------------------------------------------- #
# Sample slider params — only to VALIDATE the §9 closing query at build time.
# These are cost OPINIONS that live in the browser at runtime; here they merely
# prove the contract executes over the baked facts.
# --------------------------------------------------------------------------- #
SAMPLE_SLIDERS = {
    "circuity": 1.0,         # V2: distance is ROUTED (road-following), so the detour factor is
                             # vestigial. 1.0 = no double-count; slider stays for slack sensitivity (§6.2).
    "cost_per_ft": 30.0,
    "bore_cost": 20000.0,    # fresh barrier crossing
    "bridge_cost": 5000.0,   # discounted crossing where a bridge is available
    "rail_cost": 25000.0,
    "interstate_cost": 15000.0,
    "arterial_cost": 3000.0,
    "use_bridges": True,
    "budget": 100000.0,
}

# --------------------------------------------------------------------------- #
# V1.5 — Aggregate opportunity-index cell layer (DESIGN.md §14)
# A SECOND ALTITUDE on top of the per-building screen: aggregate buildings.parquet
# into H3 hexes, normalize, weight -> a unitless OPPORTUNITY INDEX (never a cost).
# Strictly additive & gated: ships AFTER V1 is live. Adds NO column to
# buildings.parquet (drill-down recomputes the cell live in the browser).
# --------------------------------------------------------------------------- #
# H3 cell unit. Default r8 (~260 cells, neighborhood grain); r9 is the optional
# drill / MAUP-demonstration toggle (~1,575 cells). measure.py confirms the pick.
H3_RESOLUTIONS = [8, 9]
H3_DEFAULT_RES = 8
# h3 spatial indexing: DuckDB community extension `h3` (INSTALL h3 FROM community)
# in the Python build; h3-py is the fallback. Pin the version in requirements.txt
# when the cell build lands (Phase B). Browser drill-down depends on `h3` loading
# in DuckDB-WASM — VERIFY before relying on it (DESIGN §14 open question).

# Phase-0.5 tunable starting guesses for the cell layer (measure.py refines).
CELL_MIN_BUILDINGS = 5            # thin-cell floor: cells below this are excluded/grayed (small-n noise)
CELL_STAT_PERCENTILES = [0.05, 0.25, 0.50, 0.75, 0.95]  # baked into cell_stats.parquet per feature

# The four scorable axes of the cell feature matrix. Each is normalized (z-score
# or min-max) in the browser, then weighted. Demand defaults to DENSITY (per
# building) so the index isn't dominated by cell mass / collinear with size.
CELL_SCORABLE_FEATURES = ["poi_density", "dist_median", "barrier_mean", "bldg"]

# Sample CELL sliders — only to VALIDATE the §14 scoring query at build time.
# These are OPINIONS that live in the browser at runtime (weights >= 0; cost-like
# features are sign-inverted inside the query so all weights stay non-negative).
SAMPLE_CELL_SLIDERS = {
    "w_poi": 0.40, "w_dist": 0.30, "w_barrier": 0.20, "w_bldg": 0.10,  # default weights (sum 1.0)
    "norm": "z",                  # 'z' (z-score) | 'minmax'
    "min_buildings": CELL_MIN_BUILDINGS,
    "score_threshold": 0.30,      # map "hot set" cutoff: Index >= X. LOCKED from Phase-0.5 score
                                  # distribution = top-quintile (p80 ≈ 0.32 r8 / 0.34 r9). Not baked.
    "g_demand": 0.5, "g_cost": 0.5, "g_barrier": 0.5,  # gap-flag z-score cuts
    "demand_mode": "density",     # 'density' (default) | 'mass'
}

# cell_stats.parquet distribution features -> the cell-column expression each stat is
# computed over. FACT-DERIVATION map (which column, not what weight) — the weights /
# normalization stay browser opinions (§14.9). One stats row per (h3_res, feature).
# Both `poi_density` AND `poi_count_sum` are baked so the browser mass<->density toggle
# (SAMPLE_CELL_SLIDERS["demand_mode"]) has a matching mean/std for either axis.
CELL_STAT_SOURCE = {
    "poi_density":   "CAST(poi_count_sum AS double) / NULLIF(building_count, 0)",  # demand DENSITY (default)
    "poi_count_sum": "CAST(poi_count_sum AS double)",                              # demand MASS (toggle)
    "dist_median":   "conn_dist_median_ft",                                        # reachability axis
    "barrier_mean":  "total_crossings_mean",                                       # barrier axis (per-building)
    "bldg":          "CAST(building_count AS double)",                             # size axis
}

# cells_r{res}.parquet column order (DESIGN.md §14.5) — twin of BUILDING_COLUMNS.
# `geometry` is the CLIPPED hex boundary (4326); dropped in the facts-only web parquet.
CELL_COLUMNS = [
    "cell_id", "h3_res", "geometry", "centroid_lon", "centroid_lat",
    "building_count", "in_range_count", "poi_count_sum",
    "conn_dist_median_ft", "conn_dist_p25_ft", "conn_dist_min_ft", "conn_dist_mean_ft",
    "water_crossings_sum", "rail_crossings_sum", "interstate_crossings_sum", "arterial_crossings_sum",
    "total_crossings_mean", "bridge_available_count", "clipped_area_frac",
]
# Facts-only projection for DuckDB-WASM (drop geometry), twin of the buildings split.
CELL_FACT_COLUMNS = [c for c in CELL_COLUMNS if c != "geometry"]

# --------------------------------------------------------------------------- #
# Output schema — buildings.parquet column order (DESIGN.md §9)
# --------------------------------------------------------------------------- #
BUILDING_COLUMNS = [
    "building_id", "geometry", "centroid_lon", "centroid_lat", "building_class",
    "connector_distance_ft", "nearest_network_id", "connector_geometry",
    "water_crossings", "rail_crossings", "interstate_crossings", "arterial_crossings",
    "in_range",
    "bridge_available", "nearest_bridge_ft",
    "poi_count",
]

# --------------------------------------------------------------------------- #
# Paths (all under data/, gitignored)
# --------------------------------------------------------------------------- #
REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
CACHE_DIR = DATA_DIR / "cache"        # raw fetched layers (--skip-fetch reuses these)
OSM_GRAPH_CACHE = CACHE_DIR / "road_graph.graphml"  # V2 routable street graph (osmnx)
OUT_BUILDINGS = DATA_DIR / "buildings.parquet"
OUT_NETWORK = DATA_DIR / "network.parquet"
OUT_BRIDGES = DATA_DIR / "bridges.parquet"
OUT_BARRIERS = {tier: DATA_DIR / f"barriers_{tier}.parquet" for tier in BARRIER_COLUMNS}
REPORT_JSON = DATA_DIR / "phase0_report.json"
REPORT_MD = DATA_DIR / "phase0_report.md"

# V1.5 cell layer outputs (Phase B — written by build/cells.py after buildings.parquet)
OUT_CELLS = {res: DATA_DIR / f"cells_r{res}.parquet" for res in H3_RESOLUTIONS}
OUT_CELL_STATS = DATA_DIR / "cell_stats.parquet"
REPORT05_JSON = DATA_DIR / "phase05_report.json"   # Phase-0.5 cell-layer measurement
REPORT05_MD = DATA_DIR / "phase05_report.md"


def ensure_dirs() -> None:
    """Create data/ and data/cache/ if missing (both gitignored)."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
