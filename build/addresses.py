"""Nearest-address bake for the building dossier (additive, removable).

Emits ``web/public/data/building_address.parquet``: one row per building,
``building_id`` + ``address`` (the nearest real address point's "number street",
snapped within a small radius). The dossier shows it under the building title and the
KMZ balloon carries it. A building has **no single authoritative address** (its tenants
have varied suite/street addresses), so this is a **best-match model** — labeled
"nearest address (approx)" in the UI.

Source: **OpenStreetMap** ``addr:housenumber`` / ``addr:street`` tags (community-sourced,
authoritative — not the noisy POI addresses). NOTE: the Overture *addresses* theme is
empty for Pittsburgh in the pinned release, so OSM is the address source of record here.

STANDALONE & removable, same additive contract as ``build/pois.py`` /
``footprints.parquet``: reads the cached authoritative buildings + a fresh OSM address
fetch, writes one new web asset. Deleting it leaves the app fully working (the dossier
simply shows no address).

Run inside the ``nearnet`` env:  ``python -m build.addresses``
"""

from __future__ import annotations

import geopandas as gpd
import osmnx as ox
import pandas as pd

from . import config as C

WEB_DATA = C.REPO_ROOT / "web" / "public" / "data"

# An OSM address tag usually sits on/at the building; polygons make sjoin_nearest
# distance 0 for a contained point, so this only bounds "no address near this building".
ADDR_SNAP_FT = 100.0


def _addr_str(number, street) -> str | None:
    parts = [
        str(number).strip() if pd.notna(number) else "",
        str(street).strip() if pd.notna(street) else "",
    ]
    s = " ".join(p for p in parts if p)
    return s or None


def build_building_address() -> pd.DataFrame:
    """Snap the nearest OSM address to each building; return building_id + address."""
    C.ensure_dirs()

    buildings = gpd.read_parquet(C.CACHE_DIR / "buildings.parquet").to_crs(C.COMPUTE_CRS)
    buildings = buildings[["building_id", "geometry"]].reset_index(drop=True)

    city = gpd.read_parquet(C.CACHE_DIR / "clip.parquet").to_crs(C.DISPLAY_CRS)
    poly = city.geometry.union_all()

    print("  fetching OSM addresses ...")
    feats = ox.features_from_polygon(poly, tags={"addr:housenumber": True})
    if "addr:housenumber" not in feats.columns:
        return pd.DataFrame(columns=["building_id", "address"])
    street_col = feats["addr:street"] if "addr:street" in feats.columns else pd.Series(index=feats.index, dtype=object)
    feats = feats.assign(_num=feats["addr:housenumber"], _st=street_col)
    feats = feats[feats["_num"].notna()].reset_index(drop=True)
    print(f"  OSM features with a house number: {len(feats):,}")
    if feats.empty:
        return pd.DataFrame(columns=["building_id", "address"])

    # Mixed point/polygon geometries -> a representative point per feature (in 4326),
    # then compose the address string and project to compute CRS.
    addrs = gpd.GeoDataFrame(
        {"address": [_addr_str(n, s) for n, s in zip(feats["_num"], feats["_st"])]},
        geometry=feats.geometry.representative_point(),
        crs=C.DISPLAY_CRS,
    )
    addrs = addrs[addrs["address"].notna()].to_crs(C.COMPUTE_CRS).reset_index(drop=True)

    # Each building -> its single nearest address point (<= ADDR_SNAP_FT).
    joined = buildings.sjoin_nearest(
        addrs, how="left", max_distance=ADDR_SNAP_FT, distance_col="snap_ft"
    )
    snapped = joined.dropna(subset=["address"])
    # equidistant ties emit multiple rows -> keep the single nearest per building
    snapped = snapped.sort_values("snap_ft").drop_duplicates(subset=["building_id"], keep="first")

    out = pd.DataFrame({
        "building_id": snapped["building_id"].astype(str),
        "address": snapped["address"],
    }).sort_values("building_id").reset_index(drop=True)
    return out


def main() -> None:
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    df = build_building_address()
    out = WEB_DATA / "building_address.parquet"
    df.to_parquet(out, compression="zstd", index=False)
    size_mb = out.stat().st_size / 1e6
    n_total = 115914  # full-city building count (for the coverage line)
    pct = (len(df) / n_total * 100) if n_total else 0
    print(f"building_address.parquet  : {len(df):,} buildings with an address "
          f"({pct:.0f}% coverage) -> {out.name} ({size_mb:.2f} MB)")


if __name__ == "__main__":
    main()
