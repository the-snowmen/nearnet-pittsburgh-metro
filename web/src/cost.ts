// The cost screen — DESIGN.md §6 / §9.
//
// Cost OPINIONS live here as slider state; geographic FACTS live in the baked
// parquet. The browser does arithmetic over baked facts — no routing. This file
// is the single source of the cost formula, in THREE encodings that MUST stay in
// lock-step:
//   - `buildCostSQL`     — SQL string DuckDB-WASM runs (authoritative stats: §9).
//   - `breakdown`        — JS twin, for the itemized hover popup.
//   - `costExpression`   — MapLibre paint expression over baked footprint
//                          properties, for the live cost-surface recolor (no
//                          per-feature setFeatureState loop).
// Change one, change all three.

import type { ExpressionSpecification } from "maplibre-gl";

export interface Sliders {
  costPerFt: number; // $/ft of connector
  circuity: number; // V2: distance is already road-routed, so this is an optional slack
                    // factor (default 1.0 = no double-count). Slider kept for sensitivity.
  boreCost: number; // fresh water crossing (no bridge)
  bridgeCost: number; // discounted water crossing where a bridge is available
  railCost: number; // rail crossing (bore under tracks)
  interstateCost: number; // motorway + trunk crossing
  arterialCost: number; // secondary-road crossing
  useBridges: boolean; // apply the bridge discount where available
  budget: number; // reachable iff est_cost <= budget
}

// Literature-grounded / DESIGN §6.3 starting guesses. These mirror
// build/config.py SAMPLE_SLIDERS (the values that validate the closing query).
// V2: connector_distance_ft is REAL road-routed distance, so circuity defaults to
// 1.0 (the detour it faked in V1 is now baked into the distance).
export const DEFAULT_SLIDERS: Sliders = {
  costPerFt: 30,
  circuity: 1.0,
  boreCost: 20000,
  bridgeCost: 5000,
  railCost: 25000,
  interstateCost: 15000,
  arterialCost: 3000,
  useBridges: true,
  budget: 100000,
};

// Assumption presets — one-click cost-scenario bundles. They set the cost
// *opinions* only; `budget` (the user's screening threshold) is left untouched.
export type PresetSliders = Omit<Sliders, "budget">;
export interface Preset {
  name: string;
  hint: string;
  sliders: PresetSliders;
}

export const PRESETS: Preset[] = [
  {
    name: "Optimistic",
    hint: "cheap build, mostly aerial, bridges used",
    sliders: {
      costPerFt: 18, circuity: 1.0, boreCost: 12000, bridgeCost: 3000,
      railCost: 15000, interstateCost: 9000, arterialCost: 1500, useBridges: true,
    },
  },
  {
    name: "Typical",
    hint: "literature-grounded midpoint (default)",
    sliders: {
      costPerFt: 30, circuity: 1.0, boreCost: 20000, bridgeCost: 5000,
      railCost: 25000, interstateCost: 15000, arterialCost: 3000, useBridges: true,
    },
  },
  {
    name: "Conservative",
    hint: "costly build, hard bores, no bridge discount",
    sliders: {
      costPerFt: 55, circuity: 1.0, boreCost: 35000, bridgeCost: 9000,
      railCost: 45000, interstateCost: 28000, arterialCost: 6000, useBridges: false,
    },
  },
];

/** True if the current sliders match a preset's cost assumptions (budget ignored). */
export function matchesPreset(s: Sliders, p: Preset): boolean {
  return (Object.keys(p.sliders) as (keyof PresetSliders)[]).every(
    (k) => s[k] === p.sliders[k],
  );
}

// Per-building facts pulled once from the parquet (for the hover breakout). The
// live coloring is computed by DuckDB; this mirror lets the popup itemize
// instantly without a round-trip.
export interface BuildingFacts {
  building_id: string;
  building_class: string | null;
  connector_distance_ft: number;
  water_crossings: number;
  rail_crossings: number;
  interstate_crossings: number;
  arterial_crossings: number;
  in_range: boolean;
  bridge_available: boolean;
  nearest_bridge_ft: number | null;
  poi_count: number;
}

/**
 * The §9 closing query, as a literal SQL string for DuckDB-WASM.
 *
 * Numbers are interpolated (all are finite numerics we control — no injection
 * surface). Returns est_cost for EVERY building (no budget filter) so the map
 * can paint the whole cost landscape and apply the budget as a draggable
 * threshold (DESIGN §6.4). `in_range` rides along so the UI can distinguish
 * "implausibly far" from merely "over budget".
 */
