import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import type { BuildingFacts, Sliders } from "./cost";
import { breakdown, costColorExpression, costOpacityExpression, fmtUSD } from "./cost";

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

const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

// Build the centroid → corridor connector line from a feature's cx,cy → nx,ny props.
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

export default function MapView({ ready, sliders, facts }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const loadedRef = useRef(false);
  const slidersRef = useRef<Sliders>(sliders);
  const factsRef = useRef<Map<string, BuildingFacts> | null>(facts);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const pinPopupRef = useRef<maplibregl.Popup | null>(null);
  const hoverIdRef = useRef<string | null>(null);
  const pinnedIdRef = useRef<string | null>(null);
  const pinnedPropsRef = useRef<GeoJSON.GeoJsonProperties>(null);
  const boundsRef = useRef<maplibregl.LngLatBoundsLike>(CITY_BOUNDS);
  const repaintTimer = useRef<number | undefined>(undefined);

  slidersRef.current = sliders;
  factsRef.current = facts;

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

    popupRef.current = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      maxWidth: "320px",
      className: "nn-popup",
    });
    pinPopupRef.current = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      maxWidth: "320px",
      className: "nn-popup nn-popup-pin",
    });

    map.on("load", () => {
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
      // Hovered building's connector to the corridor, built in JS from cx,cy → nx,ny.
      map.addSource("hoverconn", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.addLayer({
        id: "water-l",
        type: "line",
        source: "water",
        paint: { "line-color": "#3b82c4", "line-width": 2.5, "line-opacity": 0.7 },
      });
      map.addLayer({
        id: "rail-l",
        type: "line",
        source: "rail",
        paint: { "line-color": "#7a5c3e", "line-width": 1.6, "line-dasharray": [2, 2], "line-opacity": 0.7 },
      });
      map.addLayer({
        id: "interstate-l",
        type: "line",
        source: "interstate",
        paint: { "line-color": "#e8833a", "line-width": 2, "line-opacity": 0.55 },
      });
      map.addLayer({
        id: "arterial-l",
        type: "line",
        source: "arterial",
        paint: { "line-color": "#d9b500", "line-width": 1.4, "line-opacity": 0.45 },
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
        paint: { "line-color": "#0a9396", "line-width": 2.4, "line-opacity": 0.9 },
      });
      // Bridges — potential lower-cost crossings.
      map.addLayer({
        id: "bridges-l",
        type: "line",
        source: "bridges",
        paint: { "line-color": "#9b5de5", "line-width": 3, "line-opacity": 0.8 },
      });
      // Connector for the hovered building (built in JS from cx,cy → nx,ny).
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
    // keep a pinned popup's itemized numbers in sync with the sliders
    if (pinnedIdRef.current) {
      const fct = factsRef.current?.get(pinnedIdRef.current);
      if (fct) pinPopupRef.current?.setHTML(popupHTML(fct, slidersRef.current));
    }
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
    const pinPopup = pinPopupRef.current!;

    // connector + footprint outline follow a building id (props carry the line ends)
    const highlight = (id: string, props: GeoJSON.GeoJsonProperties) => {
      map.setFilter("buildings-outline", ["==", ["get", "building_id"], id || ""]);
      (map.getSource("hoverconn") as maplibregl.GeoJSONSource).setData(
        id ? connectorFC(props) : EMPTY_FC,
      );
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
      pinPopup.setLngLat(e.lngLat).setHTML(popupHTML(fct, slidersRef.current)).addTo(map);
    };

    // pin dismissed (✕ / Esc / empty-map click) -> clear state + highlight
    pinPopup.on("close", () => {
      pinnedIdRef.current = null;
      pinnedPropsRef.current = null;
      if (!hoverIdRef.current) highlight("", null);
    });

    // hover + click work on whichever surface is active: dots or footprints.
    for (const lyr of ["buildings-pts", "buildings-fill"]) {
      map.on("mousemove", lyr, onMove);
      map.on("mouseleave", lyr, onLeave);
      map.on("click", lyr, onClick);
    }
    map.on("click", (e) => {
      if (!map.queryRenderedFeatures(e.point, { layers: ["buildings-pts", "buildings-fill"] }).length)
        pinPopup.remove();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") pinPopup.remove();
    });
  }

  return (
    <div className="nn-map-wrap">
      <div
        ref={containerRef}
        className="nn-map"
        role="application"
        aria-label="Pittsburgh near-net cost-screen map. Hover or click a building for its estimated connection cost."
      />
      {!ready && <div className="nn-map-loading">Loading modeled facts…</div>}
    </div>
  );
}
