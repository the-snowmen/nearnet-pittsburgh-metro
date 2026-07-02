import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import type { BuildingFacts, Sliders } from "./cost";
import { breakdown, costColorExpression, costOpacityExpression, fmtUSD } from "./cost";
import type { CellRes, CellScore, CellSliders } from "./cell";
import {
  cellBreakdown,
  cellColorExpression,
  cellOpacityExpression,
  fmtIndex,
  gapOutlineExpression,
} from "./cell";
import { getConnector } from "./duck";

export type Altitude = "buildings" | "cells";

// Register the pmtiles:// protocol once so MapLibre can range-read the building tilesets.
maplibregl.addProtocol("pmtiles", new Protocol().tile);

const DATA = "data/"; // relative to the app base; Vite serves web/public/data/*
const pm = (file: string) => `pmtiles://${new URL(DATA + file, document.baseURI).href}`;

// Confluence of the three rivers — the V1 narrative center (DESIGN §7).
const CENTER: [number, number] = [-79.999, 40.4406];
const ZOOM = 13;

// CARTO Positron raster basemap — free, no API key, OSM-derived street detail.
// (PMTiles is the intended production basemap, DESIGN §11; raster keeps the V1
// demo dependency-free and reliable.)
const BASE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    carto: {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png",
        "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png",
        "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png",
      ],
      tileSize: 256,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, © <a href="https://carto.com/attributions">CARTO</a>',
    },
  },
  layers: [{ id: "basemap", type: "raster", source: "carto" }],
  glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
};

interface Props {
  ready: boolean;
  sliders: Sliders;
  facts: Map<string, BuildingFacts> | null;
  // V1.5 cell layer (all no-ops while altitude === "buildings" / cells absent).
  altitude: Altitude;
  cellRes: CellRes;
  cellScores: CellScore[] | null;
  cellSliders: CellSliders;
  colorDomain: [number, number];
  drillCellIds: string[] | null;
  onCellClick: (cellId: string) => void;
  // V2.3 — pinned building id (or null on dismiss) → drives the panel POI dossier.
  onSelectBuilding?: (id: string | null) => void;
  selectedId?: string | null; // controlled: App clearing it (dossier ✕) drops the selection
}

// V2.4 — imperative handle so the dossier's ⤢ "frame" button can re-fit the map
// to the last selection's extent (building footprint + its connector route).
export interface MapViewHandle {
  frameSelection: () => void;
}

// Envelope of the City of Pittsburgh clip (fallback until boundary.geojson loads).
const CITY_BOUNDS: maplibregl.LngLatBoundsLike = [
  [-80.0953, 40.3615],
  [-79.8658, 40.501],
];

/** Compute [[w,s],[e,n]] from a GeoJSON FeatureCollection's coordinates. */
function bboxOf(fc: GeoJSON.FeatureCollection): maplibregl.LngLatBoundsLike {
  let w = 180, s = 90, e = -180, n = -90;
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number") {
      const [lng, lat] = c as number[];
      w = Math.min(w, lng); e = Math.max(e, lng);
      s = Math.min(s, lat); n = Math.max(n, lat);
    } else if (Array.isArray(c)) {
      c.forEach(walk);
    }
  };
  fc.features.forEach((f) => walk((f.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon).coordinates));
  return [[w, s], [e, n]];
}

/** A small "re-center to the project extent" button (MapLibre IControl). */
class RecenterControl implements maplibregl.IControl {
  private onClick: () => void;
  private container?: HTMLDivElement;
  constructor(onClick: () => void) {
    this.onClick = onClick;
  }
  onAdd(): HTMLElement {
    const c = document.createElement("div");
    c.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const b = document.createElement("button");
    b.type = "button";
    b.title = "Re-center to the project extent";
    b.setAttribute("aria-label", "Re-center to the project extent");
    b.innerHTML = "⤢";
    b.style.fontSize = "16px";
    b.onclick = this.onClick;
    c.appendChild(b);
    this.container = c;
    return c;
  }
  onRemove(): void {
    this.container?.remove();
  }
}

