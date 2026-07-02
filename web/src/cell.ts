// The opportunity-index cell layer — V1.5, DESIGN.md §14.
//
// A SECOND ALTITUDE over the per-building screen. The build step bakes per-cell
// FACTS (aggregates) + `cell_stats` distribution stats; this file holds the
// OPINIONS (weights, normalization, thresholds) and the scoring formula, in the
// same "change one, change all" contract as cost.ts:
//   - `buildCellScoreSQL` — SQL DuckDB-WASM runs over cells + baked stats (§14.7).
//   - `cellBreakdown`      — JS twin, for the itemized hover popup.
//   - `cellColorExpression`— MapLibre paint over `feature-state` (scores are set
//                            per-cell via setFeatureState, unlike the cost layer).
// The index is a UNITLESS weighted screening score — never dollars (guardrail #5).

import type { ExpressionSpecification } from "maplibre-gl";

export type NormMode = "z" | "minmax";
export type DemandMode = "density" | "mass";
export type CellRes = 8 | 9;

export interface CellSliders {
  w_poi: number; // demand weight (>= 0)
  w_dist: number; // reachability weight (>= 0; z-negated inside the query)
  w_barrier: number; // barrier weight (>= 0; z-negated inside the query)
  w_bldg: number; // building-count weight (>= 0)
  norm: NormMode; // z-score (default) | min-max
  min_buildings: number; // thin-cell floor (small-n defence)
  score_threshold: number; // map hot-set cutoff: Index >= X
  g_demand: number; // gap z-cut: high modeled demand
  g_cost: number; // gap z-cut: high reachability cost
  g_barrier: number; // gap z-cut: high barrier load
  demand_mode: DemandMode; // density (default) | mass
}

// Mirrors build/config.py SAMPLE_CELL_SLIDERS (the values that validate §14.7).
export const DEFAULT_CELL_SLIDERS: CellSliders = {
  w_poi: 0.4,
  w_dist: 0.3,
  w_barrier: 0.2,
  w_bldg: 0.1,
  norm: "z",
  min_buildings: 5,
  score_threshold: 0.3, // top-quintile "where to look first" cut (Phase-0.5 p80 ≈ 0.32/0.34)
  g_demand: 0.5,
  g_cost: 0.5,
  g_barrier: 0.5,
  demand_mode: "density",
};

// One baked distribution per scorable feature (from cell_stats.parquet). `poi` is
// the variant matching the active demand_mode (density or mass).
export interface CellStat {
  mean: number;
  std: number;
  min: number;
  max: number;
}
export type CellStats = Record<"poi" | "dist" | "barrier" | "bldg", CellStat>;

// One scored cell — feeds feature-state + the ranked table + the hover breakout.
export interface CellScore {
  cell_id: string;
  opportunity_index: number;
  is_gap: boolean;
  c_poi: number;
  c_dist: number;
  c_barrier: number;
  c_bldg: number;
  building_count: number;
  poi_count_sum: number;
  conn_dist_median_ft: number;
  total_crossings_mean: number;
  centroid_lon: number;
  centroid_lat: number;
}

/** Standardize `expr` against a baked stat, per the normalization mode (§14.6). */
function normExpr(expr: string, st: CellStat, mode: NormMode): string {
  if (mode === "minmax") {
    const span = st.max - st.min;
    return `COALESCE((${expr} - ${st.min}) / NULLIF(${span}, 0), 0)`;
  }
  return `COALESCE((${expr} - ${st.mean}) / NULLIF(${st.std}, 0), 0)`;
}

/**
 * The §14.7 cell closing query as a literal SQL string for DuckDB-WASM.
 *
 * Pure arithmetic over the baked `cells` table + `cell_stats` binds — no h3, no
 * routing. Cost-like axes (dist, barrier) are z-negated so every weight stays
 * >= 0. Per-term `c_*` columns are kept separate for the hover breakout. Every
 * scored cell is returned (no threshold filter) so one result serves both the
 * choropleth and the ranked table; the threshold is a display cut.
 */
