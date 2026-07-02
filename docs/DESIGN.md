# near-net — Design Document

**A client-side near-net fiber proximity screen for the Pittsburgh metro.**

This document is the living design record for the project. It captures the architecture, the modeling decisions, and — most importantly — the honesty discipline that keeps the project defensible. It should be updated as decisions change. When in doubt, the rule is: **bake facts, not opinions; label models as models.**

---

## 1. What this is

A fully client-side web app that screens buildings near a modeled fiber network as candidate sales/planning prospects. The user sets a budget and cost assumptions with sliders; the map lights up which buildings are reachable within budget.

It is built **entirely from public open data and general telecom domain knowledge** — the well-documented practice that long-haul and middle-mile fiber follows road right-of-way (§4). It contains **no proprietary or private third-party code or data**.

**Positioning:** a fully client-side, open-stack approach — no backend, no platform dependency, instant-load straight from static files on a CDN. The framing is about architecture and independence (a different set of tradeoffs), not a comparison to any specific product.

---

## 2. Core architectural principle

The whole design rests on one split:

| | Where it lives | When it's computed | What it is |
|---|---|---|---|
| **Geographic facts** | static GeoParquet on GitHub Pages | once, offline, at build time | distances, barrier crossings, bridge availability |
| **Cost opinions** | browser slider state | live, on every slider change | cost-per-foot, crossing weights, budget, **circuity multiplier** |
| **Cell aggregates + norm stats** *(V1.5, §14)* | static GeoParquet (`cells_r{8,9}`, `cell_stats`) | once, offline, at build time | per-hex SUM/MEDIAN/MEAN/COUNT of building facts; distribution stats |
| **Index weights + method + thresholds** *(V1.5, §14)* | browser slider state | live, on every slider change | feature weights, z/min-max choice, score & gap thresholds |

Roads don't move between user sessions, so routing the geography per-session would compute the same answer thousands of times. We route **once, on the build machine**, bake the answers into static files, and let the browser do cheap arithmetic over those facts.

**There is no routing in the browser. Ever.** GitHub Pages serves the precomputed GeoParquet like it would serve an image. The browser reads columns and multiplies.

### Coordinate reference systems (build vs. display)

All geometric computation in the build step happens in a single **planar, feet-native projected CRS**, and only the final geometry is written back to lon/lat for the browser:

- **Compute CRS — EPSG:2272** (NAD83 / Pennsylvania State Plane **South**, US survey feet). Every geometric operation — connector length, perpendicular projection onto segments, crossing tests, bridge-proximity — runs here, so distances and lengths come out **directly in feet** with no unit conversion. EPSG:2272 is the regional standard for Allegheny County / PennDOT District 11, and is a conformal Lambert Conformal Conic projection with sub-0.01% scale distortion across the urban core.
- **Display CRS — EPSG:4326** (lon/lat). All `geometry` columns are written back to 4326 for MapLibre, which expects lon/lat. Distance columns stay in feet.

*Footnote:* EPSG:2272 uses the **US survey foot** (not the international foot — a ~2 ppm difference, negligible at these magnitudes). Every `_ft` column in the schema is therefore US survey feet.

Pittsburgh/Allegheny County is in the **South** zone of PA State Plane (the North zone is EPSG:2271).

### The pipeline

```
[ Build machine — offline, runs once ]
  Overture + OSM/NHD raw data  (ingested as EPSG:4326)
    → reproject to EPSG:2272 (PA State Plane South, US survey feet)
    → Python build step (perpendicular projection, crossing detection, joins)
    → distances/lengths emitted directly in feet; geometry written back to EPSG:4326
    → buildings.parquet + companion layers
            │
            ▼  (committed / uploaded)
[ GitHub Pages — static hosting, no compute ]
  Serves .parquet + PMTiles basemap as static bytes
            │
            ▼
[ User browser ]
  DuckDB-WASM reads columns
    → arithmetic on slider params (incl. circuity)
    → MapLibre renders reachable set
```

The build step must be a **reproducible, committed script** (`build/precompute.py`), not a one-off run by hand. A reviewer opening the repo should see exactly how the data was made — that script is also the proof of the data-honesty claims.

---

## 3. The V1 / V2 contract

The GeoParquet schema is the contract between versions. **Columns are named for what they mean, not how V1 happens to compute them.** This lets V2 swap in better data with zero application-code changes.

- **V1 (ships now):** distance is straight-line, with the circuity adjustment applied **live in the browser** as a slider (see §6.2). Buffer-style proximity screen. The modeled fiber corridor is the **`primary`-road backbone** (§4).
- **V2 (documented, not built):** distance is real road-following routing, computed offline and baked into the *same columns*; crossings become a graph-traversal cost model (§5.4).

The user-facing app is identical across versions. The upgrade is a data swap.

**Inheritance property (extends to V1.5, §14):** the aggregate cell layer is a *pure function* of `buildings.parquet` — every cell feature is a `SUM`/`MEAN`/percentile/`COUNT` of the contract columns above, read by meaning. So when V2 swaps routed distance into the same `connector_distance_ft` column, re-running the (committed) cell stage upgrades the choropleth to routed distances **for free** — a data swap at *both* altitudes, with zero application-code change. A derived view cannot drift from V1.

**V1 is ruthlessly scoped.** No routing rabbit hole. The seductive pull — "let me just compute real road distance so the number's accurate" — is V2 work wearing a V1 hat. Resist it until the buffer screen is live.

---

## 4. The network: highways as modeled fiber corridors

Instead of ambiguous "utility lines," the network is **major surface arterials** (`primary` roads), used as a proxy for likely fiber corridors.

**Rationale:** long-haul and middle-mile fiber genuinely follows road right-of-way — the ROW already exists and permitting is more standardized along it. This is grounded in real telecom practice, not invented.

### Why `primary` only (and why interstates are *not* corridors)

OSM tags roads by **access control**, and that distinction is exactly what decides corridor vs. barrier:

