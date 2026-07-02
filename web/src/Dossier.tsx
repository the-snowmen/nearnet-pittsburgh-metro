import type { BuildingFacts, POI, Sliders } from "./cost";
import { breakdown, fmtUSD } from "./cost";

interface Props {
  facts: BuildingFacts | null;
  pois: POI[] | null; // null = still loading
  sliders: Sliders; // V2.4 — for the itemized cost card (absorbs the old click popup)
  onClear: () => void;
  onFrame?: () => void; // V2.4 — re-fit the map to this building + its route
}

const prettyType = (c: string | null) => (c ? c.replace(/_/g, " ") : "");

// V2.3/V2.4 — building "dossier": the clicked building (parent), its itemized
// screening estimate, and its child POIs (public Overture listings). Rendered in
// the panel when a building is selected. The click popup is gone (V2.4), so this
// is now the per-building detail surface — and a keyboard-reachable one.
export default function Dossier({ facts, pois, sliders, onClear, onFrame }: Props) {
  const cls = facts?.building_class ?? "building";
  const count = facts?.poi_count ?? 0;

  // Itemized cost, mirroring the old popup's semantics (§9 twin via breakdown()).
  const cost = facts ? breakdown(facts, sliders) : null;
  const reachable = facts ? facts.in_range && (cost?.total ?? 0) <= sliders.budget : false;
  const status = !facts
    ? null
    : !facts.in_range
      ? { cls: "nn-bad", text: "beyond range (~4,000 ft)" }
      : reachable
        ? { cls: "nn-good", text: "reachable — within budget" }
        : { cls: "nn-warn", text: "over budget" };

  return (
    <div className="nn-dossier" role="region" aria-label="Selected building detail">
      <div className="nn-dossier-head">
        <div>
          <div className="nn-dossier-kicker">Selected building</div>
          <div className="nn-dossier-title">{cls}</div>
        </div>
        <div className="nn-dossier-actions">
          {onFrame && (
            <button
              type="button"
              className="nn-dossier-frame"
              aria-label="Zoom to this building and its route"
              title="Zoom to this building and its route"
              onClick={onFrame}
            >
              ⤢
            </button>
          )}
          <button
            type="button"
            className="nn-dossier-close"
            aria-label="Clear selection"
            onClick={onClear}
          >
            ✕
          </button>
        </div>
      </div>

      {facts && cost && status && (
        <div className="nn-dossier-cost">
          <div className="nn-dossier-cost-status">
            Screening estimate <span className={status.cls}>{status.text}</span>
          </div>
          {cost.terms.map((t) => (
            <div className="nn-row" key={t.label}>
              <span>
                {t.label}
                <br />
                <em>{t.detail}</em>
              </span>
              <b>{fmtUSD(t.cost)}</b>
            </div>
          ))}
          <div className="nn-row nn-total">
            <span>Estimated cost</span>
            <b>{fmtUSD(cost.total)}</b>
          </div>
          <div className="nn-dossier-cost-foot">Modeled lower-bound screen — not a build cost.</div>
        </div>
      )}

      <div className="nn-dossier-sub">
        {count} public {count === 1 ? "listing" : "listings"} snapped to this building
      </div>

      {pois === null ? (
        <div className="nn-dossier-empty">Loading listings…</div>
      ) : pois.length === 0 ? (
        <div className="nn-dossier-empty">No public listings snapped to this building.</div>
      ) : (
        <ul className="nn-dossier-list">
          {pois.map((p) => {
            const where = [p.address, p.locality].filter(Boolean).join(", ");
            return (
              <li key={p.poi_id} className="nn-dossier-poi">
                <div className="nn-poi-name">{p.name ?? "—"}</div>
                {p.category && <div className="nn-poi-type">{prettyType(p.category)}</div>}
                {(p.phone || where) && (
                  <div className="nn-poi-meta">
                    {p.phone && <a href={`tel:${p.phone}`}>{p.phone}</a>}
                    {p.phone && where && <span aria-hidden="true"> · </span>}
                    {where && <span>{where}</span>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="nn-dossier-foot">
        Public Overture listings — coverage varies (~93% have a phone), each nearest-building
        snapped. A modeled signal, not verified tenants or customers.
      </div>
    </div>
  );
}
