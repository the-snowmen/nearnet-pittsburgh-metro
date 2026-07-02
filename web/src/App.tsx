import { useCallback, useEffect, useRef, useState } from "react";
import MapView, { type Altitude, type MapViewHandle } from "./MapView";
import Controls from "./Controls";
import CellControls from "./CellControls";
import CellTable from "./CellTable";
import Info from "./Info";
import OnboardingCue from "./OnboardingCue";
import Dossier from "./Dossier";
import { useSheetDrag } from "./useSheetDrag";
import { DEFAULT_SLIDERS, fmtUSD, type Sliders, type BuildingFacts, type POI } from "./cost";
import {
  DEFAULT_CELL_SLIDERS,
  fmtIndex,
  type CellSliders,
  type CellRes,
  type CellScore,
} from "./cell";
import {
  initDuck,
  loadFacts,
  costStats,
  initConnectors,
  initPois,
  initFootprints,
  initAddresses,
  getBuildingPois,
  getBuildingAddress,
  initCells,
  loadCellStats,
  scoreCells,
  cellScoreStats,
  setCellResolution,
  buildingsInCell,
  type CostStats,
  type CellScoreStats,
} from "./duck";

const url = (p: string) => new URL(p, document.baseURI).href;
const PARQUET_URL = url("data/buildings.parquet");
const CELL_URLS: Record<CellRes, string> = {
  8: url("data/cells_r8.parquet"),
  9: url("data/cells_r9.parquet"),
};
const CELL_STATS_URL = url("data/cell_stats.parquet");
const CONNECTORS_URL = url("data/connectors.parquet");
const POIS_URL = url("data/pois.parquet");
const FOOTPRINTS_URL = url("data/footprints.parquet");
const ADDRESSES_URL = url("data/building_address.parquet");

