import { useCallback, useEffect, useRef, useState } from "react";
import MapView, { type Altitude } from "./MapView";
import Controls from "./Controls";
import CellControls from "./CellControls";
import CellTable from "./CellTable";
import { DEFAULT_SLIDERS, fmtUSD, type Sliders, type BuildingFacts } from "./cost";
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

export default function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [sliders, setSliders] = useState<Sliders>(DEFAULT_SLIDERS);
  const [stats, setStats] = useState<CostStats | null>(null);
  const [panelOpen, setPanelOpen] = useState(true); // mobile drawer (no-op on desktop)
  const factsRef = useRef<Map<string, BuildingFacts> | null>(null);
  const debounceRef = useRef<number | undefined>(undefined);

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
        aria-expanded={panelOpen}
        aria-controls="nn-panel"
        onClick={() => setPanelOpen((o) => !o)}
      >
        {panelOpen ? "✕ Close" : "☰ Controls"}
      </button>
      <aside id="nn-panel" className={"nn-panel" + (panelOpen ? " open" : "")}>
        <header className="nn-head">
          <h1>
            near-net · Pittsburgh <span className="nn-ver">v{__APP_VERSION__}</span>
          </h1>
          <p className="nn-tag">
            A client-side fiber <b>near-net proximity screen</b> — a tunable
            screening estimate over open data.
          </p>
          <p className="nn-honesty">
            Modeled corridor from major-arterial right-of-way. Straight-line
            distance × circuity is a <b>lower-bound screen</b>, not a build cost.
            No real fiber or company data.
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
            {drillCellId && (
              <div className="nn-drill">
                Showing {drillCellIds?.length.toLocaleString() ?? 0} buildings in cell{" "}
                <code>{drillCellId.slice(0, 8)}…</code>
                <button type="button" onClick={clearDrill}>
                  clear
                </button>
              </div>
            )}
            <div className="nn-stat">
              {ready && stats ? (
                <>
                  <div className="nn-stat-big">
                    {stats.reachable.toLocaleString()}
                    <span> reachable</span>
                  </div>
                  <div className="nn-stat-sub">
                    of {stats.inRange.toLocaleString()} in-range ·{" "}
                    {count.toLocaleString()} buildings total · within{" "}
                    {fmtUSD(sliders.budget)}
                  </div>
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
              <ul className="nn-legend-list">
                <li><i className="sw" style={{ background: "#9aa0a6" }} /> beyond plausible distance (in_range = false)</li>
                <li><i className="ln" style={{ background: "#1b2733" }} /> City of Pittsburgh extent (project clip)</li>
                <li><i className="ln" style={{ background: "#0a9396" }} /> modeled fiber corridor (primary)</li>
                <li><i className="ln" style={{ background: "#9b5de5" }} /> bridge (potential lower-cost crossing)</li>
                <li><i className="ln" style={{ background: "#3b82c4" }} /> water · <i className="ln" style={{ background: "#7a5c3e" }} /> rail · <i className="ln" style={{ background: "#e8833a" }} /> interstate · <i className="ln" style={{ background: "#d9b500" }} /> arterial</li>
              </ul>
              <p className="nn-foot">
                Hover a building for the itemized screening estimate. Data: ©
                OpenStreetMap, Overture Maps, USGS NHD, US Census TIGER.
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
                    top of {cellStats.total.toLocaleString()} scored · Index ≥{" "}
                    {fmtIndex(cellSliders.score_threshold)} (top-quintile default) ·{" "}
                    {cellStats.gaps.toLocaleString()} gap
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
                <li><i className="sw" style={{ background: "#d7dae0" }} /> excluded (below the min-buildings floor) — not scored (gray ≠ index 0)</li>
                <li><i className="ln" style={{ background: "#e63946" }} /> gap cell — high modeled demand + high cost / barriers; a screening candidate, <b>not</b> a confirmed prospect</li>
                <li>Brighter = above the draggable <b>Index ≥</b> cut (default top-quintile); dimmer cells are scored but below it.</li>
              </ul>
              <p className="nn-foot">
                A normalized weighted score over the modeled per-building facts, for gap
                analysis. A screening <b>index</b>, not a cost. Scores depend on hexagon
                size &amp; placement (MAUP) — H3 cells are near-uniform area with no
                orientation bias; the <b>resolution is a modeling choice</b> (try r8 ⇄ r9).
                Inherits every building-screen caveat (modeled corridor, straight-line
                distance, proxy bridge) and adds aggregation on top — never more
                authoritative than the dots it came from. POI = modeled tenant-density
                from whitelisted Overture places, not customers or revenue.
              </p>
            </div>

            <CellTable scores={cellScores} onRowClick={onCellClick} />
          </>
        )}
      </aside>

      <main className="nn-main">
        <MapView
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
        />
      </main>
    </div>
  );
}