export function buildCellScoreSQL(s: CellSliders, st: CellStats): string {
  const poiExpr =
    s.demand_mode === "density"
      ? "CAST(poi_count_sum AS double) / NULLIF(building_count, 0)"
      : "CAST(poi_count_sum AS double)";
  const zPoi = normExpr(poiExpr, st.poi, s.norm);
  const zDist = normExpr("conn_dist_median_ft", st.dist, s.norm);
  const zBarrier = normExpr("total_crossings_mean", st.barrier, s.norm);
  const zBldg = normExpr("CAST(building_count AS double)", st.bldg, s.norm);
  return `
    WITH base AS (
      SELECT * FROM cells WHERE building_count >= ${s.min_buildings}
    ), z AS (
      SELECT cell_id, centroid_lon, centroid_lat, building_count, poi_count_sum,
             conn_dist_median_ft, total_crossings_mean,
             ${zPoi}     AS z_poi,
             ${zDist}    AS z_dist,
             ${zBarrier} AS z_barrier,
             ${zBldg}    AS z_bldg
      FROM base
    )
    SELECT cell_id, centroid_lon, centroid_lat,
           building_count, poi_count_sum, conn_dist_median_ft, total_crossings_mean,
           (${s.w_poi}     * z_poi)      AS c_poi,
           (${s.w_dist}    * -z_dist)    AS c_dist,
           (${s.w_barrier} * -z_barrier) AS c_barrier,
           (${s.w_bldg}    * z_bldg)     AS c_bldg,
           (${s.w_poi}*z_poi)+(${s.w_dist}*-z_dist)
             +(${s.w_barrier}*-z_barrier)+(${s.w_bldg}*z_bldg) AS opportunity_index,
           (z_poi >= ${s.g_demand}
             AND (z_dist >= ${s.g_cost} OR z_barrier >= ${s.g_barrier})) AS is_gap
    FROM z
    ORDER BY opportunity_index DESC`;
}

export interface CellTerm {
  label: string;
  detail: string;
  contribution: number;
}

/** JS twin of the scoring query — the four terms, itemized for the hover popup. */
export function cellBreakdown(c: CellScore, s: CellSliders): { terms: CellTerm[]; total: number } {
  const demand =
    s.demand_mode === "density"
      ? `${(c.poi_count_sum / Math.max(1, c.building_count)).toFixed(2)} POI/bldg`
      : `${c.poi_count_sum.toLocaleString()} POI`;
  const terms: CellTerm[] = [
    { label: "Demand", detail: `${demand} · w${s.w_poi}`, contribution: c.c_poi },
    {
      label: "Reachability",
      detail: `median ${Math.round(c.conn_dist_median_ft).toLocaleString()} ft · closer is better · w${s.w_dist}`,
      contribution: c.c_dist,
    },
    {
      label: "Barrier load",
      detail: `${c.total_crossings_mean.toFixed(2)} crossings/bldg · fewer is better · w${s.w_barrier}`,
      contribution: c.c_barrier,
    },
    { label: "Building count", detail: `${c.building_count.toLocaleString()} bldgs · w${s.w_bldg}`, contribution: c.c_bldg },
  ];
  return { terms, total: c.opportunity_index };
}

/** Unitless index formatter — two decimals, never a `$`. */
export const fmtIndex = (n: number): string => n.toFixed(2);

// --- MapLibre paint (the third twin) -----------------------------------------
// Scores are per-cell `feature-state` (set via setFeatureState after each scoring
// run), so the choropleth reads ["feature-state","score"]. A DIFFERENT color
// family from the V1 green→red cost gradient (§14.11): sequential PURPLE
// (ColorBrewer Purples), so the two altitudes never read as the same scale.
const PURPLE = ["#f2f0f7", "#cbc9e2", "#9e9ac8", "#756bb1", "#54278f"];
const GRAY = "#d7dae0"; // excluded / below the min-buildings floor — NEVER "score 0"

/**
 * fill-color: gray where a cell is unscored (below min_buildings → no
 * feature-state), else the PURPLE ramp interpolated over the score domain
 * (data-driven [p05,p95]; the index is a z-space value that can be negative, so
 * the domain is NOT [0, threshold] and 0 is a meaningful mid-value).
 */
export function cellColorExpression(domain: [number, number]): ExpressionSpecification {
  const [lo, hi] = domain[0] < domain[1] ? domain : [domain[0] - 1, domain[0] + 1];
  const step = (hi - lo) / 4;
  return [
    "case",
    ["!=", ["feature-state", "scored"], true],
    GRAY,
    [
      "interpolate",
      ["linear"],
      ["feature-state", "score"],
      lo, PURPLE[0],
      lo + step, PURPLE[1],
      lo + 2 * step, PURPLE[2],
      lo + 3 * step, PURPLE[3],
      hi, PURPLE[4],
    ],
  ] as ExpressionSpecification;
}

/**
 * fill-opacity: unscored cells faint gray; scored cells in the hot set (Index ≥
 * threshold) brighter than below-threshold ones. The threshold thus dims via
 * feature-state — no paint recompute needed when only the threshold moves.
 * Semi-transparent so the streets below read through (a smooth choropleth must
 * not look more authoritative than the noisy dots it came from — §14.11).
 */
export function cellOpacityExpression(): ExpressionSpecification {
  return [
    "case",
    ["!=", ["feature-state", "scored"], true],
    0.15,
    ["==", ["feature-state", "hot"], true],
    0.72,
    0.32,
  ] as ExpressionSpecification;
}

/** line-opacity for the gap-outline layer — red hairline only on gap cells. */
export function gapOutlineExpression(): ExpressionSpecification {
  return ["case", ["==", ["feature-state", "gap"], true], 1, 0] as ExpressionSpecification;
}
