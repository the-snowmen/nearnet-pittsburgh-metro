import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLIDERS,
  breakdown,
  buildCostSQL,
  costColorExpression,
  matchesPreset,
  PRESETS,
  type BuildingFacts,
} from "./cost";

const facts: BuildingFacts = {
  building_id: "sample",
  building_class: null,
  connector_distance_ft: 1_000.4,
  water_crossings: 1,
  rail_crossings: 2,
  interstate_crossings: 1,
  arterial_crossings: 3,
  in_range: true,
  bridge_available: true,
  nearest_bridge_ft: 25,
  poi_count: 0,
};

describe("cost model", () => {
  it("keeps the default assumptions aligned with the Typical preset", () => {
    expect(matchesPreset(DEFAULT_SLIDERS, PRESETS[1])).toBe(true);
  });

  it("uses the nearby-bridge rate and itemizes each crossing type", () => {
    const result = breakdown(facts, DEFAULT_SLIDERS);

    expect(result.terms.map(({ label }) => label)).toEqual([
      "Connector",
      "Water crossing ×1",
      "Rail crossing ×2",
      "Interstate crossing ×1",
      "Arterial crossing ×3",
    ]);
    expect(result.total).toBe(30_000 + 5_000 + 50_000 + 15_000 + 9_000);
  });

  it("uses the fresh-bore rate when bridge discounting is disabled", () => {
    const result = breakdown(facts, { ...DEFAULT_SLIDERS, useBridges: false });
    expect(result.total).toBe(30_000 + 20_000 + 50_000 + 15_000 + 9_000);
  });

  it("passes the same assumptions into the SQL and map-color expressions", () => {
    const sql = buildCostSQL(DEFAULT_SLIDERS);
    expect(sql).toContain("connector_distance_ft * 1 * 30");
    expect(sql).toContain("CASE WHEN bridge_available THEN 5000 ELSE 20000 END");
    expect(JSON.stringify(costColorExpression(DEFAULT_SLIDERS))).toContain("100000");
  });
});
