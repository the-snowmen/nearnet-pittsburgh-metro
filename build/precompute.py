"""CLI orchestrator for the Phase 0 build: sources -> geometry -> measure -> emit.

Usage (inside the `nearnet` conda env):
    python -m build.precompute --sample 500     # small end-to-end smoke test
    python build/precompute.py --sample 500      # same (path form also supported)
    python -m build.precompute --full            # full City of Pittsburgh run
    python -m build.precompute --skip-fetch ...  # reuse data/cache/ (fully offline)
    python -m build.precompute --measure-only    # skip GeoParquet emission
"""

from __future__ import annotations

import argparse
import time

# Support both `python -m build.precompute` and `python build/precompute.py`.
if __package__ in (None, ""):
    import os
    import sys

    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from build import cells, config as C, emit, geometry, measure, sources
else:
    from . import cells, config as C, emit, geometry, measure, sources


def main() -> None:
    ap = argparse.ArgumentParser(description="near-net Phase 0 offline build")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--sample", type=int, metavar="N",
                      help="cap buildings to N for a fast end-to-end smoke test")
    mode.add_argument("--full", action="store_true",
                      help="full City of Pittsburgh run (all buildings)")
    ap.add_argument("--skip-fetch", action="store_true",
                    help="reuse cached source layers in data/cache/ (offline)")
    ap.add_argument("--measure-only", action="store_true",
                    help="run geometry + measure, skip GeoParquet emission")
    ap.add_argument("--cells", action="store_true",
                    help="V1.5: additionally aggregate buildings.parquet into H3 cell "
                         "layers (additive; needs buildings.parquet on disk)")
    args = ap.parse_args()

    sample = args.sample  # None when --full or unset
    t0 = time.time()

    print(f"[1/4] sources  (sample={sample}, skip_fetch={args.skip_fetch})")
    layers = sources.load_layers(sample=sample, skip_fetch=args.skip_fetch)
    print(f"      buildings={len(layers['buildings'])}, places={len(layers['places'])}, "
          f"corridor={len(layers['corridor'])}")

    print("[2/4] geometry (connectors, crossings, bridge, POI)")
    built = geometry.build(layers)

    reachable = None
    if not args.measure_only:
        print("[3/4] emit     (GeoParquet + §9 closing-query validation)")
        reachable = emit.emit(built)
        print(f"      wrote {C.OUT_BUILDINGS.name}; reachable under sample sliders = {reachable}")
        print("      DESCRIBE buildings.parquet:")
        for col, dtype, *_ in emit.describe():
            print(f"        {col:<24} {dtype}")
    else:
        print("[3/4] emit     (skipped — --measure-only)")

    print("[4/4] measure  (data/phase0_report.{json,md})")
    rep = measure.report(built, reachable=reachable)

    # V1.5 (§14): additive H3 cell layer. Gated behind --cells; runs off the emitted
    # buildings.parquet on disk (the §14.2 ship-order gate — buildings.parquet first).
    cell_out = None
    if args.cells:
        if not C.OUT_BUILDINGS.exists():
            raise SystemExit(
                f"--cells needs {C.OUT_BUILDINGS.name}; run an emit first "
                f"(drop --measure-only, or run --full/--sample without --measure-only)."
            )
        print("[+cells] V1.5   (H3 aggregate — pure GROUP BY over buildings.parquet)")
        cell_out = cells.build_cells()
        measure.report_cells(cell_out)

    dt = time.time() - t0
    dpct = rep["connector_distance_ft"]["percentiles"]
    print("\n── Phase 0 summary ───────────────────────────────────────")
    print(f"  buildings              {rep['scope']['buildings']:,}")
    print(f"  connector_distance_ft  p50={dpct['p50']:.0f}  p90={dpct['p90']:.0f}  "
          f"max={dpct['p100']:.0f}  (D_max={C.D_MAX_FT:.0f} → "
          f"{rep['connector_distance_ft']['fraction_in_range']:.0%} in range)")
    print(f"  poi_count              {rep['poi_count']['fraction_with_poi'] or 0:.0%} of buildings ≥1 POI"
          if rep["poi_count"]["fraction_with_poi"] is not None else "  poi_count              n/a")
    print(f"  connector_geom size    +{rep['file_size']['connector_geometry_overhead_pct']}%")
    rstats = built["stats"].get("routing")
    if rstats:
        print(f"  routing                {rstats['graph_nodes']:,} graph nodes · "
              f"{rstats['n_fallback']:,} straight-line fallback ({rstats['fallback_frac']:.1%})")
    if reachable is not None:
        print(f"  closing query          {reachable:,} reachable")
    print(f"  report                 {C.REPORT_MD}")
    if cell_out is not None:
        print("  ── V1.5 cells ────────────────────────────────────────")
        for res, gdf in cell_out["cells"].items():
            hot = cell_out["validation"][res]
            below = int((gdf["building_count"] < C.CELL_MIN_BUILDINGS).sum())
            print(f"  r{res:<20} {len(gdf):,} cells  ({below:,} < floor)  "
                  f"scored hot-set={hot:,}")
        print(f"  cell report            {C.REPORT05_MD}")
    print(f"  elapsed                {dt:.1f}s")
    print("──────────────────────────────────────────────────────────")


if __name__ == "__main__":
    main()
