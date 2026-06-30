import { useCallback, useEffect, useRef, useState } from "react";
import MapView from "./MapView";
import Controls from "./Controls";
import { DEFAULT_SLIDERS, fmtUSD, type Sliders, type BuildingFacts } from "./cost";
import { initDuck, loadFacts, costStats, type CostStats } from "./duck";

const PARQUET_URL = new URL("data/buildings.parquet", document.baseURI).href;

export default function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [sliders, setSliders] = useState<Sliders>(DEFAULT_SLIDERS);
  const [stats, setStats] = useState<CostStats | null>(null);
  const factsRef = useRef<Map<string, BuildingFacts> | null>(null);
  const debounceRef = useRef<number | undefined>(undefined);

  // Boot DuckDB-WASM, load the parquet + facts mirror.
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
      }
    })();
  }, []);

  // Refresh the headline stats whenever sliders settle (debounced). The map
  // recolors itself live from a paint expression (MapView); this is just the
  // authoritative DuckDB §9 readout for "N reachable".
  useEffect(() => {
    if (!ready) return;
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      setStats(await costStats(sliders));
    }, 110);
    return () => window.clearTimeout(debounceRef.current);
  }, [sliders, ready]);

  const patch = useCallback((p: Partial<Sliders>) => setSliders((s) => ({ ...s, ...p })), []);

  return (
    <div className="nn-app">
      <aside className="nn-panel">
        <header className="nn-head">
          <h1>near-net · Pittsburgh</h1>
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
      </aside>

      <main className="nn-main">
        <MapView ready={ready} sliders={sliders} facts={factsRef.current} />
      </main>
    </div>
  );
}
