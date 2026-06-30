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
