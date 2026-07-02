// Per-building KMZ export (Google Earth). Pure builders over the DuckDB rows
// (duck.ts), no React. 100% client-side / backend-free.
//
// Data honesty (CLAUDE.md / DESIGN §10): filename + Document name say "modeled
// screening estimate", never "fiber"/"conduit"/"build cost" (except the negating
// disclaimer). Geometry is public open-data footprints + routed connectors; POIs are
// a modeled tenant-density signal, never verified tenants.

import { zipSync, strToU8 } from "fflate";
import { breakdown, fmtUSD, type Sliders, type BuildingFacts } from "./cost";
import type { ExportBuilding, ExportPoi, ExportGeom } from "./duck";

const DISCLAIMER =
  "MODELED SCREENING ESTIMATE — a lower-bound screen built entirely from public open " +
  "data + general telecom domain knowledge (fiber follows road right-of-way). Distances " +
  "are road-routed offline (EPSG:2272, US survey feet). NOT real fiber, NOT operator data, " +
  "NOT a build cost or quote. Listings are public Overture places (nearest-building snapped) " +
  "— a modeled tenant-density signal, not verified tenants/customers.";

// ---- shared helpers ---------------------------------------------------------

const iso = (): string => new Date().toISOString().slice(0, 10);
const kBudget = (s: Sliders): string => `${Math.round(s.budget / 1000)}k`;

/** Filename stem — always self-labels the model + assumptions. */
export function exportName(kind: string, ext: string, s: Sliders): string {
  return `nearnet-pgh_modeled-screening_${kind}_budget-${kBudget(s)}_${iso()}.${ext}`;
}

/** A one-line summary of the cost assumptions baked into an export. */
function assumptionLine(s: Sliders): string {
  return (
    `budget ${fmtUSD(s.budget)} · $${s.costPerFt}/ft · circuity ${s.circuity.toFixed(2)} · ` +
    `bore ${fmtUSD(s.boreCost)} · bridge ${s.useBridges ? fmtUSD(s.bridgeCost) : "off"} · ` +
    `rail ${fmtUSD(s.railCost)} · interstate ${fmtUSD(s.interstateCost)} · arterial ${fmtUSD(s.arterialCost)}`
  );
}

const asFacts = (b: ExportBuilding): BuildingFacts => ({
  building_id: b.building_id,
  building_class: b.building_class,
  connector_distance_ft: b.connector_distance_ft,
  water_crossings: b.water_crossings,
  rail_crossings: b.rail_crossings,
  interstate_crossings: b.interstate_crossings,
  arterial_crossings: b.arterial_crossings,
  in_range: b.in_range,
  bridge_available: b.bridge_available,
  nearest_bridge_ft: null,
  poi_count: b.poi_count,
});

// ---- download helper --------------------------------------------------------

export function downloadBytes(filename: string, mime: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- KML / KMZ --------------------------------------------------------------

type Geom = { type: string; coordinates: unknown };

function safeParse(gj: string): Geom | null {
  try {
    return JSON.parse(gj) as Geom;
  } catch {
    return null;
  }
}

const RAMP: [number, string][] = [
  [0, "#1a9850"],
  [0.5, "#fee08b"],
  [1, "#d73027"],
];
const N_BUCKETS = 12;
const POI_HEX = "#0a9396"; // teal, distinct from the cost ramp
const ROUTE_HEX = "#5b4a8a";

function lerpHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const mix = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return "#" + mix.map((v) => v.toString(16).padStart(2, "0")).join("");
}

function rampColor(t: number): string {
  const c = Math.max(0, Math.min(1, t));
  return c <= 0.5
    ? lerpHex(RAMP[0][1], RAMP[1][1], c / 0.5)
    : lerpHex(RAMP[1][1], RAMP[2][1], (c - 0.5) / 0.5);
}

const bucketOf = (est: number, budget: number): number =>
  Math.max(0, Math.min(N_BUCKETS - 1, Math.floor((est / Math.max(1, budget)) * N_BUCKETS)));

