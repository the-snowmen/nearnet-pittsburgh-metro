"""Phase-0 measurement — the whole point of the run (DESIGN.md §7, "what the run must MEASURE").

Reports the numbers that DESIGN.md deferred to data: connector_distance_ft distribution
(sets D_max + tests the corridor-density escape hatch), poi_count distribution + snap
drop-rate, and buildings.parquet size with vs without connector_geometry. Writes both
machine (json) and human (md) reports to data/.
"""

from __future__ import annotations

import json

import numpy as np

from . import config as C


def _pctiles(values: np.ndarray, ps=(50, 75, 90, 95, 100)) -> dict:
    if len(values) == 0:
        return {f"p{p}": None for p in ps}
    return {f"p{p}": float(np.percentile(values, p)) for p in ps}


def _size_delta(buildings) -> tuple[int, int]:
    """buildings.parquet bytes WITH vs WITHOUT connector_geometry (DESIGN.md §9 sizing)."""
    p_with = C.DATA_DIR / "_size_with.parquet"
    p_without = C.DATA_DIR / "_size_without.parquet"
    buildings.to_parquet(p_with)
    buildings.drop(columns=["connector_geometry"]).to_parquet(p_without)
    sw, so = p_with.stat().st_size, p_without.stat().st_size
    p_with.unlink()
    p_without.unlink()
    return sw, so


def report(built: dict, reachable: int | None = None) -> dict:
    b = built["buildings"]
    stats = built["stats"]
    dist = b["connector_distance_ft"].to_numpy()
    poi = b["poi_count"].to_numpy()

    size_with, size_without = _size_delta(b)
    poi_s = stats["poi"]
    snap_rate = (poi_s["places_snapped"] / poi_s["places_whitelisted"]
                 if poi_s["places_whitelisted"] else None)

    rep = {
        "scope": {
            "buildings": stats["n_buildings"],
            "corridor_segments": stats["n_corridor_segments"],
            "corridor_length_ft": round(stats["corridor_length_ft"], 1),
        },
        "connector_distance_ft": {
            "percentiles": _pctiles(dist),
            "fraction_beyond_D_max": {
                str(int(dm)): float((dist > dm).mean()) for dm in C.D_MAX_CANDIDATES_FT
            },
            "D_max_used": C.D_MAX_FT,
            "fraction_in_range": float((dist <= C.D_MAX_FT).mean()),
        },
        "poi_count": {
            "percentiles": _pctiles(poi),
            "fraction_with_poi": float((poi > 0).mean()) if len(poi) else None,
            "places_total": poi_s["places_total"],
            "places_whitelisted": poi_s["places_whitelisted"],
            "places_snapped": poi_s["places_snapped"],
            "snap_rate": snap_rate,
            "poi_snap_ft": C.POI_SNAP_FT,
        },
        "barriers": {
            "buildings_with_crossing": stats["barrier_counts"],
            "buildings_with_bridge_available": stats["n_bridge_available"],
        },
        "file_size": {
            "with_connector_geometry_bytes": size_with,
            "without_connector_geometry_bytes": size_without,
            "connector_geometry_overhead_pct": (
                round(100 * (size_with - size_without) / size_without, 1)
                if size_without else None
            ),
        },
        "closing_query_reachable_count": reachable,
    }

    C.REPORT_JSON.write_text(json.dumps(rep, indent=2))
    C.REPORT_MD.write_text(_to_md(rep))
    return rep


def report_cells(cell_out: dict) -> dict:
    """Phase-0.5 cell-layer report (DESIGN.md §14.12) — writes data/phase05_report.{json,md}.

    Per candidate H3 resolution: realized cell count, the building-per-cell distribution
    (MAUP / sample-size legibility), the fraction below the thin-cell floor, an edge-clip
    sanity count, and the opportunity_index score distribution (to lock `score_threshold`
    at a documented percentile, e.g. p80 = top quintile — not an arbitrary line).
    """
    from . import cells  # local import: cells.py is Phase-B, keep measure importable without it

    rep: dict = {"resolutions": {}, "thin_cell_floor": C.CELL_MIN_BUILDINGS,
                 "sample_sliders": C.SAMPLE_CELL_SLIDERS}
    for res, gdf in cell_out["cells"].items():
        bc = gdf["building_count"].to_numpy()
        frac = gdf["clipped_area_frac"].to_numpy()
        scored = cells.score_cells(res, C.SAMPLE_CELL_SLIDERS)
        idx = scored["opportunity_index"].to_numpy()
        rep["resolutions"][res] = {
            "cell_count": int(len(gdf)),
            "buildings_per_cell": {
                "min": int(bc.min()) if len(bc) else None,
                "mean": float(bc.mean()) if len(bc) else None,
                **_pctiles(bc, ps=(5, 25, 50, 75, 95, 100)),
            },
            "frac_below_floor": float((bc < C.CELL_MIN_BUILDINGS).mean()) if len(bc) else None,
            "n_below_floor": int((bc < C.CELL_MIN_BUILDINGS).sum()),
            "edge_hexes": int((frac < 1.0).sum()),
            "interior_hexes": int((frac >= 1.0).sum()),
            "score_distribution": {
                "n_scored": int(len(idx)),
                "n_gap": int(scored["is_gap"].sum()),
                **_pctiles(idx, ps=(50, 75, 80, 90, 95)),
            },
        }

    C.REPORT05_JSON.write_text(json.dumps(rep, indent=2))
    C.REPORT05_MD.write_text(_cells_to_md(rep))
    return rep


