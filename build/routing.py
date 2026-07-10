"""V2 routed connector — real road-following distance, solved OFFLINE (DESIGN.md §3/§5.4).

Replaces V1's straight-line centroid→corridor connector with an actual shortest path over
the OSM street graph, from each building to the nearest point of the `primary` corridor.

The engine is a SINGLE multi-source Dijkstra from every corridor node: one O(E log V) solve
yields distance-to-corridor for *every* node in the graph, so per-building cost is a dict
lookup, not 115k separate searches. Each building snaps to its nearest graph node; its routed
distance is (centroid→node offset) + (node→corridor graph distance).

Guardrails honored:
  - runs at BUILD TIME only — no browser routing, ever (§10 #3).
  - result feeds the SAME `connector_distance_ft` / `connector_geometry` columns (§3 contract).
  - NEVER null: a building in a disconnected graph component falls back to the V1 straight-line
    connector (an honest lower bound) so the column always has a value.
"""

from __future__ import annotations

import numpy as np
import networkx as nx
import osmnx as ox
import shapely

from . import config as C


def _hw_match(highway, wanted: set[str]) -> bool:
    """OSM `highway` edge tag can be a str or a list (multi-tagged ways)."""
    if isinstance(highway, list):
        return any(h in wanted for h in highway)
    return highway in wanted


def _edge_len_ft(UG, u, v, data) -> float:
    """Edge weight in feet: projected geometry length, else node-to-node euclidean."""
    geom = data.get("geometry")
    if geom is not None:
        return float(geom.length)  # UG is projected to feet (EPSG:2272)
    nu, nv = UG.nodes[u], UG.nodes[v]
    return float(np.hypot(nu["x"] - nv["x"], nu["y"] - nv["y"]))


def route_to_corridor(buildings_2272, road_graph_4326, corridor_2272):
    """Routed connector for every building.

    Args:
        buildings_2272: building GeoDataFrame in EPSG:2272 (feet), index 0..n-1.
        road_graph_4326: osmnx MultiDiGraph (EPSG:4326) with `highway` edge tags.
        corridor_2272: exploded `primary` corridor GeoDataFrame (2272) with `network_id`
                       — used only for the disconnected-component straight-line fallback.

    Returns:
        (dist_ft, polylines, nearest_id, stats)
          dist_ft:    float64 ndarray (n,) — routed feet, never null.
          polylines:  object ndarray (n,) of shapely LineString (2272): centroid→…→corridor.
          nearest_id: object ndarray (n,) of str — corridor node / fallback segment reached.
          stats:      dict with fallback count and graph size.
    """
    n = len(buildings_2272)

    # ---- project graph to feet + build an undirected, weighted copy ------------ #
    # The modeled corridor ignores one-ways, so route on the undirected graph.
    G = ox.project_graph(road_graph_4326, to_crs=C.COMPUTE_CRS)
    UG = ox.convert.to_undirected(G)
    for u, v, data in UG.edges(data=True):
        data["weight"] = _edge_len_ft(UG, u, v, data)

    # ---- corridor target nodes = endpoints of `primary` edges ----------------- #
    corridor_nodes = set()
    for u, v, data in UG.edges(data=True):
        if _hw_match(data.get("highway"), C.CORRIDOR_HIGHWAY):
            corridor_nodes.add(u)
            corridor_nodes.add(v)
    if not corridor_nodes:
        raise RuntimeError(
            "No `primary` edges in the routing graph — cannot target the corridor. "
            "Consider the §4 escape hatch (promote `secondary` into CORRIDOR_HIGHWAY)."
        )

    # ---- ONE multi-source Dijkstra: distance-to-corridor for every node -------- #
    dist_to_corr, paths = nx.multi_source_dijkstra(UG, corridor_nodes, weight="weight")

    # ---- snap each building centroid to its nearest graph node ----------------- #
    cent = buildings_2272.geometry.centroid
    cx = cent.x.to_numpy()
    cy = cent.y.to_numpy()
    snap_nodes, snap_dist = ox.distance.nearest_nodes(G, X=cx, Y=cy, return_dist=True)
    snap_nodes = np.asarray(snap_nodes, dtype=object)
    snap_dist = np.asarray(snap_dist, dtype=float)

    node_xy = {nid: (data["x"], data["y"]) for nid, data in UG.nodes(data=True)}

    # ---- straight-line fallback (disconnected component -> never null) --------- #
    corridor_geoms = corridor_2272.geometry.to_numpy()
    corridor_net_ids = corridor_2272["network_id"].to_numpy()
    ctree = shapely.STRtree(corridor_geoms)

    def _fallback(cent_geom):
        idx = int(ctree.query_nearest(cent_geom, all_matches=False)[0])
        seg = corridor_geoms[idx]
        foot = shapely.line_interpolate_point(seg, shapely.line_locate_point(seg, cent_geom))
        d = float(shapely.distance(cent_geom, foot))
        line = shapely.linestrings([[cent_geom.x, cent_geom.y],
                                     [shapely.get_x(foot), shapely.get_y(foot)]])
        return d, line, str(corridor_net_ids[idx])

    # ---- assemble per-building result ----------------------------------------- #
    dist_ft = np.empty(n, dtype=float)
    polylines = np.empty(n, dtype=object)
    nearest_id = np.empty(n, dtype=object)
    n_fallback = 0
    cent_geoms = cent.to_numpy()

    for i in range(n):
        node = snap_nodes[i]
        d_graph = dist_to_corr.get(node, np.inf)
        if not np.isfinite(d_graph):
            d, line, nid = _fallback(cent_geoms[i])
            dist_ft[i] = d
            polylines[i] = line
            nearest_id[i] = nid
            n_fallback += 1
            continue
        dist_ft[i] = float(snap_dist[i]) + float(d_graph)
        # path is [corridor_node ... snap_node]; walk centroid -> snap_node -> corridor.
        path = paths[node]
        coords = [(cx[i], cy[i])] + [node_xy[nd] for nd in reversed(path)]
        polylines[i] = shapely.linestrings(coords)
        nearest_id[i] = f"node_{path[0]}"

    stats = {
        "graph_nodes": int(UG.number_of_nodes()),
        "graph_edges": int(UG.number_of_edges()),
        "corridor_nodes": int(len(corridor_nodes)),
        "n_fallback": int(n_fallback),
        "fallback_frac": (n_fallback / n) if n else 0.0,
    }
    return dist_ft, polylines, nearest_id, stats