// Itemized screening-estimate popup HTML (shared by hover preview + click pin).
function popupHTML(fct: BuildingFacts, s: Sliders): string {
  const { terms, total } = breakdown(fct, s);
  const reachable = fct.in_range && total <= s.budget;
  const status = !fct.in_range
    ? `<span class="nn-bad">beyond plausible service distance</span>`
    : reachable
      ? `<span class="nn-good">within budget</span>`
      : `<span class="nn-warn">over budget</span>`;
  const rows = terms
    .map(
      (t) =>
        `<div class="nn-row"><span>${t.label}<br><em>${t.detail}</em></span><b>${fmtUSD(
          t.cost,
        )}</b></div>`,
    )
    .join("");
  return `<div class="nn-pop">
       <div class="nn-pop-h">Screening estimate ${status}</div>
       ${rows}
       <div class="nn-row nn-total"><span>Estimated cost</span><b>${fmtUSD(total)}</b></div>
       <div class="nn-pop-meta">${fct.building_class ?? "building"} · ${fct.poi_count} POI${
         fct.poi_count === 1 ? "" : "s"
       }${fct.bridge_available ? " · bridge nearby" : ""}</div>
       <div class="nn-pop-foot">Modeled lower-bound screen — not a build cost.</div>
     </div>`;
}

// Cell hover breakout — the four index terms, honestly labeled (§14.11). The
// index is UNITLESS (never dollars); gray cells are excluded, never "score 0".
function cellPopupHTML(c: CellScore, s: CellSliders): string {
  const { terms } = cellBreakdown(c, s);
  const rows = terms
    .map(
      (t) =>
        `<div class="nn-row"><span>${t.label}<br><em>${t.detail}</em></span><b>${t.contribution >= 0 ? "+" : ""}${t.contribution.toFixed(
          2,
        )}</b></div>`,
    )
    .join("");
  const gap = c.is_gap
    ? `<div class="nn-pop-gap">gap: high modeled demand + high reachability cost / barriers — screening candidate, not a confirmed prospect</div>`
    : "";
  return `<div class="nn-pop">
       <div class="nn-pop-h">Opportunity index <b class="nn-idx">${fmtIndex(c.opportunity_index)}</b></div>
       ${rows}
       <div class="nn-row nn-total"><span>Index (Σ terms)</span><b>${fmtIndex(c.opportunity_index)}</b></div>
       ${gap}
       <div class="nn-pop-meta">${c.building_count.toLocaleString()} buildings · ${c.poi_count_sum.toLocaleString()} modeled POI signal</div>
       <div class="nn-pop-foot">Unitless weighted screening index — <b>not dollars</b>. Click to drill into its buildings.</div>
     </div>`;
}

const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

// Straight-line FALLBACK connector from a feature's cx,cy → nx,ny props (nx,ny is
// the corridor endpoint). Shown instantly on hover until the real routed polyline
// (V2, fetched from connectors.parquet) resolves.
function connectorFC(p: GeoJSON.GeoJsonProperties): GeoJSON.FeatureCollection {
  if (!p || p.nx == null || p.ny == null || p.cx == null || p.cy == null) return EMPTY_FC;
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: [[+p.cx, +p.cy], [+p.nx, +p.ny]] },
      },
    ],
  };
}

// Wrap a baked routed-connector GeoJSON geometry string (V2) into a FeatureCollection.
function routedConnectorFC(gj: string): GeoJSON.FeatureCollection {
  try {
    const geom = JSON.parse(gj) as GeoJSON.Geometry;
    return { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: geom }] };
  } catch {
    return EMPTY_FC;
  }
}