- **Interstates and freeways are `highway=motorway`** — limited-access, grade-separated. You **cannot** drop a building's fiber off a controlled-access road, so motorways are **barriers**, never corridors. (This is why "a primary road might be an interstate" doesn't bite — interstates are motorway, not primary.)
- **`trunk`** is expressway-grade / partially limited-access and inconsistently tagged in the US — treated as a **barrier** in V1 for simplicity (not reliably tappable).
- **`primary`** is the unambiguous **tappable surface major-arterial** (US/state routes and major city arterials — Liberty, Fifth, Forbes, Penn, Carson…). This is the modeled fiber corridor.
- **`secondary`** and below are *not* corridors (see §5.3).

**Why a sparse corridor matters:** if every road carried fiber, every building would be trivially near it and the screen would say nothing. At city scale, `primary` is the major-arterial **spine** — a sparse, connected backbone that gives buildings genuine "breathing room," so reachable/unreachable is meaningful. It is also the realistic **middle-mile** corridor (long-haul fiber follows major-route ROW; `secondary` roads are minor arterials, more of a last-mile story V1 does not model).

**Honesty label (mandatory):** "modeled fiber corridor from major-arterial ROW (`primary`)." Roads *approximate* likely corridors; they are **not** real fiber. Never imply real fiber or company data.

**Phase-0 escape hatch (tunable):** the corridor class set is a parameter, not a hardcoded truth. If Phase 0 measures `primary`-only as too empty (most buildings beyond the plausible service distance `D_max`), promote `secondary` into the corridor set — at which point the arterial barrier tier (§5.3) collapses to "free" or `secondary` takes its dual role. The right density is an empirical question answered by measuring the building→corridor distance distribution on the real Pittsburgh data.

**Measured outcome (full city, 115,914 buildings) — kept `primary`-only.** The escape hatch was tested empirically, not assumed:

| | `primary` only (shipped) | `primary` + `secondary` |
|---|---|---|
| corridor | 963 seg / 399,488 ft | 1,923 seg / 819,183 ft |
| median building→corridor | **1,674 ft** | 777 ft |
| in-range @ `D_max` 2,000 ft | **57.5%** | 86.3% |
| arterial crossings | 25,214 buildings | **0** (tier collapses) |
| water / rail / interstate crossings | 2,256 / 20,855 / 10,968 | 336 / 7,605 / 2,945 |

Promoting `secondary` makes the corridor so dense that **86% of buildings are "in range," the arterial-crossing tier vanishes, and the water/rail/interstate barrier signal drops ~⅔** — i.e. the screen stops discriminating and the barrier story (the whole point of the Pittsburgh narrative, §7) collapses. `primary`-only is **not** "too empty" (57.5% in-range is a healthy, discriminating split), and it is the honest middle-mile corridor. **Decision: keep `primary`-only.** `secondary` remains the arterial *barrier* (§5.3).

Source: OSM roads filtered by functional class.

---

## 5. The barrier model

### 5.1 Corridor vs. barrier — the dual nature

A linear feature is a **corridor when you run parallel to it and a barrier when you cross it perpendicular.** Rail, interstates, and highways all have this dual nature.