export function buildCostSQL(s: Sliders): string {
  const waterCost = s.useBridges
    ? `(CASE WHEN bridge_available THEN ${s.bridgeCost} ELSE ${s.boreCost} END)`
    : `${s.boreCost}`;
  return `
    SELECT building_id,
      connector_distance_ft * ${s.circuity} * ${s.costPerFt}
      + water_crossings      * ${waterCost}
      + rail_crossings       * ${s.railCost}
      + interstate_crossings * ${s.interstateCost}
      + arterial_crossings   * ${s.arterialCost}
      AS est_cost,
      in_range
    FROM buildings`;
}

export interface CostTerm {
  label: string;
  detail: string;
  cost: number;
}

/** JS twin of the closing query, broken into itemized terms for the hover popup. */
export function breakdown(f: BuildingFacts, s: Sliders): { terms: CostTerm[]; total: number } {
  const terms: CostTerm[] = [];

  const distCost = f.connector_distance_ft * s.circuity * s.costPerFt;
  terms.push({
    label: "Connector",
    detail: `${Math.round(f.connector_distance_ft).toLocaleString()} ft × ${s.circuity.toFixed(
      2,
    )} circuity × $${s.costPerFt}/ft`,
    cost: distCost,
  });

  if (f.water_crossings > 0) {
    const perCross = s.useBridges && f.bridge_available ? s.bridgeCost : s.boreCost;
    const viaBridge = s.useBridges && f.bridge_available;
    terms.push({
      label: `Water crossing ×${f.water_crossings}`,
      detail: viaBridge
        ? `bridge nearby — discounted $${perCross.toLocaleString()} ea`
        : `fresh bore $${perCross.toLocaleString()} ea`,
      cost: f.water_crossings * perCross,
    });
  }
  if (f.rail_crossings > 0)
    terms.push({
      label: `Rail crossing ×${f.rail_crossings}`,
      detail: `$${s.railCost.toLocaleString()} ea`,
      cost: f.rail_crossings * s.railCost,
    });
  if (f.interstate_crossings > 0)
    terms.push({
      label: `Interstate crossing ×${f.interstate_crossings}`,
      detail: `$${s.interstateCost.toLocaleString()} ea`,
      cost: f.interstate_crossings * s.interstateCost,
    });
  if (f.arterial_crossings > 0)
    terms.push({
      label: `Arterial crossing ×${f.arterial_crossings}`,
      detail: `$${s.arterialCost.toLocaleString()} ea`,
      cost: f.arterial_crossings * s.arterialCost,
    });

  const total = terms.reduce((a, t) => a + t.cost, 0);
  return { terms, total };
}

export const fmtUSD = (n: number): string =>
  n >= 1000 ? `$${Math.round(n).toLocaleString()}` : `$${n.toFixed(0)}`;

// --- MapLibre paint expressions (the third twin of the formula) --------------
// `est_cost` computed inline from baked footprint PROPERTIES × slider literals,
// so recolor is a single setPaintProperty (no 115k setFeatureState loop). The
// footprint GeoJSON carries: connector_distance_ft (int), {water,rail,interstate,
// arterial}_crossings, bridge_available (bool), in_range (bool).

/** The §9 est_cost as a MapLibre expression over feature properties. */
export function costExpression(s: Sliders): ExpressionSpecification {
  const waterRate: ExpressionSpecification | number = s.useBridges
    ? (["case", ["==", ["get", "bridge_available"], true], s.bridgeCost, s.boreCost] as ExpressionSpecification)
    : s.boreCost;
  return [
    "+",
    ["*", ["get", "connector_distance_ft"], s.circuity * s.costPerFt],
    ["*", ["get", "water_crossings"], waterRate],
    ["*", ["get", "rail_crossings"], s.railCost],
    ["*", ["get", "interstate_crossings"], s.interstateCost],
    ["*", ["get", "arterial_crossings"], s.arterialCost],
  ] as ExpressionSpecification;
}

/** fill-color: gray if implausibly far, else green→yellow→red over [0, budget]. */
export function costColorExpression(s: Sliders): ExpressionSpecification {
  return [
    "case",
    ["==", ["get", "in_range"], false],
    "#9aa0a6",
    [
      "interpolate",
      ["linear"],
      costExpression(s),
      0,
      "#1a9850",
      s.budget * 0.5,
      "#fee08b",
      s.budget,
      "#d73027",
    ],
  ] as ExpressionSpecification;
}

/**
 * fill-opacity: depends only on `in_range` (a baked fact) — NOT on est/sliders.
 * Over-budget buildings already read as the red end of the ramp, so dimming them
 * was redundant; dropping it means `est` is evaluated once (in the color
 * expression) and opacity never needs re-evaluating on a slider change.
 */
export function costOpacityExpression(): ExpressionSpecification {
  return [
    "case",
    ["==", ["get", "in_range"], false],
    0.25,
    0.82,
  ] as ExpressionSpecification;
}
