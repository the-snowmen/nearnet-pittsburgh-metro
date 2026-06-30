"""near-net — offline Phase 0 build pipeline.

Offline ETL ONLY. The V1 app (DuckDB-WASM + MapLibre over static GeoParquet) ships none
of this; it runs once on a build machine to bake facts into static files (DESIGN.md §2).
"""
