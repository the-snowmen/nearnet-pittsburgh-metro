// Ranked opportunity table (V1.5, DESIGN.md §14.11) — one row per scored hex,
// raw feature values + the unitless Index, click-to-sort, gap rows badged. Row
// click drills into that cell's buildings (same path as the map click). The
// table is the borrowed MCDA mechanic done honestly; never banned vocabulary (§14.4).

import { useMemo, useState } from "react";
import type { CellScore } from "./cell";
import { fmtIndex } from "./cell";

type SortKey = "opportunity_index" | "poi_count_sum" | "conn_dist_median_ft" | "total_crossings_mean" | "building_count";

interface Props {
  scores: CellScore[] | null;
  onRowClick: (cellId: string) => void;
  cap?: number; // DOM cap; r9 (~1.5k rows) is trimmed with a note
}

const COLS: { key: SortKey; label: string; fmt: (c: CellScore) => string }[] = [
  { key: "opportunity_index", label: "Index", fmt: (c) => fmtIndex(c.opportunity_index) },
  { key: "poi_count_sum", label: "POI", fmt: (c) => c.poi_count_sum.toLocaleString() },
  { key: "conn_dist_median_ft", label: "Med. dist", fmt: (c) => `${Math.round(c.conn_dist_median_ft).toLocaleString()} ft` },
  { key: "total_crossings_mean", label: "Barr./bldg", fmt: (c) => c.total_crossings_mean.toFixed(2) },
  { key: "building_count", label: "Bldgs", fmt: (c) => c.building_count.toLocaleString() },
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
  const clickSort = (k: SortKey) => {
    if (k === sortKey) setDir((d) => (d === "desc" ? "asc" : "desc"));
    else {
      setSortKey(k);
      setDir("desc");
    }
  };

  return (
    <div className="nn-cell-table">
      <div className="nn-cell-table-h">Ranked cells ({sorted.length.toLocaleString()})</div>
      <div className="nn-cell-table-scroll">
        <table>
          <thead>
            <tr>
              {COLS.map((c) => (
                <th
                  key={c.key}
                  className={"sortable" + (sortKey === c.key ? ` sorted-${dir}` : "")}
                  onClick={() => clickSort(c.key)}
                  title="Click to sort"
                >
                  {c.label}
                  {sortKey === c.key ? (dir === "desc" ? " ▾" : " ▴") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <tr
                key={c.cell_id}
                className={c.is_gap ? "gap" : ""}
                onClick={() => onRowClick(c.cell_id)}
                title="Drill into this cell's buildings"
              >
                {COLS.map((col) => (
                  <td key={col.key} className={col.key === "opportunity_index" ? "idx" : ""}>
                    {col.key === "opportunity_index" && c.is_gap ? (
                      <span className="nn-gap-badge" title="high modeled demand but high reachability cost / barriers — screening candidate, not a confirmed prospect">
                        gap
                      </span>
                    ) : null}
                    {col.fmt(c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
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
