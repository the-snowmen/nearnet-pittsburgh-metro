import type { BuildingFacts, POI } from "./cost";

interface Props {
  facts: BuildingFacts | null;
  pois: POI[] | null; // null = still loading
  onClear: () => void;
}

const prettyType = (c: string | null) => (c ? c.replace(/_/g, " ") : "");

// V2.3 — building "dossier": the clicked building (parent) and its child POIs
// (public Overture listings). Rendered in the panel (buildings mode) when a
// building is pinned. A React surface → also keyboard-reachable once shown.
export default function Dossier({ facts, pois, onClear }: Props) {
  const cls = facts?.building_class ?? "building";
  const count = facts?.poi_count ?? 0;
  return (
    <div className="nn-dossier" role="region" aria-label="Selected building detail">
      <div className="nn-dossier-head">
        <div>
          <div className="nn-dossier-kicker">Selected building</div>
          <div className="nn-dossier-title">{cls}</div>
        </div>
        <button type="button" className="nn-dossier-close" aria-label="Clear selection" onClick={onClear}>
          ✕
        </button>
      </div>
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