This is why railways are **not** modeled purely as barriers in principle. Historically, railroads are among the largest fiber corridors that exist (e.g. Sprint began as Southern Pacific Railroad's telecom arm, running buried long-haul fiber down continuous, single-owner rail ROW). Rail is a corridor when paralleled and a barrier only when crossed.

*(V1 note: while the dual nature is real, V1 implements **rail as a barrier only** and the fiber corridor as `primary` roads. Rail-as-corridor is a documented V2/later enhancement, not a V1 connection target.)*

### 5.2 Crossings as the cost event

Running parallel is cheap. The **perpendicular crossing** is the hard, permit-heavy, expensive event. For rail specifically, a new crossing is typically a bore *under* the tracks (HDD with a casing pipe), because railroads generally don't permit aerial crossings over their tracks.

**The connector** is the line from each building's **centroid** to the **nearest point on the nearest corridor segment** (perpendicular projection — the foot of the perpendicular, or the segment endpoint where the perpendicular falls outside it). This is the true minimum building→network distance (an honest lower bound, §6.1), computed in EPSG:2272, and its `nearest_network_id` is the owning segment.

**Crossing detection rule (precise spatial predicate):** for each barrier type T, the connector registers a crossing **iff `ST_Crosses(connector, barrier_T)`** is true; the crossing **count** is the number of 0-dimensional (point) components of `ST_Intersection(connector, barrier_T)`. Because the DE-9IM `ST_Crosses` predicate requires the interiors to intersect in a dimension **lower than both inputs**, this rejects — *by construction* — the false-positive classes a naive `ST_Intersects` would catch:

- a connector running **collinearly along** a barrier (1-D overlap) → not a crossing;
- a connector merely **touching at an endpoint** (boundary touch) — including its own terminus on the network corridor — → not a crossing (so a building connecting *to* a corridor is never charged a crossing on that same segment);
- only a genuine **transverse cut** (0-D interior point) counts.

Barriers are normalized to **centerlines** (river/rail/interstate), so "crossed the centerline = crossed the feature," the count rule is uniform across types, and the crossing **point** it yields is exactly what the bridge-proximity check (§7) needs. Computed in EPSG:2272 with snap-to-grid so a true crossing never degrades into a floating-point tangent miss.

### 5.3 Tiered, not binary

Crossings are tiered by barrier type because their real-world difficulty differs. **Each OSM class plays exactly one role** (no road sits in two layers):

| Barrier tier | Source classes | Jurisdiction / difficulty |
|---|---|---|
| **Rail crossing** | `rail` | railroad permit + bore. Hardest. Pain is mostly from the *private* railroad owner. |
| **Navigable waterway crossing** | rivers (NHD/OSM) | USACE (and Coast Guard). |
| **Interstate / limited-access crossing** | `motorway` + `trunk` | state DOT + FHWA. |
| **Arterial crossing** | `secondary` | easiest — surface major-street crossing. |

**Minor streets are *not* barriers.** `tertiary`, `residential`, `service`, `unclassified` and below incur **no crossing cost** — crossing a side street is a trivial open-cut, not a permit event. Counting them would flood `arterial_crossings` with noise and let trivial crossings dominate the cost model.

So the jurisdiction is **federal / state / private depending on the feature**, not uniformly "federal." This nuance matters for credibility.

### 5.4 What V1 cannot know

Construction method (bore-under vs. aerial-over) is a build-stage decision, not something a buffer screen can infer. That is correctly a V2/offline concern. **V1 detects and tiers crossings; V2's offline routing assigns crossing method and real cost.**

**V2 cost model (documented, not built).** The richer model is a **graph-traversal cost**: the network is a graph of nodes and edges, a crossing is a node you pass *through* that adds cost, and each edge and node carries its own traversal cost, accumulated by offline routing over the road graph. This is the V2 routed cost engine — it requires path-finding (intermediate nodes to pass through), which V1 deliberately does **not** do (the V1 connector is a single straight segment). Pricing per-*instance* crossing cost at build time is explicitly **rejected for V1**, because it would move a cost *opinion* into the *facts* layer (§2). In V1, the build step bakes the **count and type** of crossings (facts); the browser prices **per-type cost** (opinion, §6.3).

---

## 6. The cost screen (interactive toggles)

The user tunes assumptions with sliders and the map responds live. This is the demo's centerpiece interaction.

### 6.1 It is a screen, not a calculator

**Critical framing:** this produces a *screening cost estimate with tunable assumptions*, not an authoritative build cost. Straight-line (even circuity-adjusted) distance × cost-per-foot is a **lower bound** — if a building blows the budget under the most optimistic geometry, it's definitely out; survivors graduate to V2 routing for real cost. (This is why the baked distance is the *pure* straight-line minimum — see §6.2 / §9.)

Exposing assumptions as sliders is *more* honest than a black-box number, not less. It signals that cost is assumption-dependent.

### 6.2 The circuity slider — turning the limitation into a feature

A **circuity multiplier** (straight-line × road-detour factor) is the honest cheap proxy for routing. US metro road circuity runs ~1.2–1.3, so the factor is empirically grounded, not a fudge. Exposing it as a slider (1.0 = pure straight line → 1.3 = typical detour) makes the **buffer-vs-routing gap interactive and visible** — crank it and watch the reachable set shrink. This teaches the V1→V2 distinction in the UI instead of hiding it.

**Circuity is applied live in the browser, not baked into the data.** `connector_distance_ft` is stored as the **pure straight-line** distance (circuity = 1.0, the geometric minimum / honest lower bound — a geographic *fact*). Circuity is a cost *opinion*, so it lives on the slider and enters the closing query as `… * :circuity …` (§9). Baking it would both break the live slider and put an opinion in the facts layer.

**Provenance of the circuity number (neither OSM nor Overture stores it).** Circuity is never a tracked attribute — it is always *derived* from a routable graph (e.g. `osmnx.stats.circuity_avg()` compares network path-distance to straight-line). V1 does **not** compute per-building circuity, because that needs the V2 road graph + routing — which would defeat the proxy's purpose (once you have real routed distance you don't need a circuity factor). The V1 slider default (~1.25) is **literature-grounded** (US metro circuity ~1.2–1.3). *Optional Phase-0 polish:* run `osmnx.stats.circuity_avg()` on Pittsburgh's road network **once, offline**, to pick a Pittsburgh-calibrated default — that is a single scalar network statistic, **not** per-building routing, so it does not cross the no-routing guardrail.

### 6.3 Tunable parameters (all browser-side)

- cost per foot (e.g. $30/ft)
- bore/new-crossing cost per barrier type (e.g. rail $20k)
- discounted crossing cost where a bridge is available (e.g. $5k)
- circuity multiplier
- budget threshold

### 6.4 Display

- **Gradient, not binary** — color buildings by estimated cost as a continuous surface; budget is a draggable threshold. Shows the whole cost landscape, not just lit/unlit.
- **Itemized hover** — distance cost + each crossing cost broken out, so the model is legible and provably not a magic number.
- **No silent vanishing; far buildings stay on the map.** Every building is kept (no build-time drops), so the "cut off across the river" story stays visible and there are no misleading blank areas. The baked `in_range` flag (§9) distinguishes "implausibly far" buildings (beyond `D_max`) from merely over-budget ones, letting the UI gray them distinctly and clamp the gradient ramp so a few extreme-distance outliers don't compress the color scale.

---

## 7. Pittsburgh & the bridge mechanic

**Pittsburgh is the chosen metro** because its geography and the model tell the same story:

- **Three rivers** (Allegheny, Monongahela, Ohio) genuinely cut the metro into pieces — buildings are *actually* cut off from the network unless a path crosses water. Reachable/unreachable is legible at a glance.
- **"City of Bridges"** — more bridges than anywhere of its size. The bridge-as-discounted-crossing mechanic becomes the centerpiece, not a footnote: "this building is unreachable across the Mon unless you route through a bridge crossing at $5k instead of a fresh river bore."
- Dense industrial **rail** legacy (corridors *and* crossings), **interstates** (376/279/79) as barriers.
- Mid-sized — bounded enough to keep V1 data small (unlike Chicago/NYC where the barrier story drowns in density).

### Scope boundary — the concrete clip

