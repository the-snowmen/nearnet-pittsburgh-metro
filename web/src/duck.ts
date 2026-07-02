// DuckDB-WASM — the in-browser query engine (DESIGN.md §2, §11).
//
// Loads the facts-only buildings.parquet (numeric/varchar columns only, no
// GEOMETRY type) so no spatial extension is needed in the browser, then runs the
// §9 closing query live on every slider change. "GitHub Pages serves the parquet
// like an image; the browser reads columns and multiplies."

import * as duckdb from "@duckdb/duckdb-wasm";
import mvp_wasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvp_worker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import eh_wasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import eh_worker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";

import type { BuildingFacts, Sliders } from "./cost";
import { buildCostSQL } from "./cost";
import { latLngToCell } from "h3-js";
import type { CellRes, CellScore, CellSliders, CellStats, DemandMode } from "./cell";
import { buildCellScoreSQL } from "./cell";

let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;
let initPromise: Promise<number> | null = null;

const BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: mvp_wasm, mainWorker: mvp_worker },
  eh: { mainModule: eh_wasm, mainWorker: eh_worker },
};

/**
 * Boot DuckDB-WASM and CREATE TABLE buildings from the static parquet.
 * Singleton: React StrictMode double-invokes effects in dev, so cache the
 * promise and reuse one DuckDB instance / one table.
 */
export async function initDuck(parquetUrl: string): Promise<number> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const bundle = await duckdb.selectBundle(BUNDLES);
    const worker = new Worker(bundle.mainWorker!);
    db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    conn = await db.connect();

    await db.registerFileURL(
      "buildings.parquet",
      parquetUrl,
      duckdb.DuckDBDataProtocol.HTTP,
      false,
    );
    await conn.query(
      `CREATE OR REPLACE TABLE buildings AS SELECT * FROM read_parquet('buildings.parquet')`,
    );
    const res = await conn.query(`SELECT count(*)::INT AS n FROM buildings`);
    return res.getChild("n")?.get(0) as number;
  })();
  return initPromise;
}

/** One-shot pull of every building's facts (for the instant hover breakout). */
export async function loadFacts(): Promise<Map<string, BuildingFacts>> {
  if (!conn) throw new Error("DuckDB not initialised");
  const res = await conn.query(`
    SELECT building_id, building_class, connector_distance_ft,
           water_crossings, rail_crossings, interstate_crossings, arterial_crossings,
           in_range, bridge_available, nearest_bridge_ft, poi_count
    FROM buildings`);
  const m = new Map<string, BuildingFacts>();
  for (const r of res.toArray() as any[]) {
    m.set(r.building_id as string, {
      building_id: r.building_id as string,
      building_class: r.building_class as string | null,
      connector_distance_ft: Number(r.connector_distance_ft),
      water_crossings: Number(r.water_crossings),
      rail_crossings: Number(r.rail_crossings),
      interstate_crossings: Number(r.interstate_crossings),
      arterial_crossings: Number(r.arterial_crossings),
      in_range: Boolean(r.in_range),
      bridge_available: Boolean(r.bridge_available),
      nearest_bridge_ft: r.nearest_bridge_ft == null ? null : Number(r.nearest_bridge_ft),
      poi_count: Number(r.poi_count),
    });
  }
  return m;
}

/** Aggregate stats for the legend / readout (cheap, runs once per slider settle). */
export interface CostStats {
  total: number;
  inRange: number;
  reachable: number; // in_range AND est_cost <= budget
  maxCost: number;
}

export async function costStats(s: Sliders): Promise<CostStats> {
  if (!conn) throw new Error("DuckDB not initialised");
  const sql = `
    WITH c AS (${buildCostSQL(s)})
    SELECT count(*)::INT AS total,
           count(*) FILTER (WHERE in_range)::INT AS in_range,
           count(*) FILTER (WHERE in_range AND est_cost <= ${s.budget})::INT AS reachable,
           COALESCE(max(est_cost), 0) AS max_cost
    FROM c`;
  const r = (await conn.query(sql)).get(0) as any;
  return {
    total: Number(r.total),
    inRange: Number(r.in_range),
    reachable: Number(r.reachable),
    maxCost: Number(r.max_cost),
  };
}

