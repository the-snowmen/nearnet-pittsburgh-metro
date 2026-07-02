import type { Sliders } from "./cost";
import { fmtUSD, PRESETS, matchesPreset } from "./cost";

interface Props {
  sliders: Sliders;
  onChange: (patch: Partial<Sliders>) => void;
}

export function Row({
  label,
  value,
  min,
  max,
  step,
  fmt,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fmt: (n: number) => string;
  onChange: (n: number) => void;
}) {
  return (
    <label className="nn-slider">
      <div className="nn-slider-top">
        <span>{label}</span>
        <b>{fmt(value)}</b>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export default function Controls({ sliders: s, onChange }: Props) {
  return (
    <div className="nn-controls">
      <div className="nn-preset-group" role="group" aria-label="Cost assumption presets">
        <div className="nn-group-h">Assumption preset</div>
        <div className="nn-presets">
          {PRESETS.map((p) => {
            const active = matchesPreset(s, p);
            return (
              <button
                key={p.name}
                type="button"
                className={"nn-preset" + (active ? " active" : "")}
                aria-pressed={active}
                title={p.hint}
                onClick={() => onChange(p.sliders)}
              >
                {p.name}
              </button>
            );
          })}
        </div>
      </div>

      <Row
        label="Extra slack (distance already road-routed)"
        value={s.circuity}
        min={1.0}
        max={1.4}
        step={0.01}
        fmt={(n) => `×${n.toFixed(2)}`}
        onChange={(circuity) => onChange({ circuity })}
      />
      <Row
        label="Cost per foot"
        value={s.costPerFt}
        min={5}
        max={100}
        step={1}
        fmt={(n) => `$${n}/ft`}
        onChange={(costPerFt) => onChange({ costPerFt })}
      />
      <Row
        label="Budget threshold"
        value={s.budget}
        min={10000}
        max={500000}
        step={5000}
        fmt={fmtUSD}
        onChange={(budget) => onChange({ budget })}
      />

      <div className="nn-group-h">Crossing costs (per crossing)</div>
      <Row
        label="Rail (bore under tracks)"
        value={s.railCost}
        min={0}
        max={60000}
        step={1000}
        fmt={fmtUSD}
        onChange={(railCost) => onChange({ railCost })}
      />
      <Row
        label="Water — fresh bore"
        value={s.boreCost}
        min={0}
        max={60000}
        step={1000}
        fmt={fmtUSD}
        onChange={(boreCost) => onChange({ boreCost })}
      />
      <Row
        label="Water — discounted (bridge nearby)"
        value={s.bridgeCost}
        min={0}
        max={40000}
        step={500}
        fmt={fmtUSD}
        onChange={(bridgeCost) => onChange({ bridgeCost })}
      />
      <Row
        label="Interstate / limited-access"
        value={s.interstateCost}
        min={0}
        max={50000}
        step={1000}
        fmt={fmtUSD}
        onChange={(interstateCost) => onChange({ interstateCost })}
      />
      <Row
        label="Arterial (surface major street)"
        value={s.arterialCost}
        min={0}
        max={20000}
        step={500}
        fmt={fmtUSD}
        onChange={(arterialCost) => onChange({ arterialCost })}
      />

      <label className="nn-toggle">
        <input
          type="checkbox"
          checked={s.useBridges}
          onChange={(e) => onChange({ useBridges: e.target.checked })}
        />
        <span>Use bridges as lower-cost river crossings</span>
      </label>
    </div>
  );
}
