"""Emit GeoParquet (geometry back to EPSG:4326) + validate the §9 closing query.

Writes buildings.parquet (all DESIGN.md §9 columns) and the companion display layers via
geopandas.to_parquet (GeoParquet 1.0 / WKB by default), then runs the §9 closing query in
DuckDB over the emitted file — proving the V1 contract executes purely as arithmetic over
the baked facts (no routing, no road graph).
"""

from __future__ import annotations

import duckdb

from . import config as C


def write_layers(built: dict) -> None:
    C.ensure_dirs()
    built["buildings"].to_parquet(C.OUT_BUILDINGS)        # GeoParquet by default (geopandas >=1.0)
    built["network"].to_parquet(C.OUT_NETWORK)
    if not built["bridges"].empty:
        built["bridges"].to_parquet(C.OUT_BRIDGES)
    for tier, path in C.OUT_BARRIERS.items():
        layer = built["barriers"].get(tier)
        if layer is not None and not layer.empty:
            layer.to_parquet(path)


def _sql_bool(v: bool) -> str:
    return "TRUE" if v else "FALSE"


def run_closing_query(buildings_path=None, sliders: dict | None = None) -> int:
    """DESIGN.md §9 closing query, run over the emitted buildings.parquet.

    Every :param here is a browser slider at runtime; baking sample values only proves
    the query executes. Returns the reachable-building count.
    """
    buildings_path = str(buildings_path or C.OUT_BUILDINGS)
    s = sliders or C.SAMPLE_SLIDERS
    con = duckdb.connect()
    sql = f"""
        SELECT count(*) FROM (
            SELECT building_id,
                connector_distance_ft * {s['circuity']} * {s['cost_per_ft']}
                + water_crossings * (CASE WHEN bridge_available AND {_sql_bool(s['use_bridges'])}
                                          THEN {s['bridge_cost']} ELSE {s['bore_cost']} END)
                + rail_crossings       * {s['rail_cost']}
                + interstate_crossings * {s['interstate_cost']}
                + arterial_crossings   * {s['arterial_cost']}
                AS est_cost
            FROM read_parquet('{buildings_path}')
        ) WHERE est_cost <= {s['budget']}
    """
    return con.execute(sql).fetchone()[0]


def describe(buildings_path=None) -> list[tuple]:
    """DuckDB DESCRIBE of the emitted buildings.parquet (schema sanity check)."""
    buildings_path = str(buildings_path or C.OUT_BUILDINGS)
    con = duckdb.connect()
    return con.execute(f"DESCRIBE SELECT * FROM read_parquet('{buildings_path}')").fetchall()


def emit(built: dict) -> int:
    write_layers(built)
    return run_closing_query()