// --- V1.5 cell layer (DESIGN.md §14) -----------------------------------------
// Additive & removable: the cell files are registered lazily; a failed init
// leaves the V1 building screen untouched (App feature-detects `cellsAvailable`).
// Same no-spatial-extension pattern as buildings.parquet — the facts-only cell
// parquet has no GEOMETRY column, so DuckDB-WASM reads it with zero extensions.

let cellsReady = false;
const cellStatFeature: Record<keyof CellStats, (m: DemandMode) => string> = {
  poi: (m) => (m === "density" ? "poi_density" : "poi_count_sum"),
  dist: () => "dist_median",
  barrier: () => "barrier_mean",
  bldg: () => "bldg",
};

/**
 * Register the cell parquets + cell_stats and CREATE the active-resolution `cells`
 * table. Returns the active-resolution cell count. Throws if the files are absent
 * (caller catches → hides the cell altitude, V1 unaffected).
 */
export async function initCells(
  cellUrls: Record<CellRes, string>,
  statsUrl: string,
  res: CellRes,
): Promise<number> {
  if (!db || !conn) throw new Error("DuckDB not initialised");
  for (const [r, url] of Object.entries(cellUrls)) {
    await db.registerFileURL(`cells_r${r}.parquet`, url, duckdb.DuckDBDataProtocol.HTTP, false);
  }
  await db.registerFileURL("cell_stats.parquet", statsUrl, duckdb.DuckDBDataProtocol.HTTP, false);
  await conn.query(
    `CREATE OR REPLACE TABLE cell_stats AS SELECT * FROM read_parquet('cell_stats.parquet')`,
  );
  const n = await setCellResolution(res);
  cellsReady = true;
  return n;
}

/** Swap the active-resolution `cells` table (the r8 ⇄ r9 MAUP toggle). */
export async function setCellResolution(res: CellRes): Promise<number> {
  if (!conn) throw new Error("DuckDB not initialised");
  await conn.query(
    `CREATE OR REPLACE TABLE cells AS SELECT * FROM read_parquet('cells_r${res}.parquet')`,
  );
  const r = await conn.query(`SELECT count(*)::INT AS n FROM cells`);
  return r.getChild("n")?.get(0) as number;
}

/** Pull the baked distribution stats for `res`, picking the poi variant by mode. */
export async function loadCellStats(res: CellRes, demand: DemandMode): Promise<CellStats> {
  if (!conn) throw new Error("DuckDB not initialised");
  const rows = (
    await conn.query(`SELECT * FROM cell_stats WHERE h3_res = ${res}`)
  ).toArray() as any[];
  const byFeat = new Map<string, any>(rows.map((r) => [r.feature as string, r]));
  const pick = (feat: string): { mean: number; std: number; min: number; max: number } => {
    const r = byFeat.get(feat);
    return { mean: Number(r.mean), std: Number(r.std), min: Number(r.min), max: Number(r.max) };
  };
  return {
    poi: pick(cellStatFeature.poi(demand)),
    dist: pick(cellStatFeature.dist(demand)),
    barrier: pick(cellStatFeature.barrier(demand)),
    bldg: pick(cellStatFeature.bldg(demand)),
  };
}

function toCellScore(r: any): CellScore {
  return {
    cell_id: r.cell_id as string,
    opportunity_index: Number(r.opportunity_index),
    is_gap: Boolean(r.is_gap),
    c_poi: Number(r.c_poi),
    c_dist: Number(r.c_dist),
    c_barrier: Number(r.c_barrier),
    c_bldg: Number(r.c_bldg),
    building_count: Number(r.building_count),
    poi_count_sum: Number(r.poi_count_sum),
    conn_dist_median_ft: Number(r.conn_dist_median_ft),
    total_crossings_mean: Number(r.total_crossings_mean),
    centroid_lon: Number(r.centroid_lon),
    centroid_lat: Number(r.centroid_lat),
  };
}

