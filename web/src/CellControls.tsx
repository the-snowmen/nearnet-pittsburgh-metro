// Cell-layer opinion sliders (V1.5, DESIGN.md §14.9) — the browser half of the
// index: feature weights, normalization method, thresholds, mass↔density. Shown
// only in the Cell-overview altitude. No `$`/cost vocabulary (guardrail #5).

import { Row } from "./Controls";
import type { CellSliders, NormMode, DemandMode } from "./cell";
import { fmtIndex } from "./cell";

interface Props {
  sliders: CellSliders;
  onChange: (patch: Partial<CellSliders>) => void;
  domain: [number, number]; // score range, so the threshold slider tracks the data
}

export default function CellControls({ sliders: s, onChange, domain }: Props) {
  const [lo, hi] = domain[0] < domain[1] ? domain : [-1, 1];
  return (
    <div className="nn-controls">
      <div className="nn-group-h">Opportunity-index weights (opinions)</div>
      <Row
        label="Demand weight"
        value={s.w_poi}
        min={0}
        max={1}
        step={0.05}
        fmt={(n) => `w${n.toFixed(2)}`}
        onChange={(w_poi) => onChange({ w_poi })}
      />
      <Row
        label="Reachability weight (closer = better)"
        value={s.w_dist}
        min={0}
        max={1}
        step={0.05}
        fmt={(n) => `w${n.toFixed(2)}`}
        onChange={(w_dist) => onChange({ w_dist })}
      />
      <Row
        label="Barrier weight (fewer = better)"
        value={s.w_barrier}
        min={0}
        max={1}
        step={0.05}
        fmt={(n) => `w${n.toFixed(2)}`}
        onChange={(w_barrier) => onChange({ w_barrier })}
      />
      <Row
        label="Building-count weight"
        value={s.w_bldg}
        min={0}
        max={1}
        step={0.05}
        fmt={(n) => `w${n.toFixed(2)}`}
        onChange={(w_bldg) => onChange({ w_bldg })}
      />

      <div className="nn-seg" role="group" aria-label="Demand mode">
        <span className="nn-seg-label">Demand</span>
        {(["density", "mass"] as DemandMode[]).map((m) => (
          <button
            key={m}
            type="button"
            className={"nn-seg-btn" + (s.demand_mode === m ? " active" : "")}
            aria-pressed={s.demand_mode === m}
            onClick={() => onChange({ demand_mode: m })}
          >
            {m === "density" ? "Density (per bldg)" : "Mass (sum)"}
          </button>
        ))}
      </div>

      <div className="nn-seg" role="group" aria-label="Normalization method">
        <span className="nn-seg-label">Normalize</span>
        {(["z", "minmax"] as NormMode[]).map((m) => (
          <button
            key={m}
            type="button"
            className={"nn-seg-btn" + (s.norm === m ? " active" : "")}
            aria-pressed={s.norm === m}
            onClick={() => onChange({ norm: m })}
          >
            {m === "z" ? "z-score" : "min-max"}
          </button>
        ))}
      </div>

      <div className="nn-group-h">Screening cuts</div>
      <Row
        label="Show cells with Index ≥"
        value={Math.min(Math.max(s.score_threshold, lo), hi)}
        min={Number(lo.toFixed(2))}
        max={Number(hi.toFixed(2))}
        step={0.05}
        fmt={(n) => `≥ ${fmtIndex(n)}`}
        onChange={(score_threshold) => onChange({ score_threshold })}
      />
      <Row
        label="Thin-cell floor (min buildings)"
        value={s.min_buildings}
        min={1}
        max={25}
        step={1}
        fmt={(n) => `${n}`}
        onChange={(min_buildings) => onChange({ min_buildings })}
      />

      <div className="nn-group-h">Gap-flag cuts (z-score)</div>
      <Row
        label="High demand ≥"
        value={s.g_demand}
        min={0}
        max={3}
        step={0.1}
        fmt={(n) => n.toFixed(1)}
        onChange={(g_demand) => onChange({ g_demand })}
      />
      <Row
        label="High reachability cost ≥"
        value={s.g_cost}
        min={0}
        max={3}
        step={0.1}
        fmt={(n) => n.toFixed(1)}
        onChange={(g_cost) => onChange({ g_cost })}
      />
      <Row
        label="High barrier load ≥"
        value={s.g_barrier}
        min={0}
        max={3}
        step={0.1}
        fmt={(n) => n.toFixed(1)}
        onChange={(g_barrier) => onChange({ g_barrier })}
      />
    </div>
  );
}
