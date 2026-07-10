# scripts/ — local dev tooling

Utilities for maintaining the repo. Not part of the app bundle and not run in CI.

## `record-hero.mjs` — record the README hero animation

Records the top-of-README demo (`docs/images/hero.gif`) by driving the app in Chrome over the
**Chrome DevTools Protocol** and streaming compositor frames (`Page.startScreencast`) into **ffmpeg**.
It is *not* a screen recording — output size and framing are deterministic and independent of your
display, and capture works even if the browser window is occluded.

The storyboard: open on the colorful city overview → sweep the budget slider so the whole surface
re-lights green→red and the reachable-building count ticks (the money shot) → zoom into downtown (dots
resolve to footprints) → click a building so its dossier, itemized screening estimate, and routed
connector appear.

It captures at retina (logical 1280×706 @ dsf 2 → ~2560×1412 frames), normalizes the frames through a
short intermediate-video pass (so `paletteuse` never sees a mid-stream size change), and encodes a
plain-palette GIF. A full-screen colored map is heavy for GIF, so the size levers, in order, are:
shorten motion → drop fps → reduce palette → shrink width. Default output ≈ 800 px / 10 fps / 96 colors
≈ 4–5 MB.

### Requirements
- **ffmpeg** on `PATH` (`brew install ffmpeg`).
- **Google Chrome** (defaults to the macOS app path; override with `CHROME_BIN=/path/to/chrome`).
- Node 18+ and this dir's deps: `npm install`.

### Usage
```sh
# 1. Serve the app locally (from repo root):
cd web && npm run build && npm run preview   # http://localhost:4173

# 2. In another shell, record (from repo root or scripts/):
cd scripts && npm install        # first time only
node record-hero.mjs             # writes ../docs/images/hero.gif
```

### Flags / env
- `URL=http://localhost:4173/` — target to record (default = `vite preview`). Point at the live site or a `vite dev` (`:5173`) instead.
- `OUT=../docs/images/hero.gif` — output path (`.webp` requires an ffmpeg built with `libwebp`; the Homebrew build usually isn't, so GIF is the default).
- `WIDTH=800` / `FPS=10` / `COLORS=96` — output width / frame rate / GIF palette size (the size knobs; keep `COLORS` ≥ 64 or the cost ramp bands).
- `CHROME_BIN=...` — Chrome executable (defaults to the macOS app path).
- `--keep` — keep the scratch frames + intermediate for debugging instead of deleting them.