/** Run the §14.7 scoring query — every scored cell (feature-state + ranked table). */
export async function scoreCells(s: CellSliders, st: CellStats): Promise<CellScore[]> {
  if (!conn) throw new Error("DuckDB not initialised");
  const rows = (await conn.query(buildCellScoreSQL(s, st))).toArray() as any[];
  return rows.map(toCellScore);
}

export interface CellScoreStats {
  total: number; // scored cells (>= min_buildings)
  hot: number; // Index >= score_threshold
  gaps: number;
  indexMin: number; // p05 of the index — the choropleth color-domain low
  indexMax: number; // p95 — the color-domain high
}

/** Cheap aggregate for the legend / color domain / "N of M above threshold". */
export async function cellScoreStats(s: CellSliders, st: CellStats): Promise<CellScoreStats> {
  if (!conn) throw new Error("DuckDB not initialised");
  const sql = `
    WITH c AS (${buildCellScoreSQL(s, st)})
    SELECT count(*)::INT AS total,
           count(*) FILTER (WHERE opportunity_index >= ${s.score_threshold})::INT AS hot,
           count(*) FILTER (WHERE is_gap)::INT AS gaps,
           COALESCE(quantile_cont(opportunity_index, 0.05), 0) AS lo,
           COALESCE(quantile_cont(opportunity_index, 0.95), 1) AS hi
    FROM c`;
  const r = (await conn.query(sql)).get(0) as any;
  return {
    total: Number(r.total),
    hot: Number(r.hot),
    gaps: Number(r.gaps),
    indexMin: Number(r.lo),
    indexMax: Number(r.hi),
  };
}

/** building_id + centroid for every building — one pass, for h3-js drill-down. */
export async function loadCentroids(): Promise<
  { building_id: string; lat: number; lon: number }[]
> {
  if (!conn) throw new Error("DuckDB not initialised");
  const rows = (
    await conn.query(`SELECT building_id, centroid_lat, centroid_lon FROM buildings`)
  ).toArray() as any[];
  return rows.map((r) => ({
    building_id: r.building_id as string,
    lat: Number(r.centroid_lat),
    lon: Number(r.centroid_lon),
  }));
}

// --- Drill-down membership (h3-js in JS — DESIGN §14.11) ----------------------
// The V1 building tiles carry no cell_id, and buildings.parquet has no baked
// membership column (§14.2). So the drill-down set is computed client-side with
// h3-js `latLngToCell` over the baked centroids — h3-js is pinned to the build's
// h3-py major so indexing matches. Memoized per resolution (one ~116k pass each).
let _centroids: { building_id: string; lat: number; lon: number }[] | null = null;
const _membership = new Map<CellRes, Map<string, string[]>>();

async function _membershipFor(res: CellRes): Promise<Map<string, string[]>> {
  const cached = _membership.get(res);
  if (cached) return cached;
  if (!_centroids) _centroids = await loadCentroids();
  const m = new Map<string, string[]>();
  for (const c of _centroids) {
    const id = latLngToCell(c.lat, c.lon, res);
    const bucket = m.get(id);
    if (bucket) bucket.push(c.building_id);
    else m.set(id, [c.building_id]);
  }
  _membership.set(res, m);
  return m;
}

/** building_ids whose centroid falls in `cellId` (h3-js membership, memoized). */
export async function buildingsInCell(cellId: string, res: CellRes): Promise<string[]> {
  return (await _membershipFor(res)).get(cellId) ?? [];
}

export const cellsInitialised = (): boolean => cellsReady;
