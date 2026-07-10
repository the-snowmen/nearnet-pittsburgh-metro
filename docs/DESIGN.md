# near-net — Current Architecture

near-net is a client-side proximity screen for Pittsburgh. It combines public base geometry with
synthetic/proxy network attributes to help explore modeled connection scenarios. It is a screening
tool: it does not represent a verified network, produce a quote, or route in the browser.

## Product contract

- **Model labels:** use “modeled corridor,” “potential lower-cost crossing,” and “screening
  estimate.” Do not present proxy attributes as verified infrastructure.
- **No browser routing:** routing and spatial joins run once during the offline build. GitHub Pages
  serves the resulting files as static bytes; the browser only reads facts and performs arithmetic.
- **Fact/opinion split:** distances, crossing counts, bridge proximity, and aggregation statistics
  are baked facts. Cost rates, slack, budget, and index weights are live browser assumptions.
- **Public inputs only:** the project uses public Overture, OpenStreetMap, USGS NHD, and Census
  TIGER data. No private source data is part of the repository or deployed assets.

## Data pipeline

The build is reproducible from `build/precompute.py`. It ingests and clips source layers to the
City of Pittsburgh boundary (Census TIGER PLACE FIPS 4261000), then measures everything in
EPSG:2272 (NAD83 / Pennsylvania South, US survey feet). Display geometry is written in EPSG:4326.

```text
Public source layers
  → EPSG:2272 spatial processing
  → multi-source Dijkstra from primary-road nodes
  → routed connector distance and crossing facts per building
  → GeoParquet facts, PMTiles surfaces, and compact display layers
  → static GitHub Pages assets
  → DuckDB-WASM + MapLibre in the browser
```

`buildings.parquet` has one row per candidate building. Important fields include:

- `connector_distance_ft`: road-routed distance from a building’s graph snap to the modeled
  corridor; a disconnected graph component receives a straight-line fallback so the field is never
  null.
- `water_crossings`, `rail_crossings`, `interstate_crossings`, and `arterial_crossings`: counts
  from the routed connector, measured with `ST_Crosses` so touching or overlapping a barrier is not
  charged as a crossing.
- `bridge_available`: a proximity signal that a bridge is near a water crossing. It is not a
  routed-through-bridge claim.
- `in_range`: a baked plausibility flag. The current routed-distance threshold is 4,000 ft.
- `poi_count`: a modeled tenant-density signal derived from whitelisted, nearest-building-snapped
  public Overture places; it is not a customer or revenue measure.

The model uses OSM `primary` roads as the modeled corridor. `motorway`/`trunk`, rail, water, and
`secondary` roads are crossing barriers. The corridor choice is deliberately sparse: a full-city
measurement found that including `secondary` roads put 86.3% of buildings in range and removed the
arterial crossing signal. The deployed primary-only model preserves a useful screen.

## Browser behavior

The browser loads a facts-only GeoParquet mirror into DuckDB-WASM and renders building geometry
from PMTiles. Cost is recomputed from the selected assumptions:

```text
connector distance × slack × cost per foot
+ crossing counts × their selected rates
```

The same model drives DuckDB statistics, the selected-building itemization, and the MapLibre color
expression. A building dossier fetches its routed connector, public listings, and nearest address
only when selected. The H3 cell overview aggregates the same baked building facts into a unitless,
tunable opportunity index; it always drills back into the building-level screen.

## Deployed assets and performance

`web/public/data/` is tracked intentionally. It contains the files served by Pages, including the
facts parquet, routed connectors, PMTiles surfaces, and H3 aggregates. The deployment workflow does
not recreate the Python pipeline; it runs `npm ci`, tests the browser cost model, builds `web/dist`,
and publishes that artifact.

The map uses a hybrid surface: dots at overview scales and footprint tiles when zoomed in. The
cost surface recolors through a MapLibre expression rather than one mutation per building.

## Sources and licensing

| Layer | Source | Notes |
|---|---|---|
| Buildings and places | Overture Maps | public geometry and listings |
| Roads, barriers, bridges, road graph | OpenStreetMap | ODbL attribution applies |
| Waterways | USGS NHD | public-domain source |
| Municipal boundary | Census TIGER | public-domain source |

Code is MIT. The deployed data retains its upstream terms: OpenStreetMap requires attribution and
may carry share-alike obligations for derived data; Overture, USGS NHD, and Census TIGER retain
their applicable attribution terms. The application shows source attribution in its map panel.

## Maintenance

- Rebuild data locally when the offline pipeline changes, then commit the refreshed
  `web/public/data/` files.
- Keep model labels specific and modest. A more detailed model is not a more authoritative result.
- Keep browser work limited to reads and arithmetic over static facts.
- See [HISTORY.md](HISTORY.md) for release milestones and superseded design decisions.
