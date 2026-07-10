import { useEffect, useRef, useState } from "react";
import { unzipSync, strFromU8 } from "fflate";
import type { BuildingFacts, POI, Sliders } from "./cost";
import { breakdown, fmtUSD } from "./cost";
import {
  getExportBuilding,
  getFootprint,
  getBuildingExportPois,
  getConnector,
} from "./duck";
import { buildKMZ, downloadBytes, exportName } from "./export";

interface Props {
  facts: BuildingFacts | null;
  pois: POI[] | null; // null = still loading
  sliders: Sliders; // V2.4 — for the itemized cost card (absorbs the old click popup)
  address?: string | null; // nearest baked Overture address (approximate); null until 1.1c ships
  onClear: () => void;
  onFrame?: () => void; // V2.4 — re-fit the map to this building + its route
}

const prettyType = (c: string | null) => (c ? c.replace(/_/g, " ") : "");

// V2.3/V2.4 — building "dossier": the clicked building (parent), its itemized
// screening estimate, and its child POIs (public Overture listings). Rendered in
// the panel when a building is selected. The click popup is gone (V2.4), so this
// is now the per-building detail surface — and a keyboard-reachable one.
export default function Dossier({ facts, pois, sliders, address, onClear, onFrame }: Props) {
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

  // --- click-to-copy (phone / address) with brief per-item confirmation --------
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const doCopy = (text: string, key: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(null), 1400);
    });
  };

  // DEV-only verification hook (stripped from prod): build the KMZ for the selected
  // building and return its unzipped structure. window.__nnKmz().
  useEffect(() => {
    if (!import.meta.env.DEV || !facts) return;
    const id = facts.building_id;
    (window as unknown as { __nnKmz?: unknown }).__nnKmz = async () => {
      const [b, fp, epois, conn] = await Promise.all([
        getExportBuilding(sliders, id),
        getFootprint(id),
        getBuildingExportPois(id),
        getConnector(id),
      ]);
      const bytes = await buildKMZ(
        {
          buildings: b ? [b] : [],
          pois: epois,
          footprints: fp ? [{ building_id: id, geojson: fp }] : [],
          connectors: conn ? [{ building_id: id, geojson: conn }] : [],
          address: address ?? null,
          sliders,
        },
        { buildings: true, pois: epois.length > 0, routes: !!conn },
      );
      const files = unzipSync(bytes);
      const kml = strFromU8(files["doc.kml"]);
      return {
        id,
        kmzBytes: bytes.length,
        files: Object.keys(files),
        folders: (kml.match(/<Folder>/g) || []).length,
        polygons: (kml.match(/<Polygon>/g) || []).length,
        points: (kml.match(/<Point>/g) || []).length,
        lineStrings: (kml.match(/<LineString>/g) || []).length,
        hasLegend: kml.includes("<ScreenOverlay>"),
        addressInDoc: address ? kml.includes(address) : null,
        poiCount: epois.length,
      };
    };
  });

  // --- ⤓ export THIS building as a KMZ (footprint + listings + route) ----------
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const onExport = async () => {
    if (!facts) return;
    const id = facts.building_id;
    setExporting(true);
    setExportNote(null);
    try {
      const [b, fp, epois, conn] = await Promise.all([
        getExportBuilding(sliders, id),
        getFootprint(id),
        getBuildingExportPois(id),
        getConnector(id),
      ]);
      if (!b) {
        setExportNote("Export failed.");
        return;
      }
      const bytes = await buildKMZ(
        {
          buildings: [b],
          pois: epois,
          footprints: fp ? [{ building_id: id, geojson: fp }] : [],
          connectors: conn ? [{ building_id: id, geojson: conn }] : [],
          address: address ?? null,
          sliders,
        },
        { buildings: true, pois: epois.length > 0, routes: !!conn },
      );
      downloadBytes(
        exportName(`building-${id.slice(0, 8)}`, "kmz", sliders),
        "application/vnd.google-earth.kmz",
        bytes,
      );
      setExportNote("Downloaded ✓");
    } catch (e) {
      console.error("KMZ export failed:", e);
      setExportNote("Export failed — see console.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="nn-dossier" role="region" aria-label="Selected building detail">
      <div className="nn-sr-only" role="status" aria-live="polite">
        {copied ? "Copied to clipboard" : ""}
      </div>
      <div className="nn-dossier-head">
        <div className="nn-dossier-headmain">
          <div className="nn-dossier-kicker">Selected building</div>
          <div className="nn-dossier-title">{cls}</div>
          {address && (
            <button
              type="button"
              className="nn-copy nn-dossier-addr"
              title="Copy address"
              aria-label={`Copy address ${address}`}
              onClick={() => doCopy(address, "bldg")}
            >
              {copied === "bldg" ? "✓ Copied" : address}
              <span className="nn-addr-note"> · nearest address (approx)</span>
            </button>
          )}
        </div>
        <div className="nn-dossier-actions">
          <button
            type="button"
            className="nn-dossier-export"
            aria-label="Download this building as a KMZ for Google Earth"
            title="Download KMZ (Google Earth)"
            disabled={exporting}
            onClick={onExport}
          >
            ⤓
          </button>
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

      {(exporting || exportNote) && (
        <div className="nn-dossier-exportnote" role="status" aria-live="polite">
          {exporting ? "Preparing KMZ…" : exportNote}
        </div>
      )}

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
          <div className="nn-dossier-cost-foot">Modeled lower-bound screen — not a quote.</div>
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
                {p.phone && (
                  <div className="nn-poi-meta">
                    <a href={`tel:${p.phone}`}>{p.phone}</a>
                    <button
                      type="button"
                      className="nn-copy-ic"
                      title="Copy phone"
                      aria-label={`Copy phone ${p.phone}`}
                      onClick={() => doCopy(p.phone!, p.poi_id + ":ph")}
                    >
                      {copied === p.poi_id + ":ph" ? "✓" : "⧉"}
                    </button>
                  </div>
                )}
                {where && (
                  <div className="nn-poi-addr">
                    <button
                      type="button"
                      className="nn-copy"
                      title="Copy address"
                      aria-label={`Copy address ${where}`}
                      onClick={() => doCopy(where, p.poi_id + ":ad")}
                    >
                      {copied === p.poi_id + ":ad" ? "✓ Copied" : where}
                    </button>
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
