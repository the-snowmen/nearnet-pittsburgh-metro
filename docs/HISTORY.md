# near-net — Project History

This is a short record of milestones that explains the current design without making historical
work-in-progress the primary documentation.

- **2026-06-29:** Established the public-data, no-browser-routing architecture and the offline
  fact / browser-assumption split.
- **2026-06-30:** Ran the full-city measurement (115,914 buildings) and retained the sparse
  `primary`-road modeled corridor after testing a denser alternative.
- **2026-07-01:** Replaced straight-line proximity with offline road-routed connector distance and
  added the H3 cell overview derived from the same building facts.
- **2026-07-02:** Added selected-building dossiers, routed connector display, public-place detail,
  KMZ export, nearest-address labeling, a mobile bottom sheet, and PMTiles building surfaces.
- **2026-07-03:** Renamed the repository to `nearnet-pittsburgh`; the relative Vite base keeps it
  deployable under the GitHub Pages project path.
- **2026-07-10:** Simplified public documentation and the control panel, added cost-model tests,
  and moved Pages publishing to GitHub Actions.
