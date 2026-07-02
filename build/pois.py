"""V2.3 — per-building POI detail bake (additive, removable).

Emits ``web/public/data/pois.parquet``: one row per whitelisted Overture place
snapped to its nearest building (``building_id`` FK), carrying name / type / phone /
address for the click-to-expand building **dossier**. Parent = building, children = POIs.

STANDALONE by design: it reuses the cached authoritative buildings + a fresh Overture
places fetch, and does **not** touch the V2 building / connector / cell / tile assets.
Deleting ``pois.parquet`` leaves the app fully working (same additive contract as
connectors / cells).

Honesty (DESIGN §9 / §14.11, docs/POI_CATEGORIES.md): these are **real public**
Overture listings — coverage varies (~92% have a phone), each **nearest-building
snapped** (not authoritative geocoding). A modeled tenant-density signal, **never**
verified tenants / customers / demand.

Run inside the ``nearnet`` env:  ``python -m build.pois``
"""

from __future__ import annotations

import geopandas as gpd
import pandas as pd

from . import config as C
from . import sources
from .geometry import snap_places_to_buildings

WEB_DATA = C.REPO_ROOT / "web" / "public" / "data"


def build_poi_detail() -> pd.DataFrame:
    """Snap whitelisted places to buildings and return the flat detail table."""
    C.ensure_dirs()

    # Buildings: reuse the cached authoritative footprints (no re-fetch, no rebuild).
    buildings = gpd.read_parquet(C.CACHE_DIR / "buildings.parquet").to_crs(C.COMPUTE_CRS)
    buildings = buildings[["building_id", "geometry"]].reset_index(drop=True)

    # Places: fetch fresh WITH detail (the cache predates the name/phone/address
    # columns), then clip points to the City of Pittsburgh polygon.
    city = gpd.read_parquet(C.CACHE_DIR / "clip.parquet").to_crs(C.DISPLAY_CRS)
    bbox = sources._bbox_from_polygon(city)
    print("  fetching Overture places (with detail) ...")
    places = sources.fetch_overture_places(bbox)
    poly = city.geometry.union_all()
    places = places[places.intersects(poly)].reset_index(drop=True)

    category_map = sources.fetch_overture_category_map()
    snapped, stats = snap_places_to_buildings(buildings, places, category_map)
    print(f"  places: {stats['places_total']:,} total / "
          f"{stats['places_whitelisted']:,} whitelisted / {stats['places_snapped']:,} snapped")
    if snapped.empty:
        return pd.DataFrame(
            columns=["poi_id", "building_id", "name", "category", "phone",
                     "address", "locality", "lon", "lat"]
        )

    snapped = snapped.to_crs(C.DISPLAY_CRS)  # back to lon/lat for the browser
    out = pd.DataFrame({
        "poi_id": snapped["place_id"].astype(str),
        "building_id": snapped["building_id"].astype(str),
        "name": snapped["name"],
        "category": snapped["category"],   # leaf type, e.g. "pizza_restaurant"
        "phone": snapped["phone"],
        "address": snapped["address"],
        "locality": snapped["locality"],
        "lon": snapped.geometry.x.round(6),
        "lat": snapped.geometry.y.round(6),
    })
    # Stable order: group a building's children together, then by name.
    return out.sort_values(["building_id", "name"], na_position="last").reset_index(drop=True)


def main() -> None:
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    df = build_poi_detail()
    out = WEB_DATA / "pois.parquet"
    df.to_parquet(out, compression="zstd", index=False)
    size_mb = out.stat().st_size / 1e6
    n_bldg = df["building_id"].nunique() if not df.empty else 0
    print(f"pois.parquet : {len(df):,} POIs across {n_bldg:,} buildings "
          f"-> {out} ({size_mb:.2f} MB)")


if __name__ == "__main__":
    main()