const MapView = forwardRef<MapViewHandle, Props>(function MapView({
  ready,
  sliders,
  facts,
  altitude,
  cellRes,
  cellScores,
  cellSliders,
  colorDomain,
  drillCellIds,
  onCellClick,
  onSelectBuilding,
  selectedId,
}: Props, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const loadedRef = useRef(false);
  const slidersRef = useRef<Sliders>(sliders);
  const factsRef = useRef<Map<string, BuildingFacts> | null>(facts);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const hoverIdRef = useRef<string | null>(null);
  const pinnedIdRef = useRef<string | null>(null);
  const pinnedPropsRef = useRef<GeoJSON.GeoJsonProperties>(null);
  const boundsRef = useRef<maplibregl.LngLatBoundsLike>(CITY_BOUNDS);
  // V2.4 — last selection's extent (building + connector) for the ⤢ frame button.
  const selBoundsRef = useRef<maplibregl.LngLatBoundsLike | null>(null);
  // Touch devices have no hover → suppress the hover popup so a tap doesn't flash it
  // (tap = select → dossier). `click` still fires for both mouse and touch.
  const hoverCapableRef = useRef(
    typeof window !== "undefined" && window.matchMedia("(hover: hover)").matches,
  );
  const repaintTimer = useRef<number | undefined>(undefined);
  // Cell-layer refs (read by event handlers without re-binding on every change).
  const altitudeRef = useRef<Altitude>(altitude);
  const cellSlidersRef = useRef<CellSliders>(cellSliders);
  const cellScoreMapRef = useRef<Map<string, CellScore>>(new Map());
  const onCellClickRef = useRef(onCellClick);
  const onSelectBuildingRef = useRef(onSelectBuilding);
  const [zoom, setZoom] = useState<number>(ZOOM);

  slidersRef.current = sliders;
  factsRef.current = facts;
  altitudeRef.current = altitude;
  cellSlidersRef.current = cellSliders;
  onCellClickRef.current = onCellClick;
  onSelectBuildingRef.current = onSelectBuilding;

  // Padding keeps the selection out from under the occluding panel: on desktop the
  // panel covers the left edge; on mobile the bottom sheet covers the lower half.
  const selectionPadding = () =>
    window.innerWidth < 720
      ? { top: 60, right: 20, bottom: Math.round(window.innerHeight * 0.45), left: 20 }
      : { top: 60, right: 40, bottom: 40, left: 400 };

  // Fit the map to the last selection's extent (building + its connector route).
  const fitSelection = () => {
    const map = mapRef.current;
    if (!map || !selBoundsRef.current) return;
    map.fitBounds(selBoundsRef.current, { padding: selectionPadding(), maxZoom: 17, duration: 700 });
  };

  useImperativeHandle(ref, () => ({ frameSelection: fitSelection }), []);

  // App cleared the selection (dossier ✕ / Esc / empty-map click) → drop the map
  // route + outline to stay in sync. (Selecting an id is driven by a map click.)
  useEffect(() => {
    if (selectedId != null) return;
    pinnedIdRef.current = null;
    pinnedPropsRef.current = null;
    selBoundsRef.current = null;
    const map = mapRef.current;
    if (map && loadedRef.current && !hoverIdRef.current) {
      map.setFilter("buildings-outline", ["==", ["get", "building_id"], ""]);
      (map.getSource("hoverconn") as maplibregl.GeoJSONSource | undefined)?.setData(EMPTY_FC);
    }
  }, [selectedId]);

  // --- one-time map construction -------------------------------------------
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASE_STYLE,
      center: CENTER,
      zoom: ZOOM,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    (window as unknown as { __nnMap?: maplibregl.Map }).__nnMap = map; // test/debug hook
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    map.addControl(
      new RecenterControl(() =>
        map.fitBounds(boundsRef.current, { padding: 40, duration: 700 }),
      ),
      "top-left",
    );
    map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-left");
    // Live zoom readout — current dots(<12) vs footprints(≥12) breakpoint is at z12.
    setZoom(map.getZoom());
    map.on("zoom", () => setZoom(map.getZoom()));

    popupRef.current = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      maxWidth: "320px",
      className: "nn-popup",
    });

    map.on("load", () => {
      // Attribution collapsed by default (compact ⓘ; expands on click).
      map.getContainer().querySelector(".maplibregl-ctrl-attrib")?.removeAttribute("open");
      // Barrier centerlines (the obstacles) — drawn under the corridor + buildings.
      map.addSource("water", { type: "geojson", data: DATA + "barriers_water.geojson" });
      map.addSource("rail", { type: "geojson", data: DATA + "barriers_rail.geojson" });
      map.addSource("interstate", { type: "geojson", data: DATA + "barriers_interstate.geojson" });
      map.addSource("arterial", { type: "geojson", data: DATA + "barriers_arterial.geojson" });
      map.addSource("network", { type: "geojson", data: DATA + "network.geojson" });
      map.addSource("bridges", { type: "geojson", data: DATA + "bridges.geojson" });
      map.addSource("boundary", { type: "geojson", data: DATA + "boundary.geojson" });
      // Buildings as PMTiles vector tiles (range-served, lazy by view): centroid
      // points carry the overview cost surface (fast); footprint polygons fade in
      // when zoomed in. Both layers' features expose the same fact properties.
      map.addSource("points", { type: "vector", url: pm("points.pmtiles") });
      map.addSource("footprints", { type: "vector", url: pm("footprints.pmtiles") });
      // Hovered building's routed connector to the corridor (V2 polyline from
      // connectors.parquet; straight cx,cy→nx,ny fallback until it resolves).
      map.addSource("hoverconn", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      // Barriers share a DASHED language (obstacle) so they read distinctly from
      // the SOLID network/corridor; color still separates the four tiers.
      map.addLayer({
        id: "water-l",
        type: "line",
        source: "water",
        paint: { "line-color": "#3b82c4", "line-width": 2.6, "line-dasharray": [4, 2], "line-opacity": 0.8 },
      });
      map.addLayer({
        id: "rail-l",
        type: "line",
        source: "rail",
        paint: { "line-color": "#7a5c3e", "line-width": 2, "line-dasharray": [2, 2], "line-opacity": 0.8 },
      });
      map.addLayer({
        id: "interstate-l",
        type: "line",
        source: "interstate",
        paint: { "line-color": "#e8833a", "line-width": 2.2, "line-dasharray": [5, 2], "line-opacity": 0.7 },
      });
      map.addLayer({
        id: "arterial-l",
        type: "line",
        source: "arterial",
        paint: { "line-color": "#c99a00", "line-width": 1.6, "line-dasharray": [1, 2], "line-opacity": 0.6 },
      });

      // Cost surface — centroid DOTS at overview zooms (fast recolor + smooth pan).
      map.addLayer({
        id: "buildings-pts",
        type: "circle",
        source: "points",
        "source-layer": "buildings_pts",
        maxzoom: 12,
        paint: {
          "circle-color": costColorExpression(slidersRef.current),
          "circle-opacity": costOpacityExpression(),
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 1.3, 11, 2.4, 12, 3.6],
        },
      });
      // Cost surface — footprint POLYGONS when zoomed in (z12+).
      map.addLayer({
        id: "buildings-fill",
        type: "fill",
        source: "footprints",
        "source-layer": "buildings",
        minzoom: 12,
        paint: {
          // fill-color is the only est/slider-dependent prop (updated on settle);
          // fill-opacity is in_range-only (static), so it's set once here.
          "fill-color": costColorExpression(slidersRef.current),
          "fill-opacity": costOpacityExpression(),
        },
      });
      // Outline drawn for the HOVERED footprint only (filtered to one feature).
      map.addLayer({
        id: "buildings-outline",
        type: "line",
        source: "footprints",
        "source-layer": "buildings",
        minzoom: 12,
        filter: ["==", ["get", "building_id"], ""],
        paint: { "line-color": "#111", "line-width": 2 },
      });

      // Modeled fiber corridor (the network) — emphasized above the cost surface.
      map.addLayer({
        id: "network-l",
        type: "line",
        source: "network",
        // SOLID + thick + full opacity: the corridor is the hero "route" line.
        paint: { "line-color": "#0a9396", "line-width": 3, "line-opacity": 0.95 },
      });
      // Bridges — potential lower-cost crossings.
      map.addLayer({
        id: "bridges-l",
        type: "line",
        source: "bridges",
        paint: { "line-color": "#9b5de5", "line-width": 3, "line-opacity": 0.8 },
      });
      // Connector for the hovered building (V2 routed polyline; straight-line fallback).
      map.addLayer({
        id: "connectors-l",
        type: "line",
        source: "hoverconn",
        paint: { "line-color": "#111", "line-width": 2, "line-dasharray": [1.5, 1] },
      });

      // Project extent — City of Pittsburgh clip outline (topmost, non-interactive).
      map.addLayer({
        id: "boundary-l",
        type: "line",
        source: "boundary",
        paint: {
          "line-color": "#1b2733",
          "line-width": 2.5,
          "line-opacity": 0.85,
          "line-dasharray": [3, 2],
        },
      });
      // --- V1.5 opportunity-index cell layer (§14.11) — hidden until opted in. ---
      // Hex geometry loads once with promoteId "cell_id" so each scoring result
      // sets {score,hot,gap} per cell via feature-state; the fill reads them.
      map.addSource("cells", {
        type: "geojson",
        data: DATA + `cells_r${cellRes}.geojson`,
        promoteId: "cell_id",
      });
      map.addLayer({
        id: "cells-fill",
        type: "fill",
        source: "cells",
        layout: { visibility: "none" },
        paint: {
          "fill-color": cellColorExpression(colorDomain),
          "fill-opacity": cellOpacityExpression(),
        },
      });
      map.addLayer({
        id: "cells-outline",
        type: "line",
        source: "cells",
        layout: { visibility: "none" },
        paint: { "line-color": "#6a5acd", "line-width": 0.5, "line-opacity": 0.35 },
      });
      map.addLayer({
        id: "cells-gap",
        type: "line",
        source: "cells",
        layout: { visibility: "none" },
        paint: { "line-color": "#e63946", "line-width": 1.8, "line-opacity": gapOutlineExpression() },
      });

      // Real bounds for the re-center button (fallback to the envelope on failure).
      fetch(DATA + "boundary.geojson")
        .then((r) => r.json())
        .then((fc: GeoJSON.FeatureCollection) => {
          boundsRef.current = bboxOf(fc);
        })
        .catch(() => {});

      loadedRef.current = true;
      repaintCost();
      attachHover();
      attachCellHover();
    });
  }, []);

  // --- recolor the cost surface --------------------------------------------
  // est_cost is computed inside the MapLibre paint expression from the tiled
  // feature properties × slider values. With vector tiles only the visible tiles'
  // features are re-evaluated, so this is fast; we still debounce lightly to
  // coalesce a drag into one repaint. Updates both the dot (overview) and the
  // footprint (zoomed-in) cost layers.
  function repaintCost() {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const expr = costColorExpression(slidersRef.current);
    map.setPaintProperty("buildings-pts", "circle-color", expr);
    map.setPaintProperty("buildings-fill", "fill-color", expr);
  }

  useEffect(() => {
    window.clearTimeout(repaintTimer.current);
    repaintTimer.current = window.setTimeout(repaintCost, 120);
    return () => window.clearTimeout(repaintTimer.current);
  }, [sliders]);

  // --- hover preview + click-to-pin -----------------------------------------
  function attachHover() {
    const map = mapRef.current!;
    const hoverPopup = popupRef.current!;

    // connector + footprint outline follow a building id. V2: show the straight-line
    // fallback (from props) instantly, then upgrade to the real routed polyline once
    // getConnector resolves — race-guarded so a stale fetch can't clobber a newer hover.
    const highlight = (id: string, props: GeoJSON.GeoJsonProperties) => {
      map.setFilter("buildings-outline", ["==", ["get", "building_id"], id || ""]);
      const src = map.getSource("hoverconn") as maplibregl.GeoJSONSource;
      if (!id) {
        src.setData(EMPTY_FC);
        return;
      }
      src.setData(connectorFC(props)); // instant straight-line fallback
      getConnector(id)
        .then((gj) => {
          if (!gj) return;
          if (hoverIdRef.current !== id && pinnedIdRef.current !== id) return; // target moved on
          src.setData(routedConnectorFC(gj));
        })
        .catch(() => {});
    };
    // when the cursor leaves, fall back to the pinned building (or nothing)
    const restoreToPinned = () =>
      pinnedIdRef.current
        ? highlight(pinnedIdRef.current, pinnedPropsRef.current)
        : highlight("", null);

    const onMove = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f || !f.properties) return;
      const p = f.properties;
      const id = String(p.building_id);
      map.getCanvas().style.cursor = "pointer";
      if (hoverIdRef.current !== id) {
        hoverIdRef.current = id;
        highlight(id, p);
      }
      // Touch: no hover popup (a tap selects → the panel dossier is the detail surface).
      if (!hoverCapableRef.current) return;
      const fct = factsRef.current?.get(id);
      if (fct)
        hoverPopup.setLngLat(e.lngLat).setHTML(popupHTML(fct, slidersRef.current)).addTo(map);
    };

    const onLeave = () => {
      map.getCanvas().style.cursor = "";
      hoverIdRef.current = null;
      hoverPopup.remove();
      restoreToPinned();
    };

    // V2.4 — a click SELECTS (opens the panel dossier); it no longer drops a sticky
    // popup. It keeps the route drawn (pinnedIdRef) and fits the map to the
    // building + its connector, stored so the dossier's ⤢ can re-frame it later.
    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f || !f.properties) return;
      const p = f.properties;
      const id = String(p.building_id);
      const fct = factsRef.current?.get(id);
      if (!fct) return;
      pinnedIdRef.current = id;
      pinnedPropsRef.current = p;
      highlight(id, p);
      // Extent = the clicked footprint/point geometry + its straight-line connector
      // (both available synchronously; the async routed line is a later nicety).
      const fc: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: {}, geometry: f.geometry }, ...connectorFC(p).features],
      };
      selBoundsRef.current = bboxOf(fc);
      fitSelection();
      onSelectBuildingRef.current?.(id); // open the panel POI dossier
    };

    // Clear the selection (route + outline + dossier) from state.
    const clearSelection = () => {
      pinnedIdRef.current = null;
      pinnedPropsRef.current = null;
      selBoundsRef.current = null;
      if (!hoverIdRef.current) highlight("", null);
      onSelectBuildingRef.current?.(null); // close the dossier
    };

    // hover + click work on whichever surface is active: dots or footprints.
    for (const lyr of ["buildings-pts", "buildings-fill"]) {
      map.on("mousemove", lyr, onMove);
      map.on("mouseleave", lyr, onLeave);
      map.on("click", lyr, onClick);
    }
    // Click on empty map (no building under the cursor) clears the selection.
    map.on("click", (e) => {
      if (!map.queryRenderedFeatures(e.point, { layers: ["buildings-pts", "buildings-fill"] }).length)
        clearSelection();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && pinnedIdRef.current) clearSelection();
    });
  }

  // --- V1.5 cell layer: feature-state, hover, and altitude wiring ------------

  // Push the latest scoring result into MapLibre feature-state. Cells NOT in the
  // result (below the min-buildings floor) get no state → the paint falls through
  // to neutral gray (never "score 0"). MapLibre clears feature-state on a source
  // reload, so this is re-run after any r8⇄r9 setData too.
  function applyCellState(scores: CellScore[] | null, threshold: number) {
    const map = mapRef.current;
    if (!map || !loadedRef.current || !map.getSource("cells")) return;
    map.removeFeatureState({ source: "cells" });
    const m = new Map<string, CellScore>();
    for (const c of scores ?? []) {
      m.set(c.cell_id, c);
      map.setFeatureState(
        { source: "cells", id: c.cell_id },
        { scored: true, score: c.opportunity_index, hot: c.opportunity_index >= threshold, gap: c.is_gap },
      );
    }
    cellScoreMapRef.current = m;
  }

  function attachCellHover() {
    const map = mapRef.current!;
    const hoverPopup = popupRef.current!;
    const onMove = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      map.getCanvas().style.cursor = "pointer";
      const c = cellScoreMapRef.current.get(String(f.id));
      if (c) hoverPopup.setLngLat(e.lngLat).setHTML(cellPopupHTML(c, cellSlidersRef.current)).addTo(map);
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = "";
      hoverPopup.remove();
    };
    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const cellId = String(f.id);
      const c = cellScoreMapRef.current.get(cellId);
      if (c) map.flyTo({ center: [c.centroid_lon, c.centroid_lat], zoom: 14, duration: 800 });
      onCellClickRef.current(cellId);
    };
    map.on("mousemove", "cells-fill", onMove);
    map.on("mouseleave", "cells-fill", onLeave);
    map.on("click", "cells-fill", onClick);
  }

  // Altitude toggle: show the cell choropleth (+ hide the V1 cost surface) or the
  // reverse. Barriers / network / bridges / boundary stay as shared context.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const cellVis = altitude === "cells" ? "visible" : "none";
    const bldgVis = altitude === "cells" ? "none" : "visible";
    for (const l of ["cells-fill", "cells-outline", "cells-gap"]) {
      if (map.getLayer(l)) map.setLayoutProperty(l, "visibility", cellVis);
    }
    for (const l of ["buildings-pts", "buildings-fill"]) {
      if (map.getLayer(l)) map.setLayoutProperty(l, "visibility", bldgVis);
    }
    popupRef.current?.remove();
  }, [altitude, ready]);

  // New scores (slider/resolution change) → re-apply feature-state + recolor the
  // ramp domain. Scores CHANGE with the sliders (unlike V1, where only the color
  // mapping changes), so paint + state are driven from the same effect.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    applyCellState(cellScores, cellSliders.score_threshold);
    if (map.getLayer("cells-fill")) {
      map.setPaintProperty("cells-fill", "fill-color", cellColorExpression(colorDomain));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellScores, colorDomain, cellSliders.score_threshold]);

  // r8 ⇄ r9: swap the hex geometry, then re-apply feature-state once it reloads
  // (feature-state is cleared on setData). App has already re-scored for cellRes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const src = map.getSource("cells") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(DATA + `cells_r${cellRes}.geojson`);
    const reapply = (e: maplibregl.MapSourceDataEvent) => {
      if (e.sourceId === "cells" && e.isSourceLoaded) {
        applyCellState(cellScores, cellSliders.score_threshold);
        map.off("sourcedata", reapply);
      }
    };
    map.on("sourcedata", reapply);
    return () => {
      map.off("sourcedata", reapply);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellRes]);

  // Drill-down: filter the V1 building layers to a clicked cell's building_ids
  // (computed via h3-js in App). null → clear the filter (all buildings return).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const filter = drillCellIds
      ? (["in", ["get", "building_id"], ["literal", drillCellIds]] as maplibregl.FilterSpecification)
      : null;
    for (const l of ["buildings-pts", "buildings-fill"]) {
      if (map.getLayer(l)) map.setFilter(l, filter);
    }
  }, [drillCellIds]);

  return (
    <div className="nn-map-wrap">
      <div
        ref={containerRef}
        className="nn-map"
        role="application"
        aria-label="Pittsburgh near-net cost-screen map. Hover or click a building for its estimated connection cost."
      />
      {!ready && <div className="nn-map-loading">Loading modeled facts…</div>}
      <div className="nn-zoom" aria-live="off" title="Current map zoom level">
        z {zoom.toFixed(1)}
      </div>
    </div>
  );
});

export default MapView;
