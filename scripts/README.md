# scripts/ — local dev tooling

Utilities for regenerating the README media. Not part of the app bundle and not run in CI.
Both scripts drive the app in Chrome over the **Chrome DevTools Protocol** and capture the app rendered
into an **emulated 1920×1080 viewport at dsf 2** (a full-desktop 16:9 layout at retina) — *not* a screen
recording, so framing/size are deterministic, independent of your display, and work even if the window
is occluded. Shared CDP setup lives in `cdp.mjs`.

## `record-hero.mjs` — the animated hero (`docs/images/hero.webp`)

Storyboard: open on the colorful city overview → sweep the budget slider so the whole surface re-lights
green→red and the reachable-building count ticks (the money shot) → zoom into downtown → click a
building so its dossier, itemized screening estimate, and routed connector appear.

Pipeline: stream `Page.startScreencast` frames → normalize through an intermediate `libx264` pass (so a
mid-stream frame-size change never reaches `paletteuse`) → a plain-palette GIF → **`gif2webp`** (which
inter-frame-diffs, so a full-res animation stays a few MB; `img2webp` stores whole frames and is ~6×
larger). Rendered at the full 1920 layout, output downscaled to 1440 (`~4 MB`). A full-screen colored
map is heavy, so the size levers, in order, are: shorten motion → drop `FPS` → lower `QUALITY` → shrink
`WIDTH`.

## `capture-stills.mjs` — the four README stills

Drives the app to each state and takes `Page.captureScreenshot` at retina, then downscales to a crisp
`.webp` with `cwebp`:
- `cost.webp` — default Buildings view, downtown + rivers cost surface (1920).
- `dossier.webp` — a selected building + its routed connector and itemized estimate (1920).
- `cells.webp` — Cell-overview H3 opportunity-index hexes (1920).
- `mobile.webp` — a phone viewport, bottom sheet expanded on a building's estimate (640 wide).

### Requirements
- **ffmpeg**, **webp** tools (`gif2webp`, `cwebp`, `img2webp`), on `PATH` (`brew install ffmpeg webp`).
- **Google Chrome** (defaults to the macOS app path; override with `CHROME_BIN=/path/to/chrome`).
- Node 18+ and this dir's deps: `npm install`.

### Usage
```sh
# 1. Serve the app locally (from repo root):
cd web && npm run build && npm run preview   # http://localhost:4173

# 2. In another shell (from scripts/):
cd scripts && npm install        # first time only
node record-hero.mjs             # writes ../docs/images/hero.webp
node capture-stills.mjs          # writes ../docs/images/{cost,dossier,cells,mobile}.webp
```

### Flags / env (record-hero.mjs)
- `URL=http://localhost:4173/` — target (default = `vite preview`). Point at the live site or a `vite dev` (`:5173`) instead.
- `OUT=../docs/images/hero.webp` — output path. Ends in `.gif` → a plain-palette GIF instead (no `gif2webp` hop).
- `WIDTH=1440` / `FPS=10` / `QUALITY=45` — output width / frame rate / `gif2webp` quality (the size knobs).
- `COLORS=96` — GIF palette size for the intermediate (keep ≥ 64 or the cost ramp bands).
- `CHROME_BIN=...` — Chrome executable (defaults to the macOS app path).
- `--keep` — keep the scratch frames + intermediate for debugging instead of deleting them.

Both scripts honor `URL`, `CHROME_BIN`, and `--keep`.