**V1 clips all layers to the City of Pittsburgh municipal boundary** — **Census TIGER PLACE, FIPS 4261000** (~58 sq mi). This is a real, named, reproducible boundary from a source we already ship (§8), and it contains the entire three-rivers narrative: the confluence plus genuine frontage *and far bank* on all three rivers (North Side/North Shore across the Allegheny, South Side across the Mon, West End across the Ohio), so reachable/unreachable and the bridge mechanic are fully legible. (Not the Census Urban Area — that's ~1,000+ sq mi of MSA-scale sprawl. Not a bespoke polygon — TIGER is reproducible.)

- Building count (~120–160k) is an **estimate** — measured in Phase 0.
- **Fallback:** if the build proves too heavy, tighten the *clip parameter* to a confluence sub-area — a one-line change, not a redesign.
- The clip extent is **independent of the initial map view** — the demo can still open zoomed to the confluence regardless of clip size.

### The bridge mechanic — honest V1 version

A straight-line connector won't conveniently pass *through* a bridge — true routing-via-bridge needs V2. So V1 uses a **proximity heuristic**: when a connector crosses a river, the build step checks whether a bridge sits near that crossing point and sets `bridge_available`. The browser toggle then reads: *if* a bridge is available and "use bridges" is enabled, apply the discounted crossing instead of the bore.

This is a real, labeled screening signal — "a cheaper crossing exists nearby" — **not** a claim that we routed through it. V2 upgrades `bridge_available` into an actual routed-via-bridge path and distance.

---

## 8. Data sources

| Layer | Role | Source | Honesty label |
|---|---|---|---|
| Buildings | candidate prospects | Overture buildings | real geometry |
| Places / POIs | opportunity signal | Overture places (whitelisted — see `docs/POI_CATEGORIES.md`) | real |
| Addresses (optional) | labeling/hover | Overture addresses | real |
| Network | fiber corridor proxy | OSM roads, **`primary` class** | **modeled corridor from major-arterial ROW** |
| Waterways | barrier | USGS NHD (or OSM) | real |
| Railways | barrier (and corridor in principle) | OSM railways / FRA NTAD | real |
| Interstates / limited-access | barrier | OSM **`motorway` + `trunk`** | real |
| Arterials | barrier | OSM **`secondary`** | real |
| Bridges | discounted crossing | OSM `bridge=yes` | real geometry; **"potential lower-cost crossing"** |
| Clip boundary | scope to City of Pittsburgh | Census TIGER PLACE (FIPS 4261000) | real |
| Basemap | display | PMTiles (static) | — |
| Road graph | routing | OSMnx from OSM | **V2 only** |

**Split:** Overture for buildings/places/addresses (deduplicated, clean); OSM for the linear network + barriers + bridges (need the tags and, later, routable topology).

### Data-honesty notes

- The only genuinely synthetic concept is **"existing conduit"** — there is no public dataset for real conduit. Do **not** invent one. Bridges serve as the honest proxy for lower-cost crossings (a bridge is a real structure that *might* carry fiber), labeled "potential lower-cost crossing," never "confirmed conduit."
- Overall data statement: **real public-domain base geometry + synthetic/proxy network attributes.** Never imply real fiber or company data.

---

## 9. Schema

All `geometry` columns are stored in **EPSG:4326** (lon/lat, for MapLibre); all `_ft` columns are **US survey feet**, computed in EPSG:2272 (§2).

### `buildings.parquet` — one row per candidate building

```
# Identity & geometry
building_id            string    # Overture GERS ID (stable across rebuilds)
geometry               geometry  # footprint polygon (EPSG:4326)
centroid_lon           double    # precomputed, for cheap distance/label work
centroid_lat           double
building_class         string    # Overture: commercial/residential/etc

# The distance fact (precomputed — the V1/V2 swap point)
connector_distance_ft  double    # building centroid → nearest point on nearest corridor
                                 # V1: PURE straight-line (circuity applied LIVE in browser)
                                 # V2: routed over road graph. SAME column. NEVER null.
nearest_network_id     string    # which corridor segment it connects to
connector_geometry     geometry  # connector line (EPSG:4326).
                                 # V1: 2-point straight line. V2: routed polyline. SAME column.
                                 # Rendered selectively (hover + reachable set), not all at once.

# The barrier model (counts → pure arithmetic in browser; COALESCE to 0, never null)
water_crossings        int
rail_crossings         int
interstate_crossings   int       # motorway + trunk
arterial_crossings     int       # secondary

# Reachability
in_range               bool      # connector_distance_ft <= D_max (plausible service distance)
                                 # keeps far buildings on the map but distinctly grayable

# The bridge mechanic (Pittsburgh centerpiece)
bridge_available       bool      # is a bridge near the water-crossing point?
nearest_bridge_ft      double    # distance to it (null if none — a meaningful null)

# The opportunity signal
poi_count              int       # whitelisted POIs assigned to this building (tenant density)
```

**Resolved (was an open decision):** `connector_geometry` **is included** in V1. The V1 connector is a 2-point straight line (centroid → nearest network point) — tiny next to the footprint polygon, so the "doubles file size" worry doesn't apply at City scope. It makes the screen legible (shows *where* the connector hits the network and *what* it crosses) and keeps the V1/V2 column contract intact (V2 fills the same column with a routed polyline). Render it **selectively** (hovered building + reachable set), never all ~150k lines at once — a draw-time choice, not a storage one.

**`poi_count` definition:** each whitelisted POI (see category whitelist below) is assigned to its **single nearest building footprint within a max distance** (Phase-0-tuned, ~100–150 ft), and `poi_count` is the number assigned to that building. Nearest-building assignment is robust to Overture geocoding slop **and** guarantees one-POI-one-building (no double-counting, unlike a radius buffer). The category whitelist (which Overture place groups count as connectivity buyers) lives in **`docs/POI_CATEGORIES.md`** as the tunable source of truth.

**`in_range` / no-network handling:** `connector_distance_ft` is **never null** (there is always a nearest segment in the clip), and crossing counts `COALESCE` to 0, so `est_cost` is always a real number and no building can silently vanish from the budget filter via NULL arithmetic. Every building is kept; `in_range` (= distance ≤ `D_max`, a documented plausible service distance set in Phase 0) lets the UI distinguish "implausibly far" from "over budget" without dropping rows.

### Companion layers (separate files — display + build step, not per-building)

- `network.parquet` — modeled corridor lines (`primary`), classed by road type
- `barriers_water.parquet` / `barriers_rail.parquet` / `barriers_interstate.parquet` (motorway+trunk) / `barriers_arterial.parquet` (secondary) — barrier centerlines
- `bridges.parquet` — bridge segments, with which river each crosses
- basemap as PMTiles

### The closing query (all the browser does, live on slider change)

```sql
SELECT building_id,
  connector_distance_ft * :circuity * :cost_per_ft
  + water_crossings        * (CASE WHEN bridge_available AND :use_bridges
                                   THEN :bridge_cost ELSE :bore_cost END)
  + rail_crossings         * :rail_cost
  + interstate_crossings   * :interstate_cost
  + arterial_crossings     * :arterial_cost
  AS est_cost
FROM buildings
WHERE est_cost <= :budget
```

Every `:param` is a slider (including `:circuity`); every column is a precomputed fact. No routing, no road graph in the browser — arithmetic over baked facts. That's the whole contract in one query.

---

## 10. Hard guardrails

1. **Public data only.** Built entirely from public open data (§8) and general domain knowledge — no proprietary or private third-party code or data of any kind.
2. **Data honesty.** Real public-domain base geometry + synthetic/proxy network attributes. Never imply real fiber or company data.
3. **No browser routing, ever.** Route offline at build time; ship answers.
4. **V1 stays a screen.** Straight-line + circuity + explicit assumptions. No routing rabbit hole until V1 is live.
5. **Label models as models.** "Modeled corridor," "potential lower-cost crossing," "screening estimate" — never "fiber," "conduit," or "build cost."

---

## 11. Stack

- **Front end:** MapLibre GL JS, React/TypeScript
- **Client-side data/SQL:** DuckDB-WASM over static GeoParquet
- **Basemap:** PMTiles (static)
- **Build step (offline):** Python — Overture/OSM ingest, reprojection to EPSG:2272, spatial joins, crossing detection; OSMnx/OSRM for V2 routing
- **Hosting:** GitHub Pages (no backend)

---

## 12. Repo & licensing

**Repo name:** `nearnet-pgh` (under `the-snowmen`). Legible, accurate to the V1 Pittsburgh scope, and harmless when skimmed in a list. Avoided `nearnet-pit` — the airport code reads as the English word "pit" to anyone who doesn't know PIT, which carries the wrong connotation, and the airport is west of the three-rivers core V1 actually targets. Deploys to `the-snowmen.github.io/nearnet-pgh/`.

**Code license:** **MIT.** Maximally permissive — the goal is for people to read the code and think well of it, not to control downstream use. Consistent with the other repos (GIS-Conflict-Dashboard, plugin suite) and with GeoLibre.

**Dependency licenses (all permissive, MIT-compatible — no conflict):**
- DuckDB-WASM — MIT
- MapLibre GL JS — BSD-3-Clause
- PMTiles — BSD-3-Clause
- Python build stack (OSMnx, etc.) — permissive

### Data licensing — separate from the code license

MIT covers the **code**. The **data** baked into the GeoParquet carries its own terms. This must be acknowledged in the README (or a standalone `DATA.md`), both because it's an obligation and because showing exactly where every layer came from reinforces the data-honesty story.

| Source | Layer | Data license | Obligation |
|---|---|---|---|
| OpenStreetMap | network, barriers, bridges | **ODbL** | attribution + share-alike *on the data* |
| Overture Maps | buildings, places, addresses | open (CDLA-permissive / ODbL components) | attribution |
| USGS NHD | waterways | public domain | attribution courtesy |
| Census TIGER | clip boundary | public domain | attribution courtesy |

**The one to watch is OSM/ODbL:** it has attribution and share-alike obligations *on the data itself*. This does **not** affect the MIT code license — the two are independent. Action: add an attribution line crediting OSM, Overture, USGS NHD, and Census TIGER. Since the project ships precomputed derived data, note the ODbL share-alike consideration for the baked GeoParquet if redistribution ever matters; for a portfolio demo, clear attribution is the practical requirement.

---

## 13. Open questions

- Is `near-net` the **lead** GIS portfolio piece (eclipsing the conflict dashboard) or a side build? This determines prioritization. *(Non-blocking — does not affect the build.)*
- ~~Include `connector_geometry` in V1?~~ **Resolved (§9): yes, as the 2-point straight line.**

### Deferred to Phase 0 measurement (cannot be honestly guessed pre-data)

- ~~**`D_max`** — the plausible service distance for `in_range`.~~ **Resolved: 2,000 ft** (full-city distribution → 57.5% in-range; grays the clearly-far ~42% without graying the median building at p50 1,674 ft).
- ~~**POI max-snap distance**.~~ **Resolved: 150 ft** (full-city snap rate 99.4% — comfortably sufficient).
- ~~**Final corridor density** — `primary`-only vs promote `secondary` (§4 escape hatch).~~ **Resolved: keep `primary`-only** — the experiment showed promoting `secondary` over-densifies (86% in-range, arterial-crossing tier collapses, barrier signal drops ~⅔). See the §4 "Measured outcome" table.
- **Exact Overture category-group identifier strings** — reconciled against the published `overture_categories.csv`; the *policy* is locked in `docs/POI_CATEGORIES.md`.

### V1.5 aggregate opportunity-index cell layer (§14)

- Is the index the **lead V1.5 feature** or a stretch goal after V1 ships? *(Prioritization only.)*
- Single fixed H3 resolution, or a user-selectable **r8 ⇄ r9** toggle (the MAUP-demonstration lever)?
- **Does the `h3` community extension load in DuckDB-WASM?** If yes → live in-browser drill-down (no V1-file touch). If no → restrict `h3` to the Python build and either bake a `cell_id` membership column onto `buildings.parquet` (breaks the byte-frozen / removability intent — needs explicit sign-off) or accept a coarser drill-down.
- Demand headline as **mass** (`poi_count_sum`) vs **density** (per-building, the default that avoids cell-mass dominance)?
- Normalize **city-wide** (default) vs sub-regionally (sub-regional risks importing the hierarchy-language trap — deferred).

#### Deferred to Phase 0.5 measurement (`measure.py`, cannot be honestly guessed pre-data)

- **H3 resolution** — the most consequential choice (governs MAUP severity); confirm r8 default + r9 toggle against realized cell counts and the per-cell building distribution.
- **Normalization method** — long-tailed distance/POI favor percentile/robust; min-max risks one extreme cell flattening the ramp.
- **Default weights + gap-flag z-cuts** (`w_*`, `g_*`).
- **`score_threshold`** — set from the score distribution (e.g. top-quintile), a documented percentile, not an arbitrary line.
- **`min_buildings`** thin-cell floor; **demand mass vs density** default.

---

## 14. Aggregate opportunity-index cell layer (V1.5)

*Status: **built + shipped (2026-07-01).** Live as the "Cell overview" altitude; Phase-0.5 tunables locked (see Changelog). The one rule for this section, same as the rest of the doc: **bake facts, not opinions; label models as models.***

### 14.1 What this is

A **second altitude** on top of the per-building screen. The building screen answers *"is **this** building reachable within budget?"*; the index answers *"**where** do I look first?"* It tessellates the City into H3 hexagons, aggregates the already-baked per-building facts into a per-cell feature vector, normalizes the columns, and applies tunable weights to produce a per-cell **opportunity index** — surfacing **underserved-but-valuable** cells (high modeled demand + far / barriered) as a screening overview that drills back down into the V1 building screen.

**Honesty label (mandatory, UI + doc):**
> *"A transparent, tunable opportunity **index** — a normalized weighted score over the modeled per-building facts, used for gap analysis (high demand + low reachability + low barriers). It is a screening **index**, not a cost, and not a central-place model."*

### 14.2 Why V1.5, not V1

Same discipline as §3's "V2 work wearing a V1 hat — resist it." The index is a *downstream view*; building it before the building screen exists would starve V1. **Ship-order gate:** V1.5 starts only after `data/buildings.parquet` carries all §9 columns and the Phase-0 numbers are locked. **Additive-only / removability contract:** `cells_r{8,9}.parquet` and `cell_stats.parquet` are **new files**, and the cell map layer is additive — deleting them leaves a fully working V1. It **adds no column to `buildings.parquet`** (drill-down recomputes the cell live in the browser, §14.7).

### 14.3 The mechanic we borrow

The "Matrix of Functions" / central-place *mechanic*: a **units × functions matrix → normalize → weighted score → sort → gap analysis**. This is just standard multi-criteria decision analysis (MCDA). Note that V1 is **already** this shape one altitude down — `buildings.parquet` is a building × feature matrix and the §9 closing query is `matrix · weight-vector → est_cost`. V1.5 changes the *row unit* (building → hex) and adds the normalize + sort + gap steps. *(Christaller/central-place is the conceptual provenance — recorded here, never in UI copy.)*

### 14.4 The theory we do **not** borrow

We reject Christaller's **central-place theory** (settlement service hierarchy). H3 hexagons here are a tessellation convenience, **not** Christaller's emergent market areas; conflating them is a category error and a credibility risk to a GIS-literate reviewer. **Banned vocabulary** anywhere a user can see it: "central place," "matrix of functions," "settlement hierarchy," "threshold and range," "order of goods," "emergent market hexagons," and **"the hierarchy emerges naturally."**

### 14.5 The cell feature vector — `cells_r{8,9}.parquet`

One row per H3 cell containing ≥1 building centroid; one **file per resolution** (the browser fetches only the active one). All `geometry` in EPSG:4326. **No `cost`/`$`/`build`/`price`/`ROI` naming on any derived score** (guardrail #5).

```
# Identity & geometry (FACTS)
cell_id              string    # H3 hex string; join/drill key; MapLibre promoteId
h3_res               int       # 8 | 9 (self-describing)
geometry             geometry  # hex boundary (4326), CLIPPED to TIGER PLACE for edge hexes
centroid_lon/lat     double    # hex center — label / fly-to anchor
# Mass (FACTS — sums & counts)
building_count       int       # COUNT(*) buildings whose centroid falls in the cell
in_range_count       int       # COUNT(*) WHERE in_range
poi_count_sum        int       # SUM(poi_count) — demand mass
# Reachability (FACTS — central tendency; LOW = cheap to reach)
conn_dist_median_ft  double    # MEDIAN(connector_distance_ft) — PRIMARY reachability stat (outlier-robust)
conn_dist_p25_ft     double    # 25th pct — the "easy frontier"
conn_dist_min_ft     double    # MIN — a toehold already near the corridor?
conn_dist_mean_ft    double    # transparency only; NOT the scoring axis
# Barrier load (FACTS)
water/rail/interstate/arterial_crossings_sum  int   # per-type sums — TRANSPARENCY only
total_crossings_mean double    # mean crossings PER BUILDING — the barrier AXIS (mass-independent)
bridge_available_count int     # COUNT(*) WHERE bridge_available — mitigation availability
# Edge handling (FACT)
clipped_area_frac    double    # ST_Area(clipped)/ST_Area(full) in EPSG:2272; 1.0 = interior
```

**Aggregate choices (load-bearing):** `poi_count → SUM` (demand is additive mass); `connector_distance_ft → MEDIAN` primary (reachability is a *central-tendency* question — a sum would conflate mass with cost; median is outlier-robust for Pittsburgh's far-bank geometry); **barrier axis = `total_crossings_mean` (per-building), not a sum** — a summed count is itself a mass feature and would mark dense cells "barriered" for the wrong reason. **`nearest_bridge_ft` is deliberately NOT aggregated** (it is a meaningful null per §9 — a naïve `AVG()` would poison it; the bridge signal rides on `bridge_available_count`). The build step is a **pure `GROUP BY`** over `buildings.parquet` — **SUM/MEAN/percentile/COUNT only, no inter-cell adjacency / path / flow graph** (guardrail #3 — aggregation is where routing is tempting to smuggle back in).

### 14.6 Normalization (why raw columns can't be summed)

The features are **not** commensurable: `poi_count` (~0–50), `connector_distance_ft` (~0–5000), crossings (0–4). A raw weighted sum lets feet dominate. So each scorable feature is standardized (z-score, with a min-max alternate) using **baked distribution stats** in `cell_stats.parquet` (one row per scorable feature per resolution: `mean/std/min/max` + percentiles `p05/p25/p50/p75/p95/iqr`). The stats are **facts** (properties of the distribution) → baked; the **normalization-method choice and the weights are opinions** → browser. Bake only summary stats (not pre-normalized columns), mirroring V1. Three honesty consequences, stated together: the index is **unitless**; the **weights are opinions**; the **ranking shifts** with the weights *and* with the normalization method.

### 14.7 The scoring formula (the cell closing query — §9's analog)

`Σ(feature × weight)` with a threshold, wrapped in a standardization layer. **Sign convention:** demand & size are "more is better"; reachability cost & barrier load are "less is better" → standardize all to z-scores, then **negate the cost-like features** so every weight slider stays **≥ 0** (legible). `COALESCE(z, 0)` makes a zero-variance feature contribute nothing (no NULL index). Demand defaults to **density** (`poi_count_sum / building_count`) so the index isn't dominated by cell mass / collinear with `building_count`.

```sql
-- OPINIONS (sliders): :w_poi :w_dist :w_barrier :w_bldg (>=0); :norm; :min_buildings;
--                     :score_threshold; gap cuts :g_demand :g_cost :g_barrier
-- FACTS (bound from cell_stats.parquet): :*_mean / :*_std (or min/max for minmax)
WITH base AS (
  SELECT *, CAST(poi_count_sum AS double)/NULLIF(building_count,0) AS poi_density
  FROM cells WHERE building_count >= :min_buildings        -- thin-cell floor (small-n defence)
), z AS (
  SELECT cell_id, geometry, centroid_lon, centroid_lat,
         building_count, poi_count_sum, poi_density, conn_dist_median_ft, total_crossings_mean,
         COALESCE((poi_density          - :poi_mean)     / NULLIF(:poi_std,0),     0) AS z_poi,
         COALESCE((conn_dist_median_ft  - :dist_mean)    / NULLIF(:dist_std,0),    0) AS z_dist,
         COALESCE((total_crossings_mean - :barrier_mean) / NULLIF(:barrier_std,0), 0) AS z_barrier,
         COALESCE((building_count       - :bldg_mean)    / NULLIF(:bldg_std,0),    0) AS z_bldg
  FROM base
)
SELECT cell_id, geometry, centroid_lon, centroid_lat,
       building_count, poi_count_sum, conn_dist_median_ft, total_crossings_mean,
       (:w_poi * z_poi)      AS c_poi,        -- per-term contributions kept SEPARATE (hover breakout)
       (:w_dist * -z_dist)   AS c_dist,       -- negated: closer -> higher score
       (:w_barrier*-z_barrier) AS c_barrier,  -- negated: fewer barriers -> higher score
       (:w_bldg * z_bldg)    AS c_bldg,
       (:w_poi*z_poi)+(:w_dist*-z_dist)+(:w_barrier*-z_barrier)+(:w_bldg*z_bldg) AS opportunity_index,
       (z_poi >= :g_demand AND (z_dist >= :g_cost OR z_barrier >= :g_barrier))    AS is_gap
FROM z
ORDER BY opportunity_index DESC;    -- the sort IS the prioritization step
```

`:score_threshold` is applied over the result (the map "hot set") — twin of V1's `WHERE est_cost <= :budget`, but operator **flipped to Index ≥ X** (the flip + unitless value reinforces "a different kind of number"). The `cell_stats` are computed over the **same scored cell set** the query runs on (`building_count > 0`, and `≥ :min_buildings` if that filter ships), per resolution, or z-scores won't match.

### 14.8 MAUP as a documented caveat

Standing in-product footnote: *"Scores depend on hexagon size & placement (MAUP). H3 cells are **near-uniform area** — they vary modestly (not perfectly equal-area) but far more than a graticule — with no orientation bias; cell **size (resolution) is a modeling choice**."* What H3 fixes: the area-bias and origin/orientation axes (global fixed indexing). What it does **not** fix: resolution choice — so we **make it interactive** via an r8 ⇄ r9 toggle (same pedagogy as the circuity slider — the user watches the hot set reorganize rather than trusting one arbitrary grid). Resolution is justified on **cells-per-area legibility and per-cell sample size**, *not* on any "edge ≈ service distance" claim (`D_max` is a Phase-0 tunable, and a hex edge is not comparable to a point-to-corridor radius). Indicative: **r8 ≈ 260 cells** (default, neighborhood grain), **r9 ≈ 1,575** (drill toggle); both trivial for DuckDB-WASM + MapLibre.

### 14.9 Fact / opinion split for the cell layer

Mirrors §2 one altitude up (rows appended to the §2 table). **Facts (baked offline):** the per-cell aggregates and the `cell_stats` distribution stats. **Opinions (browser sliders):** the feature weights, the normalization-method choice, the score & gap thresholds, the `min_buildings` floor, and the mass↔density toggle. Same one-liner: *the build step bakes per-cell aggregates; the browser normalizes and multiplies by the weight sliders — arithmetic over baked facts, no routing.*

### 14.10 The V1/V2 contract property

`cells_r{8,9}.parquet` is a **pure function of `buildings.parquet`** (see §3 inheritance property). The cell view upgrades to V2 routed distances on a plain rebuild — a data swap at both altitudes, and a guarantee that a derived view cannot drift from V1.

### 14.11 Display & interaction (honest by construction)

- **Choropleth via MapLibre `feature-state`** — hex geometry loads once (`promoteId: "cell_id"`); each scoring result sets `{score, hot, gap}` per cell; the paint expression reads `["feature-state","score"]`. Sequential, colorblind-safe ramp, **a different color family from the V1 cost gradient** so the two altitudes never read as the same scale; empty/excluded hexes are neutral gray, **never "score 0"** (0 is a meaningful mid-value in z-space).
- **Legend:** "Opportunity index (modeled screening score) — unitless weighted index, **NOT dollars**." Draggable **Index ≥ X** threshold with "N of M cells above threshold."
- **Two altitudes, one model:** segmented toggle (default = Buildings/V1 unchanged; Cell overview is the opt-in lens). **Drill-down:** click a hex → fly to it → V1 building screen filtered to that cell, the filter computed **live in the browser** via the h3 extension on building centroids (no baked membership column). The drill-down is the **honesty mechanism** — every score decomposes back to per-building modeled facts.
- **Ranked opportunity table** (the borrowed mechanic, done honestly): one row per scored hex, raw feature values + Index, click-to-sort, gap rows badged "high modeled demand but high modeled reachability cost / barriers — screening candidates, not confirmed prospects." Wired to the same query. **UI strings never invoke the banned vocabulary (§14.4).**
- **Hover breakout** (twin of §6.4): each term reconstructed from the separate `c_*` columns, so the index is legible, not a magic number.

**Double-derivation honesty (guardrail #2):** the index inherits **every** V1 caveat (modeled corridor, straight-line distance, proxy bridge) and adds aggregation + weighting on top — **it is never more authoritative than its inputs**, and a smooth choropleth must not be allowed to *look* more authoritative than the noisy dots it came from. `poi_count_sum` is labeled "modeled tenant-density signal from whitelisted Overture places" — never "customers"/"revenue".

### 14.12 Phase-0.5 tunables & open questions

See §13 → "V1.5 aggregate opportunity-index cell layer" for the open questions and the Phase-0.5 measured tunables (H3 resolution, normalization method, default weights/gap-cuts, score threshold, thin-cell floor, mass-vs-density). `measure.py` reports, per candidate resolution: realized cell count, building-per-cell distribution, and the fraction of cells below the thin-cell floor.

---

## Changelog

- **2026-07-01** — **V1.5 cell layer built + shipped.** The §14 opportunity-index cell layer is live as the "Cell overview" altitude (H3 r8 default / r9 toggle, purple choropleth via `feature-state`, ranked table, drill-down back into the building screen). Build (`build/cells.py`) is a pure `GROUP BY` over `buildings.parquet` → `cells_r{8,9}.parquet` + `cell_stats.parquet` (h3-py + geopandas; hex geometry clipped to the TIGER boundary). Drill-down membership is computed in-browser with the `h3-js` port over the baked centroids (resolves the §14 open question — no DuckDB-WASM `h3` needed, no baked membership column). **Phase-0.5 tunables locked** from `data/phase05_report.md`: `score_threshold` = top-quintile (p80 ≈ 0.32 r8 / 0.34 r9 → **0.30** default), weights **0.40 / 0.30 / 0.20 / 0.10**, `min_buildings` **5**. Additive & removable (no column added to `buildings.parquet`; deleting the cell files leaves V1 fully working). Realized cells: **r8 = 262, r9 = 1,443**.
- **2026-06-30** — **Phase-0 tunables locked from the full-city run + V1 perf.** Measured the §4 escape hatch empirically (115,914 buildings): promoting `secondary` to corridor over-densifies (86% in-range, arterial-crossing tier collapses, water/rail/interstate signal drops ~⅔) → **kept `primary`-only**. Locked **`D_max` = 2,000 ft** (57.5% in-range) and confirmed **POI snap 150 ft** (99.4% snap rate). Resolved the §13 Phase-0 deferrals; added the §4 "Measured outcome" table. Web V1 perf: cost recolor moved to a debounced MapLibre paint expression with a hover-only building outline (kills slider-drag jank); the ~0.5 s recolor floor on the untiled 116k-feature GeoJSON is the documented case for the planned Tier-2 vector-tile (PMTiles) swap.
- **2026-06-29** — **V1.5 designed (gated).** Added §14: aggregate opportunity-index cell layer — a second altitude that aggregates `buildings.parquet` into H3 hexes (r8 default, r9 MAUP toggle), normalizes (z/min-max over baked `cell_stats`), and weights into a unitless **opportunity index** with gap-analysis flagging. Borrows the matrix→normalize→weight→sort→gap *mechanic*, rejects central-place *theory* (banned UI vocabulary). Index ≠ cost (guardrail #5); pure `GROUP BY`, no browser routing (#3); additive & removable, no column added to `buildings.parquet` (#4); inherits the V1→V2 distance upgrade for free. Extended the §2 fact/opinion table and §3 contract; added §13 open questions + Phase-0.5 tunables; added `H3_RESOLUTIONS`/cell config + `cells_r{8,9}`/`cell_stats` paths to `build/config.py`. Code (`build/cells.py`, browser layer) is Phase B, gated on V1 being live.
- **2026-06-29** — **Design detail lock-down.** Resolved nine load-bearing details before any code: (1) build CRS = EPSG:2272 (PA State Plane South, US survey feet) — compute in 2272/feet, geometry back to 4326; (2) nearest network point = perpendicular projection onto nearest segment (origin = centroid); (3) crossing detection = `ST_Crosses` gate + point-count over centerline barriers (replaces loose `ST_Intersects`), with per-type browser pricing and the graph-traversal cost model logged as V2; (4) scope boundary = City of Pittsburgh, TIGER PLACE FIPS 4261000 (fallback: tighten to confluence); (5) `poi_count` = nearest-building assignment + Overture category-group whitelist (`docs/POI_CATEGORIES.md`); (6) no-network case = keep all buildings + bake `in_range` bool, close the NULL-vanishing trap; (7) circuity = live browser slider over raw straight-line (`connector_distance_ft` stays pure straight-line; closing query gains `* :circuity`); (8) `connector_geometry` included in V1 as the 2-point line; (9) road roles = clean one-role-per-class split — corridor = `primary` only (sparse middle-mile, tunable), `motorway`+`trunk` = interstate/limited-access barrier, `secondary` = arterial barrier, minor streets free, interstates are `motorway` (not corridors). Added `in_range` to the schema and `:circuity` to the closing query.
- **2026-06-29** — Repo named `nearnet-pgh`; MIT code license locked; data-licensing table added (OSM/ODbL flagged as the share-alike one to watch, independent of MIT code license).
- **2026-06-29** — Initial design. Network redefined as highways-as-modeled-corridors; barrier model with corridor/barrier duality and tiered crossings; interactive cost screen with circuity slider; Pittsburgh chosen for the bridge mechanic; schema and data sources locked for V1.
