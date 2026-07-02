// Ranked opportunity list (V1.5, DESIGN.md §14.11) — one card per scored hex,
// raw feature values + the unitless Index, sortable, gap rows badged. Row click
// drills into that cell's buildings (same path as the map click). A card list
// (not a wide table) so the whole thing fits the narrow panel with no horizontal
// scroll; each card is a <button> → keyboard-focusable. Never banned vocab (§14.4).

import { useMemo, useState } from "react";
import type { CellScore } from "./cell";
import { fmtIndex } from "./cell";

type SortKey =
  | "opportunity_index"
  | "poi_count_sum"
  | "conn_dist_median_ft"
  | "total_crossings_mean"
  | "building_count";

interface Props {
  scores: CellScore[] | null;
  onRowClick: (cellId: string) => void;
  cap?: number; // DOM cap; r9 (~1.5k rows) is trimmed with a note
}

const SORTS: { key: SortKey; label: string }[] = [
  { key: "opportunity_index", label: "Index" },
  { key: "poi_count_sum", label: "POI signal" },
  { key: "conn_dist_median_ft", label: "Median distance" },
  { key: "total_crossings_mean", label: "Barriers / bldg" },
  { key: "building_count", label: "Building count" },
];

export default function CellTable({ scores, onRowClick, cap = 300 }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("opportunity_index");
  const [dir, setDir] = useState<"asc" | "desc">("desc");

  const sorted = useMemo(() => {
    const rows = [...(scores ?? [])];
    rows.sort((a, b) => (dir === "desc" ? b[sortKey] - a[sortKey] : a[sortKey] - b[sortKey]));
    return rows;
  }, [scores, sortKey, dir]);

  if (!scores || scores.length === 0) {
    return <div className="nn-cell-table-empty">No cells meet the current floor / weights.</div>;
  }

  const shown = sorted.slice(0, cap);

  return (
    <div className="nn-cell-table">
      <div className="nn-rank-bar">
        <div className="nn-cell-table-h">Ranked cells ({sorted.length.toLocaleString()})</div>
        <div className="nn-rank-sort">
          <label>
            Sort
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="nn-rank-dir"
            aria-label={dir === "desc" ? "Sorted high to low — click for low to high" : "Sorted low to high — click for high to low"}
            onClick={() => setDir((d) => (d === "desc" ? "asc" : "desc"))}
          >
            {dir === "desc" ? "▾" : "▴"}
          </button>
        </div>
      </div>

      <div className="nn-rank-list">
        {shown.map((c) => (
          <button
            key={c.cell_id}
            type="button"
            className={"nn-rank-item" + (c.is_gap ? " gap" : "")}
            onClick={() => onRowClick(c.cell_id)}
            title="Drill into this cell's buildings"
          >
            <span className="nn-rank-idx">
              {c.is_gap && (
                <span
                  className="nn-gap-badge"
                  title="high modeled demand but high reachability cost / barriers — screening candidate, not a confirmed prospect"
                >
                  gap
                </span>
              )}
              {fmtIndex(c.opportunity_index)}
            </span>
            <span className="nn-rank-stats">
              <span><em>POI</em> {c.poi_count_sum.toLocaleString()}</span>
              <span><em>dist</em> {Math.round(c.conn_dist_median_ft).toLocaleString()} ft</span>
              <span><em>barr</em> {c.total_crossings_mean.toFixed(2)}</span>
              <span><em>bldgs</em> {c.building_count.toLocaleString()}</span>
            </span>
          </button>
        ))}
      </div>

      {sorted.length > cap && (
        <div className="nn-cell-table-note">
          showing top {cap.toLocaleString()} of {sorted.length.toLocaleString()} — narrow with the
          weights / floor
        </div>
      )}
    </div>
  );
}
