# near-net · web (V1)

The client-side front end for the Pittsburgh fiber **near-net proximity screen**.
MapLibre GL JS + React/TypeScript + DuckDB-WASM over static GeoParquet — **no
backend, no routing in the browser** (see [`../docs/DESIGN.md`](../docs/DESIGN.md)).

## What it does

Loads a facts-only `buildings.parquet` into **DuckDB-WASM** and runs the §9
closing query live on every slider change; renders building footprints with
**MapLibre** colored by the estimated connection cost. Cost *opinions*
(cost/ft, circuity, per-crossing costs, budget) are sliders; geographic *facts*
(distance, crossings, bridge availability) are baked. The browser does
arithmetic over baked facts.

- **Gradient cost surface** — green (cheap, near the modeled corridor) → red
  (expensive / far); the budget slider is the draggable threshold.
- **Itemized hover** — connector cost + each crossing broken out; the connector
  line for the hovered building is drawn selectively.
- **`in_range`** buildings beyond the plausible service distance gray out
  (never silently dropped).
- **Honesty framing throughout** — "modeled corridor", "lower-bound screen",
  "not a build cost", no real fiber/company data.

## Architecture (browser data shapes)

The build emits authoritative GeoParquet with DuckDB `GEOMETRY` columns; the web
app needs **no spatial extension in the browser**, so `build/export_web.py`
splits each into two browser-native shapes:

| Asset | Used by | Notes |
|---|---|---|
| `data/buildings.parquet` (facts only) | DuckDB-WASM | numeric/varchar cols; the §9 closing query runs over this |
| `data/buildings.geojson` | MapLibre | footprints; cost result joins by `building_id` via `feature-state` |
| `data/connectors.geojson` | MapLibre | 2-point connector lines, shown on hover |
| `data/{network,barriers_*,bridges}.geojson` | MapLibre | display layers |

## Run locally

Two steps: build the data once (Python), then run the web app (Node).

```bash
# 1) data — from the repo root, in the `nearnet` conda env
python -m build.precompute --full      # writes data/*.parquet  (~116k buildings)
python -m build.export_web             # writes web/public/data/* (parquet + geojson)

# 2) web — from web/
npm install
npm run dev                            # http://localhost:5173
```

`web/public/data/` is gitignored (derived + large); regenerate it with
`export_web` after any rebuild.

## Build / deploy

```bash
npm run build       # tsc + vite -> web/dist/  (base is relative, gh-pages-safe)
npm run preview     # serve the production build locally
```

`vite.config.ts` uses a relative `base` so the build works under the GitHub
Pages project path. Deploy serves `web/dist/` as static files — Pages serves the
parquet/GeoJSON like images. The data assets in `web/public/data/` are copied
into `dist/` by Vite at build time, so the deploy job must run `export_web`
(and therefore `precompute`) before `npm run build`.

### Known V1 trade-off

`buildings.geojson` (~41 MB) and `connectors.geojson` (~28 MB) are loaded whole.
Fine for the demo; the production optimization is PMTiles / vector tiles for the
footprints (DESIGN §11) — a swap behind the same `feature-state` join.

## Basemap

CARTO Positron raster (free, no API key, OSM-derived). PMTiles is the intended
production basemap (DESIGN §11); raster keeps the V1 demo dependency-free.

## Data attribution

© OpenStreetMap contributors (ODbL), Overture Maps, USGS NHD, US Census TIGER.
Code: MIT. Data carries its own terms — see [`../docs/DESIGN.md`](../docs/DESIGN.md) §12.