/** KML color is aabbggrr (alpha, blue, green, red) — the reverse of #rrggbb + alpha. */
function kmlColor(hex: string, alpha = 255): string {
  const h = hex.replace("#", "");
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return alpha.toString(16).padStart(2, "0") + b + g + r;
}

function xml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const cdata = (s: string): string => `<![CDATA[${s.replace(/]]>/g, "]]&gt;")}]]>`;

// GeoJSON coordinate arrays → KML coordinate strings (lon,lat,0). --------------
const ring = (coords: number[][]): string =>
  coords.map((c) => `${c[0]},${c[1]},0`).join(" ");

function kmlPolygon(coords: number[][][]): string {
  const [outer, ...holes] = coords;
  const inner = holes
    .map((h) => `<innerBoundaryIs><LinearRing><coordinates>${ring(h)}</coordinates></LinearRing></innerBoundaryIs>`)
    .join("");
  return (
    `<Polygon><outerBoundaryIs><LinearRing><coordinates>${ring(outer)}</coordinates></LinearRing>` +
    `</outerBoundaryIs>${inner}</Polygon>`
  );
}

/** KML geometry for a parsed GeoJSON geometry (Polygon/MultiPolygon/LineString/MultiLineString/Point). */
function geojsonToKml(g: Geom | null): string {
  if (!g) return "";
  const c = g.coordinates as any;
  switch (g.type) {
    case "Point":
      return `<Point><coordinates>${c[0]},${c[1]},0</coordinates></Point>`;
    case "Polygon":
      return kmlPolygon(c as number[][][]);
    case "MultiPolygon":
      return `<MultiGeometry>${(c as number[][][][]).map(kmlPolygon).join("")}</MultiGeometry>`;
    case "LineString":
      return `<LineString><tessellate>1</tessellate><coordinates>${ring(c as number[][])}</coordinates></LineString>`;
    case "MultiLineString":
      return (
        `<MultiGeometry>` +
        (c as number[][][])
          .map((l) => `<LineString><tessellate>1</tessellate><coordinates>${ring(l)}</coordinates></LineString>`)
          .join("") +
        `</MultiGeometry>`
      );
    default:
      return "";
  }
}

// Balloon HTML — the same itemized cost card as the in-app dossier. -----------
function balloonHtml(b: ExportBuilding, s: Sliders, address: string | null): string {
  const { terms, total } = breakdown(asFacts(b), s);
  const rows = terms
    .map(
      (t) =>
        `<tr><td>${xml(t.label)}<br><small style="color:#666">${xml(t.detail)}</small></td>` +
        `<td style="text-align:right">${xml(fmtUSD(t.cost))}</td></tr>`,
    )
    .join("");
  return (
    `<div style="font-family:sans-serif;max-width:280px">` +
    `<b>${xml(b.building_class ?? "Building")}</b> — reachable (within budget)<br>` +
    (address ? `<span style="color:#555">${xml(address)}</span><br>` : "") +
    `<table style="border-collapse:collapse;width:100%;margin:6px 0">${rows}` +
    `<tr><td><b>Total (modeled screening estimate)</b></td>` +
    `<td style="text-align:right"><b>${xml(fmtUSD(total))}</b></td></tr></table>` +
    `${b.poi_count} listing(s) on this building.` +
    `<div style="color:#999;font-size:11px;margin-top:6px">Modeled screening estimate — not a build cost.</div>` +
    `</div>`
  );
}

function extData(pairs: [string, unknown][]): string {
  return (
    `<ExtendedData>` +
    pairs.map(([k, v]) => `<Data name="${xml(k)}"><value>${xml(v)}</value></Data>`).join("") +
    `</ExtendedData>`
  );
}

// ---- canvas assets (bundled into the .kmz, so it stays self-contained) ------

async function canvasBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  if (!blob) return new Uint8Array();
  return new Uint8Array(await blob.arrayBuffer());
}

