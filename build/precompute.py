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
    from build import config as C, emit, geometry, measure, sources
else:
    from . import config as C, emit, geometry, measure, sources


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
    if reachable is not None:
        print(f"  closing query          {reachable:,} reachable")
    print(f"  report                 {C.REPORT_MD}")
    print(f"  elapsed                {dt:.1f}s")
    print("──────────────────────────────────────────────────────────")


if __name__ == "__main__":
    main()
