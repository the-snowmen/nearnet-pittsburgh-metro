# near-net · web

The client-side front end for the Pittsburgh **near-net proximity screen**.
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
- **Itemized hover** — connector cost + each crossing broken out; the routed
  connector line for the hovered building is drawn selectively.
- **Click-to-select dossier** — a building panel with its cost breakdown, the
  nearest modeled corridor, **per-POI detail**, and the nearest OSM address, plus
  **per-building KMZ export** (footprint + listings + routed connector).
- **Cell-overview altitude** — an H3 opportunity-index choropleth (r8/r9) that
  drills back down into the building screen.
- **Mobile bottom sheet** — the dossier/controls become a draggable sheet on
  small screens.
- **`in_range`** buildings beyond the plausible service distance gray out
  (never silently dropped).
- **Honesty framing throughout** — "modeled corridor", "lower-bound screen",
  "not a quote", no verified network or operator data.

## Architecture (browser data shapes)

The build emits authoritative GeoParquet with DuckDB `GEOMETRY` columns; the web
app needs **no spatial extension in the browser**, so `build/export_web.py`
splits the footprint surface into **PMTiles vector tiles** and keeps the per-row
facts (and small per-building geometry) as **parquet**:

| Asset | Used by | Notes |
|---|---|---|
| `data/buildings.parquet` (facts only) | DuckDB-WASM | numeric/varchar cols; the §9 closing query runs over this |
| `data/footprints.pmtiles` | MapLibre | the hybrid surface — dots overview / footprints zoomed; cost result joins by `building_id` via `feature-state` |
| `data/points.pmtiles` | MapLibre | overview dot layer |
| `data/connectors.parquet` | DuckDB-WASM → MapLibre | **routed** connector polyline, fetched one building at a time on select/hover |
| `data/footprints.parquet` | export | GeoJSON-text footprint used by the client-side KMZ export |
| `data/pois.parquet`, `data/building_address.parquet` | DuckDB-WASM | per-POI dossier detail + nearest OSM address |
| `data/cells_r{8,9}.parquet`, `data/cell_stats.parquet` | DuckDB-WASM | H3 cell-overview aggregates + normalization stats |
| `data/{network,barriers_*,bridges,boundary}.geojson` | MapLibre | display layers |

## Run locally

Two steps: build the data once (Python), then run the web app (Node).

```bash
# 1) data — from the repo root, in the `nearnet` conda env
python -m build.precompute --full      # writes data/*.parquet  (~116k buildings)
python -m build.export_web             # writes web/public/data/* (parquet + PMTiles + geojson)

# 2) web — from web/
npm ci
npm run dev                            # http://localhost:5173
```

`web/public/data/` is **tracked** (it ships to GitHub Pages so CI does not rebuild
the pipeline); regenerate it with `export_web` after any rebuild and commit the result.

## Build / deploy

```bash
npm run build       # tsc + vite -> web/dist/  (base is relative, gh-pages-safe)
npm test            # unit tests for the shared cost model
npm run preview     # serve the production build locally
```

`vite.config.ts` uses a relative `base` so the build works under the GitHub
Pages project path. Deploy serves `web/dist/` as static files — Pages serves the
parquet/GeoJSON like images. The data assets in `web/public/data/` are committed
to the repo and copied into `dist/` by Vite at build time, so CI runs **no**
Python: the deploy job runs `npm ci`, `npm test`, and `npm run build`. Regenerate the data
locally with `export_web` and commit it whenever the pipeline changes.

### Footprint surface (done)

Early builds loaded the whole footprint/connector GeoJSON (~41 MB / ~28 MB) into
the browser. That has been replaced by **PMTiles vector tiles** for the footprints
(the DESIGN §11 optimization) behind the same `feature-state` join, with the routed
connector fetched one building at a time from `connectors.parquet` — so nothing
multi-MB loads whole anymore.

## Basemap

CARTO Positron raster (free, no API key, OSM-derived). PMTiles is the intended
production basemap (DESIGN §11); the raster keeps the demo dependency-free.

## Data attribution

© OpenStreetMap contributors (ODbL), Overture Maps, USGS NHD, US Census TIGER.
Code: MIT. Data carries its own terms — see [`../docs/DESIGN.md`](../docs/DESIGN.md) §12.