def _cells_to_md(r: dict) -> str:
    lines = [
        "# near-net — Phase 0.5 cell-layer measurement report",
        "",
        "_Auto-generated by `build/measure.py` (`report_cells`). Locks the DESIGN.md §14.12 "
        "cell tunables: H3 resolution pick, thin-cell floor, and `score_threshold`._",
        "",
        f"- Thin-cell floor (`CELL_MIN_BUILDINGS`): **{r['thin_cell_floor']}**",
        "",
        "## Per resolution",
        "| res | cells | bldg/cell p50 | p95 | min | mean | < floor | edge hexes | scored | gaps |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for res, d in r["resolutions"].items():
        b = d["buildings_per_cell"]
        s = d["score_distribution"]
        lines.append(
            f"| r{res} | {d['cell_count']:,} | {b['p50']:.0f} | {b['p95']:.0f} | "
            f"{b['min']} | {b['mean']:.1f} | {d['frac_below_floor']:.1%} "
            f"({d['n_below_floor']:,}) | {d['edge_hexes']:,} | {s['n_scored']:,} | {s['n_gap']:,} |"
        )
    lines += ["", "## Opportunity-index score distribution (sets `score_threshold`)",
              "| res | p50 | p75 | p80 (top-quintile) | p90 | p95 |", "|---|---|---|---|---|---|"]
    for res, d in r["resolutions"].items():
        s = d["score_distribution"]
        lines.append(
            f"| r{res} | {s['p50']:.3f} | {s['p75']:.3f} | **{s['p80']:.3f}** | "
            f"{s['p90']:.3f} | {s['p95']:.3f} |"
        )
    lines += ["",
              "_`score_threshold` = p80 gives a top-quintile map \"hot set\" (a documented "
              "percentile, twin of V1's budget cut). Adjust per the demand narrative._", ""]
    return "\n".join(lines)


def _to_md(r: dict) -> str:
    d = r["connector_distance_ft"]
    p = r["poi_count"]
    fz = r["file_size"]
    lines = [
        "# near-net — Phase 0 measurement report",
        "",
        "_Auto-generated by `build/measure.py`. Feeds the deferred tunables back into "
        "DESIGN.md / POI_CATEGORIES.md._",
        "",
        "## Scope",
        f"- Buildings: **{r['scope']['buildings']:,}**",
        f"- Corridor (`primary`) segments: {r['scope']['corridor_segments']:,} "
        f"({r['scope']['corridor_length_ft']:,.0f} ft total)",
        "",
        "## `connector_distance_ft` distribution (sets `D_max`, tests corridor density)",
        "| p50 | p75 | p90 | p95 | max |",
        "|---|---|---|---|---|",
        "| {p50} | {p75} | {p90} | {p95} | {p100} |".format(
            **{k: (f"{v:,.0f}" if v is not None else "—") for k, v in d["percentiles"].items()}
        ),
        "",
        "Fraction of buildings **beyond** each candidate `D_max` (ft):",
        "",
        "| D_max | fraction beyond |",
        "|---|---|",
        *[f"| {dm} | {frac:.1%} |" for dm, frac in d["fraction_beyond_D_max"].items()],
        "",
        f"- **D_max used for `in_range`:** {d['D_max_used']:,.0f} ft → "
        f"**{d['fraction_in_range']:.1%}** of buildings in range.",
        "",
        "## `poi_count` (opportunity signal)",
        f"- Places fetched: {p['places_total']:,} · whitelisted: {p['places_whitelisted']:,} · "
        f"snapped to a building: {p['places_snapped']:,} "
        f"(snap rate {p['snap_rate']:.1%})".replace("None%", "n/a")
        if p["snap_rate"] is not None else
        f"- Places fetched: {p['places_total']:,} · whitelisted: {p['places_whitelisted']:,} "
        f"(taxonomy unavailable — snap rate n/a)",
        f"- Buildings with ≥1 POI: {p['fraction_with_poi']:.1%}"
        if p["fraction_with_poi"] is not None else "- Buildings with ≥1 POI: n/a",
        f"- POI snap distance: {p['poi_snap_ft']:.0f} ft",
        "",
        "## Barriers",
        *[f"- {tier}: {n:,} buildings whose connector crosses it"
          for tier, n in r["barriers"]["buildings_with_crossing"].items()],
        f"- bridge available near a water crossing: "
        f"{r['barriers']['buildings_with_bridge_available']:,} buildings",
        "",
        "## File size — `connector_geometry` cost (DESIGN.md §9 decision check)",
        f"- with connector_geometry: {fz['with_connector_geometry_bytes']:,} bytes",
        f"- without: {fz['without_connector_geometry_bytes']:,} bytes",
        f"- overhead: **{fz['connector_geometry_overhead_pct']}%**"
        if fz["connector_geometry_overhead_pct"] is not None else "- overhead: n/a",
        "",
        f"## Closing-query validation: **{r['closing_query_reachable_count']}** "
        "buildings reachable under the sample sliders"
        if r["closing_query_reachable_count"] is not None else
        "## Closing-query validation: skipped (--measure-only)",
        "",
    ]
    return "\n".join(lines)