export default function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [sliders, setSliders] = useState<Sliders>(DEFAULT_SLIDERS);
  const [stats, setStats] = useState<CostStats | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null); // V2.3 pinned building
  const [dossierPois, setDossierPois] = useState<POI[] | null>(null); // its child POIs (null = loading)
  const [dossierAddress, setDossierAddress] = useState<string | null>(null); // nearest OSM address
  // Desktop: the panel is always open (its toggle is display:none). Mobile (<720px)
  // is a bottom sheet (V2.4) — see useSheetDrag; panelOpen only matters on desktop.
  const [panelOpen, setPanelOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches,
  );
  const factsRef = useRef<Map<string, BuildingFacts> | null>(null);
  const debounceRef = useRef<number | undefined>(undefined);
  const panelRef = useRef<HTMLElement>(null);
  const mapApiRef = useRef<MapViewHandle>(null); // V2.4 — dossier ⤢ calls frameSelection()

  // V2.4 — mobile bottom-sheet detents (peek / half / full), drag + snap.
  const sheet = useSheetDrag(isMobile);

  // Track the mobile breakpoint so the sheet vs desktop-panel logic stays in sync.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 720px)");
    const on = () => setIsMobile(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // On mobile, selecting a building raises the sheet so the dossier is visible
  // (the Apple/Google-Maps "tap a place → sheet rises" behavior).
  const setDetent = sheet.setDetent;
  useEffect(() => {
    if (isMobile && selectedId) setDetent("half");
  }, [selectedId, isMobile, setDetent]);

  // Mark the closed desktop panel `inert` (never fires — desktop stays open); the
  // mobile sheet is reachable at every detent, so it must NOT be inert.
  useEffect(() => {
    panelRef.current?.toggleAttribute("inert", !isMobile && !panelOpen);
  }, [panelOpen, isMobile]);

  // --- V1.5 cell-layer state (all inert until the files load) ---------------
  const [cellsAvailable, setCellsAvailable] = useState(false);
  const [altitude, setAltitude] = useState<Altitude>("buildings");
  const [cellRes, setCellRes] = useState<CellRes>(8);
  const [cellSliders, setCellSliders] = useState<CellSliders>(DEFAULT_CELL_SLIDERS);
  const [cellScores, setCellScores] = useState<CellScore[] | null>(null);
  const [cellStats, setCellStats] = useState<CellScoreStats | null>(null);
  const [drillCellId, setDrillCellId] = useState<string | null>(null);
  const [drillCellIds, setDrillCellIds] = useState<string[] | null>(null);
  const cellDebounceRef = useRef<number | undefined>(undefined);

  // Boot DuckDB-WASM, load the parquet + facts mirror, then try the cell files.
  useEffect(() => {
    (async () => {
      try {
        const n = await initDuck(PARQUET_URL);
        setCount(n);
        factsRef.current = await loadFacts();
        setReady(true);
      } catch (e) {
        console.error(e);
        setError(String(e));
        return;
      }
      // V2 routed connectors are additive: a failure leaves the straight-line hover fallback.
      try {
        await initConnectors(CONNECTORS_URL);
      } catch (e) {
        console.warn("routed connectors unavailable (straight-line fallback):", e);
      }
      // V2.3 POI detail is additive: absent file → the dossier shows "no listings".
      try {
        await initPois(POIS_URL);
      } catch (e) {
        console.warn("POI detail unavailable (dossier disabled):", e);
      }
      // Footprint polygons for export are additive: absent → KMZ falls back to points.
      try {
        await initFootprints(FOOTPRINTS_URL);
      } catch (e) {
        console.warn("footprint geometry unavailable (export uses points):", e);
      }
      // Building addresses are additive: absent → the dossier shows no address.
      try {
        await initAddresses(ADDRESSES_URL);
      } catch (e) {
        console.warn("building addresses unavailable (dossier shows none):", e);
      }
      // Cell layer is additive: a failure here leaves the V1 screen fully working.
      try {
        await initCells(CELL_URLS, CELL_STATS_URL, 8);
        setCellsAvailable(true);
      } catch (e) {
        console.warn("cell layer unavailable (V1 unaffected):", e);
      }
    })();
  }, []);

  // Headline cost stats whenever sliders settle (debounced). The map recolors
  // itself from a paint expression; this is the authoritative §9 readout.
  useEffect(() => {
    if (!ready) return;
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      setStats(await costStats(sliders));
    }, 110);
    return () => window.clearTimeout(debounceRef.current);
  }, [sliders, ready]);

  // V2.3 — load the pinned building's child POIs (race-guarded on the id).
  useEffect(() => {
    if (!ready || selectedId == null) {
      setDossierPois(null);
      setDossierAddress(null);
      return;
    }
    let live = true;
    setDossierPois(null); // loading
    setDossierAddress(null);
    getBuildingPois(selectedId).then((ps) => {
      if (live) setDossierPois(ps);
    });
    getBuildingAddress(selectedId).then((a) => {
      if (live) setDossierAddress(a);
    });
    return () => {
      live = false;
    };
  }, [selectedId, ready]);

  // Cell scoring whenever the cell sliders / resolution settle (Cell altitude only).
  // Stats are (re)loaded here so the density↔mass poi variant always matches.
  useEffect(() => {
    if (!ready || !cellsAvailable || altitude !== "cells") return;
    window.clearTimeout(cellDebounceRef.current);
    cellDebounceRef.current = window.setTimeout(async () => {
      try {
        const st = await loadCellStats(cellRes, cellSliders.demand_mode);
        const [scores, sstats] = await Promise.all([
          scoreCells(cellSliders, st),
          cellScoreStats(cellSliders, st),
        ]);
        setCellScores(scores);
        setCellStats(sstats);
      } catch (e) {
        console.error("cell scoring failed:", e);
      }
    }, 110);
    return () => window.clearTimeout(cellDebounceRef.current);
  }, [cellSliders, cellRes, altitude, ready, cellsAvailable]);

  const patch = useCallback((p: Partial<Sliders>) => setSliders((s) => ({ ...s, ...p })), []);
  const patchCell = useCallback(
    (p: Partial<CellSliders>) => setCellSliders((s) => ({ ...s, ...p })),
    [],
  );

  // r8 ⇄ r9: swap the DuckDB `cells` table first, then the state (re-scores + the
  // MapView geometry source both react to cellRes).
  const onCellRes = useCallback(async (res: CellRes) => {
    await setCellResolution(res);
    setCellRes(res);
  }, []);

  // Drill-down: a clicked hex → its building_ids (h3-js) → filter the V1 screen.
  const onCellClick = useCallback(
    async (cellId: string) => {
      const ids = await buildingsInCell(cellId, cellRes);
      setDrillCellId(cellId);
      setDrillCellIds(ids);
      setAltitude("buildings");
    },
    [cellRes],
  );
  const clearDrill = useCallback(() => {
    setDrillCellId(null);
    setDrillCellIds(null);
  }, []);

  const colorDomain: [number, number] = cellStats
    ? [cellStats.indexMin, cellStats.indexMax]
    : [-1, 1];
  const cellMode = altitude === "cells";

  return (
    <div className="nn-app">
      <button
        className="nn-panel-toggle"
        aria-expanded={isMobile ? sheet.detent !== "peek" : panelOpen}
        aria-controls="nn-panel"
        onClick={() =>
          isMobile
            ? setDetent(sheet.detent === "peek" ? "full" : "peek")
            : setPanelOpen((o) => !o)
        }
      >
        {(isMobile ? sheet.detent !== "peek" : panelOpen) ? "✕ Close" : "☰ Controls"}
      </button>
      <aside
        ref={panelRef}
        id="nn-panel"
        className={"nn-panel" + (panelOpen ? " open" : "")}
        style={sheet.style}
      >
        {/* Mobile-only grabber — drag to move between detents; keyboard cycles them. */}
        <button
          type="button"
          className="nn-sheet-grab"
          aria-label="Resize panel — drag, or use arrow keys"
          onPointerDown={sheet.onGrabPointerDown}
          onKeyDown={sheet.onGrabKeyDown}
        />
        <header className="nn-head">
          <h1>
            near-net <span className="nn-city">· Pittsburgh</span>{" "}
            <span className="nn-ver">v{__APP_VERSION__}</span>
          </h1>
          <p className="nn-lead">
            See roughly what it&rsquo;d cost to connect any Pittsburgh building to a modeled
            network corridor — then drag the sliders to test the assumptions.
          </p>
          <p className="nn-honesty">
            Modeled corridor from major-arterial right-of-way. Distance is{" "}
            <b>road-routed</b> — an offline shortest path to the corridor, a
            screening estimate, not a build cost. No real fiber or operator data.
          </p>
        </header>

        {error && <div className="nn-error">DuckDB error: {error}</div>}

        {cellsAvailable && (
          <div className="nn-seg nn-altitude" role="group" aria-label="Map altitude">
            <button
              type="button"
              className={"nn-seg-btn" + (!cellMode ? " active" : "")}
              aria-pressed={!cellMode}
              onClick={() => setAltitude("buildings")}
            >
              Buildings
            </button>
            <button
              type="button"
              className={"nn-seg-btn" + (cellMode ? " active" : "")}
              aria-pressed={cellMode}
              onClick={() => setAltitude("cells")}
            >
              Cell overview
            </button>
          </div>
        )}

        {/* Buildings altitude — the V1 screen, unchanged. */}
        {!cellMode && (
          <>
            {selectedId && (
              <Dossier
                facts={factsRef.current?.get(selectedId) ?? null}
                pois={dossierPois}
                sliders={sliders}
                address={dossierAddress}
                onClear={() => setSelectedId(null)}
                onFrame={() => mapApiRef.current?.frameSelection()}
              />
            )}
            {drillCellId && (
              <div className="nn-drill">
                Showing {drillCellIds?.length.toLocaleString() ?? 0} buildings in cell{" "}
                <code>{drillCellId.slice(0, 8)}…</code>
                <button type="button" onClick={clearDrill}>
                  clear
                </button>
              </div>
            )}
            <div className="nn-stat" role="status" aria-live="polite" aria-atomic="true">
              {ready && stats ? (
                <>
                  <div className="nn-stat-big" key={stats.reachable}>
                    {stats.reachable.toLocaleString()}
                    <span>reachable</span>
                  </div>
                  <div className="nn-stat-sub">
                    of {stats.inRange.toLocaleString()} in-range ·{" "}
                    {count.toLocaleString()} buildings total · within{" "}
                    {fmtUSD(sliders.budget)}
                  </div>
                  <div className="nn-stat-hint">reachable = in-range and within budget</div>
                </>
              ) : (
                <div className="nn-stat-sub">{error ? "—" : "Loading modeled facts…"}</div>
              )}
            </div>
            <Controls sliders={sliders} onChange={patch} />
            <div className="nn-legend">
              <div className="nn-legend-h">Estimated connection cost</div>
              <div className="nn-ramp" />
              <div className="nn-ramp-labels">
                <span>$0</span>
                <span>{fmtUSD(sliders.budget / 2)}</span>
                <span>≥ {fmtUSD(sliders.budget)}</span>
              </div>
              <div className="nn-legend-group">
                <div className="nn-legend-sub">Network <span>— solid</span></div>
                <ul className="nn-legend-list">
                  <li><i className="ln solid" style={{ background: "#0a9396" }} /> modeled fiber corridor (primary) <Info term="corridor" /></li>
                  <li><i className="ln solid" style={{ background: "#9b5de5" }} /> bridge (potential lower-cost crossing)</li>
                </ul>
              </div>
              <div className="nn-legend-group">
                <div className="nn-legend-sub">Barriers <span>— dashed, add crossing cost</span></div>
                <ul className="nn-legend-list nn-legend-cols">
                  <li><i className="ln dash" style={{ color: "#3b82c4" }} /> water</li>
                  <li><i className="ln dash" style={{ color: "#7a5c3e" }} /> rail</li>
                  <li><i className="ln dash" style={{ color: "#e8833a" }} /> interstate</li>
                  <li><i className="ln dash" style={{ color: "#c99a00" }} /> arterial</li>
                </ul>
              </div>
              <div className="nn-legend-group">
                <div className="nn-legend-sub">Extent</div>
                <ul className="nn-legend-list nn-legend-cols">
                  <li><i className="ln dash" style={{ color: "#1b2733" }} /> City of Pittsburgh clip</li>
                  <li><i className="sw" style={{ background: "#9aa0a6" }} /> beyond range (~4,000 ft)</li>
                </ul>
              </div>
              <p className="nn-foot">
                Hover or tap a building for the itemized screening estimate. In-range ≤ ~4,000 ft
                (0.76 mi); distances computed in EPSG:2272 (State Plane PA-South, US survey feet).
                Data: © OpenStreetMap, Overture Maps, USGS NHD, US Census TIGER.
              </p>
            </div>
          </>
        )}

        {/* Cell overview altitude — the V1.5 opportunity-index (opt-in). */}
        {cellMode && (
          <>
            <p className="nn-honesty">
              A transparent, tunable <b>opportunity index</b> — a normalized weighted score
              over the modeled per-building facts, for gap analysis (high demand + low
              reachability + low barriers). A screening <b>index</b>, not a cost.
            </p>
            <div className="nn-stat">
              {cellStats ? (
                <>
                  <div className="nn-stat-big">
                    {cellStats.hot.toLocaleString()}
                    <span> cells above cut</span>
                  </div>
                  <div className="nn-stat-sub">
                    top of {cellStats.total.toLocaleString()} scored ·{" "}
                    <span className="nn-nowrap">
                      Index ≥ {fmtIndex(cellSliders.score_threshold)}
                    </span>{" "}
                    (top-quintile default) ·{" "}
                    <span className="nn-nowrap">{cellStats.gaps.toLocaleString()} gap</span>
                  </div>
                </>
              ) : (
                <div className="nn-stat-sub">Scoring cells…</div>
              )}
            </div>

            <div className="nn-seg nn-res" role="group" aria-label="H3 resolution (MAUP toggle)">
              <span className="nn-seg-label">Grain</span>
              {([8, 9] as CellRes[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  className={"nn-seg-btn" + (cellRes === r ? " active" : "")}
                  aria-pressed={cellRes === r}
                  onClick={() => onCellRes(r)}
                >
                  {r === 8 ? "r8 · neighborhood" : "r9 · fine"}
                </button>
              ))}
            </div>

            <CellControls sliders={cellSliders} onChange={patchCell} domain={colorDomain} />

            <div className="nn-legend">
              <div className="nn-legend-h">
                Opportunity index <span className="nn-legend-note">— unitless, NOT dollars</span>
              </div>
              <div className="nn-cell-ramp" />
              <div className="nn-ramp-labels">
                <span>{fmtIndex(colorDomain[0])}</span>
                <span>0</span>
                <span>{fmtIndex(colorDomain[1])}</span>
              </div>
              <ul className="nn-legend-list">
                <li><i className="sw" style={{ background: "#d7dae0" }} /> excluded (below the min-buildings floor) — not scored <span className="nn-nowrap">(gray ≠ index 0)</span></li>
                <li><i className="ln" style={{ background: "#e63946" }} /> gap cell — high modeled demand + high cost / barriers; <span className="nn-nowrap">a screening candidate, <b>not</b></span> a confirmed prospect</li>
                <li>Brighter = above the draggable <span className="nn-nowrap"><b>Index ≥</b> cut</span> (default top-quintile); dimmer cells are scored but below it.</li>
              </ul>
              <p className="nn-foot">
                A normalized weighted score over the modeled per-building facts, for gap
                analysis. A screening <b>index</b>, not a cost. Scores depend on hexagon
                size &amp; placement (MAUP <Info term="MAUP" />) — H3 <Info term="H3" /> cells are
                near-uniform area with no orientation bias; the <b>resolution is a modeling
                choice</b> (try r8 ⇄ r9). Inherits every building-screen caveat (modeled
                corridor, road-routed connector distance, proxy bridge) and adds aggregation
                on top — never more authoritative than the dots it came from. POI = modeled
                tenant-density from whitelisted public Overture places, not customers or revenue.
              </p>
            </div>

            <CellTable scores={cellScores} onRowClick={onCellClick} />
          </>
        )}
      </aside>

      <main className="nn-main">
        <MapView
          ref={mapApiRef}
          ready={ready}
          sliders={sliders}
          facts={factsRef.current}
          altitude={altitude}
          cellRes={cellRes}
          cellScores={cellScores}
          cellSliders={cellSliders}
          colorDomain={colorDomain}
          drillCellIds={drillCellIds}
          onCellClick={onCellClick}
          onSelectBuilding={setSelectedId}
          selectedId={selectedId}
        />
        {ready && !cellMode && <OnboardingCue />}
      </main>
    </div>
  );
}