/** A soft white dot — tinted per-feature by KML <IconStyle><color> (teal for listings). */
async function dotPng(): Promise<Uint8Array> {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 32;
  const ctx = cv.getContext("2d")!;
  ctx.beginPath();
  ctx.arc(16, 16, 12, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();
  return canvasBytes(cv);
}

/** The floating legend image (ScreenOverlay) — mirrors the on-screen legend. */
async function legendPng(s: Sliders): Promise<Uint8Array> {
  const W = 190;
  const H = 132;
  const dpr = 2;
  const cv = document.createElement("canvas");
  cv.width = W * dpr;
  cv.height = H * dpr;
  const ctx = cv.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#d8d2c8";
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  ctx.fillStyle = "#1b2733";
  ctx.font = "bold 12px sans-serif";
  ctx.fillText("Estimated connection cost", 12, 20);
  const gx = 12;
  const gy = 30;
  const gw = W - 24;
  const grad = ctx.createLinearGradient(gx, 0, gx + gw, 0);
  grad.addColorStop(0, RAMP[0][1]);
  grad.addColorStop(0.5, RAMP[1][1]);
  grad.addColorStop(1, RAMP[2][1]);
  ctx.fillStyle = grad;
  ctx.fillRect(gx, gy, gw, 12);
  ctx.fillStyle = "#444";
  ctx.font = "10px sans-serif";
  ctx.fillText("$0", gx, gy + 26);
  ctx.fillText(fmtUSD(s.budget / 2), gx + gw / 2 - 18, gy + 26);
  ctx.fillText("≥ " + fmtUSD(s.budget), gx + gw - 52, gy + 26);
  let y = gy + 44;
  ctx.fillStyle = POI_HEX;
  ctx.beginPath();
  ctx.arc(gx + 5, y - 3, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1b2733";
  ctx.fillText("Listing (modeled signal)", gx + 16, y);
  y += 18;
  ctx.strokeStyle = ROUTE_HEX;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(gx, y - 4);
  ctx.lineTo(gx + 12, y - 4);
  ctx.stroke();
  ctx.fillStyle = "#1b2733";
  ctx.fillText("Modeled connector route", gx + 16, y);
  return canvasBytes(cv);
}

// ---- the KMZ builder --------------------------------------------------------

export interface KmzLayers {
  buildings: boolean;
  pois: boolean;
  routes: boolean;
}

/** Build the styled, legended, self-documenting .kmz for the given building set
 *  (typically one building + its listings + its route). Reused for any count. */
export async function buildKMZ(
  data: {
    buildings: ExportBuilding[];
    pois: ExportPoi[];
    footprints: ExportGeom[];
    connectors: ExportGeom[];
    address: string | null;
    sliders: Sliders;
  },
  layers: KmzLayers,
): Promise<Uint8Array> {
  const { sliders: s } = data;
  const footMap = new Map(data.footprints.map((f) => [f.building_id, f.geojson]));
  const usePolygons = footMap.size > 0;

  const b = layers.buildings ? data.buildings : [];
  const p = layers.pois ? data.pois : [];
  const r = layers.routes ? data.connectors : [];

  // Styles: N cost buckets + POI + route. Polygons fill+outline; points tint the dot.
  const styles: string[] = [];
  for (let i = 0; i < N_BUCKETS; i++) {
    const hex = rampColor((i + 0.5) / N_BUCKETS);
    styles.push(
      usePolygons
        ? `<Style id="b${i}"><LineStyle><color>${kmlColor(hex)}</color><width>1</width></LineStyle>` +
            `<PolyStyle><color>${kmlColor(hex, 0xb3)}</color></PolyStyle></Style>`
        : `<Style id="b${i}"><IconStyle><color>${kmlColor(hex)}</color><scale>0.9</scale>` +
            `<Icon><href>files/dot.png</href></Icon></IconStyle></Style>`,
    );
  }
  styles.push(
    `<Style id="poi"><IconStyle><color>${kmlColor(POI_HEX)}</color><scale>0.7</scale>` +
      `<Icon><href>files/dot.png</href></Icon></IconStyle></Style>`,
    `<Style id="route"><LineStyle><color>${kmlColor(ROUTE_HEX)}</color><width>2</width></LineStyle></Style>`,
  );

  const bFolder = b.length
    ? `<Folder><name>Building — modeled screening estimate</name>` +
      b
        .map((bld) => {
          const geom = usePolygons
            ? geojsonToKml(
                safeParse(footMap.get(bld.building_id) ?? "") ?? {
                  type: "Point",
                  coordinates: [bld.centroid_lon, bld.centroid_lat],
                },
              )
            : `<Point><coordinates>${bld.centroid_lon},${bld.centroid_lat},0</coordinates></Point>`;
          return (
            `<Placemark><name>${xml(bld.building_class ?? "Building")} · ${xml(fmtUSD(bld.est_cost))}</name>` +
            `<styleUrl>#b${bucketOf(bld.est_cost, s.budget)}</styleUrl>` +
            `<description>${cdata(balloonHtml(bld, s, data.address))}</description>` +
            extData([
              ["building_id", bld.building_id],
              ["building_class", bld.building_class],
              ["address_modeled", data.address],
              ["est_cost_usd_modeled_screening", Math.round(bld.est_cost)],
              ["connector_distance_ft", Math.round(bld.connector_distance_ft)],
              ["water_crossings", bld.water_crossings],
              ["rail_crossings", bld.rail_crossings],
              ["interstate_crossings", bld.interstate_crossings],
              ["arterial_crossings", bld.arterial_crossings],
              ["bridge_available", bld.bridge_available],
              ["poi_count", bld.poi_count],
            ]) +
            geom +
            `</Placemark>`
          );
        })
        .join("") +
      `</Folder>`
    : "";

  const pFolder = layers.pois && p.length
    ? `<Folder><name>Listings — modeled tenant-density signal (${p.length})</name>` +
      `<description>${cdata("Real public Overture listings, nearest-building snapped — a modeled tenant-density signal, NOT verified tenants/customers.")}</description>` +
      p
        .map(
          (poi) =>
            `<Placemark><name>${xml(poi.name ?? "Listing")}</name><styleUrl>#poi</styleUrl>` +
            `<description>${cdata(
              `<b>${xml(poi.name ?? "Listing")}</b><br>${xml(poi.category ?? "")}<br>` +
                (poi.phone ? `<a href="tel:${xml(poi.phone)}">${xml(poi.phone)}</a><br>` : "") +
                `${xml(poi.address ?? "")}${poi.locality ? ", " + xml(poi.locality) : ""}`,
            )}</description>` +
            extData([
              ["poi_id", poi.poi_id],
              ["building_id", poi.building_id],
              ["category", poi.category],
              ["phone", poi.phone],
              ["address", poi.address],
              ["locality", poi.locality],
            ]) +
            `<Point><coordinates>${poi.lon},${poi.lat},0</coordinates></Point></Placemark>`,
        )
        .join("") +
      `</Folder>`
    : "";

  const rFolder = layers.routes && r.length
    ? `<Folder><name>Modeled connector route</name>` +
      r
        .map(
          (route) =>
            `<Placemark><styleUrl>#route</styleUrl>` +
            extData([["building_id", route.building_id]]) +
            geojsonToKml(safeParse(route.geojson)) +
            `</Placemark>`,
        )
        .join("") +
      `</Folder>`
    : "";

  const legend =
    `<ScreenOverlay><name>Legend</name><Icon><href>files/legend.png</href></Icon>` +
    `<overlayXY x="0" y="0" xunits="fraction" yunits="fraction"/>` +
    `<screenXY x="12" y="12" xunits="pixels" yunits="pixels"/>` +
    `<size x="0" y="0" xunits="pixels" yunits="pixels"/></ScreenOverlay>`;

  const docDesc =
    DISCLAIMER + "\n\nCost assumptions used for this export: " + assumptionLine(s) + `\nGenerated ${iso()}.`;

  const kml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
    `<name>near-net Pittsburgh — MODELED SCREENING ESTIMATE</name>` +
    `<description>${cdata(docDesc)}</description>` +
    styles.join("") +
    legend +
    bFolder +
    pFolder +
    rFolder +
    `</Document></kml>`;

  // Assemble the .kmz (a zip; doc.kml at root + bundled assets under files/).
  const files: Record<string, Uint8Array> = { "doc.kml": strToU8(kml) };
  files["files/legend.png"] = await legendPng(s);
  files["files/dot.png"] = await dotPng();
  return zipSync(files, { level: 6 });
}
