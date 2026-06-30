# POI category whitelist — the opportunity signal (`poi_count`)

This file is the **tunable source of truth** for which Overture *places* count toward
`poi_count` (the per-building tenant-density / opportunity signal). `docs/DESIGN.md` §9
references it; the build step (`build/precompute.py`) reads this policy.

## What `poi_count` measures
`poi_count` = number of **whitelisted** Overture places **assigned to a building** via
nearest-building assignment (each POI → its single nearest footprint within a max snap
distance, ~100–150 ft, Phase-0-tuned). This guarantees one-POI-one-building (no
double-counting) and is robust to Overture geocoding slop.

The signal is meant to capture **connectivity buyers** — occupied commercial /
enterprise / institutional premises that would purchase fiber — and to exclude noise
(benches, ATMs, transit stops, monuments, natural features).

## Filtering approach
Whitelist by Overture **top-level category group**, not leaf category. This is
reproducible and auditable.

> **Honesty caveat:** the exact group *identifier strings* below must be reconciled
> against the published Overture `overture_categories.csv` taxonomy in Phase 0 (the
> taxonomy has ~2,000 leaf categories under a set of top-level groups, and spellings
> may differ slightly). The **policy** — which *kinds* of place count — is locked; the
> string reconciliation is mechanical. Record the final leaf-level mapping here as
> Phase 0 resolves it.

---

## INCLUDE — core (connectivity buyers)

| Group | Why it counts |
|---|---|
| `eat_and_drink` | restaurants, bars, cafés — commercial tenants |
| `retail` | stores, shops, showrooms |
| `accommodation` | hotels/motels — high connectivity demand |
| `professional_services` | law, accounting, consulting, agencies |
| `business_to_business` | wholesale, distribution, B2B firms |
| `financial_service` | banks, credit unions, insurance offices |
| `health_and_medical` | clinics, hospitals, medical/dental offices |
| `education` | schools, colleges, training centers, libraries |
| `public_service_and_government` | government & civic offices |
| `arts_and_entertainment` | theaters, venues, museums, studios |
| `real_estate` | brokerages, property offices |
| `mass_media` | broadcasting, publishing — high connectivity |

## INCLUDE — borderline (defaulted IN)

| Group | Why |
|---|---|
| `automotive` | dealerships/repair are real commercial premises |
| `beauty_and_spa` | salons/spas = small commercial tenants |
| `active_life` | gyms/fitness studios = commercial premises |
| `religious_organization` | churches/orgs are occupied premises that buy connectivity |
| `pets` | vets/pet stores are businesses |

## EXCLUDE — core (non-prospects / noise)

| Group | Why it's out |
|---|---|
| `structure_and_geography` | bridges, monuments, geographic landmarks |
| natural features | parks, rivers, hills, beaches |
| `public_transportation` | bus stops, transit points, parking |
| street furniture / amenity points | ATMs, vending, benches, mailboxes |
| residential | not the target market |

## EXCLUDE — borderline (defaulted OUT)

| Group | Why |
|---|---|
| `home_service` | often field/mobile, not a sellable fixed premises |
| `attractions_and_activities` | mixes venues with natural/outdoor points — noisy |

---

## Tuning log
Record changes to the whitelist here as the signal is refined against real data.

- **2026-06-29** — Initial policy locked. Whitelist-by-group; borderline groups set to
  the defaults above (include automotive / beauty_and_spa / active_life /
  religious_organization / pets; exclude home_service / attractions_and_activities).
  Leaf-level string reconciliation against `overture_categories.csv` pending Phase 0.
