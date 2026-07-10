// Record the README hero animation (docs/images/hero.webp) by driving the app in
// Chrome over the DevTools Protocol, streaming compositor frames
// (Page.startScreencast), and encoding with ffmpeg + gif2webp. NOT a screen
// recording: the app renders into an emulated 1920x1080 viewport (independent of the
// display) captured at dsf2 (3840x2160 retina source), so framing/size are
// deterministic and capture works even if the window is occluded.
//
// Storyboard: colorful city overview -> budget-slider sweep re-lights the whole
// surface green->red as the reachable count ticks (the money shot) -> zoom to
// downtown -> click a building for its dossier + routed connector.
//
// Usage:  cd web && npm run build && npm run preview     # serves :4173
//         cd scripts && npm install && node record-hero.mjs
// See scripts/README.md for flags/env.

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startSession, sleep, makeLog } from "./cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const log = makeLog("record-hero");

// --- config (env-overridable) ------------------------------------------------
// Default = the `vite preview` port (4173). `vite dev` uses 5173; override with URL=.
const TARGET = process.env.URL || "http://localhost:4173/";
const OUT = resolve(REPO, process.env.OUT || "docs/images/hero.webp");
// Output width (rendered at the full 1920 desktop layout, then downscaled). 1440
// keeps the full-screen framing at a sane hero weight (~3-4 MB); height is 16:9.
const WIDTH = Number(process.env.WIDTH || 1440);
const FPS = Number(process.env.FPS || 10);
const QUALITY = Number(process.env.QUALITY || 45); // gif2webp lossy quality (~4 MB at 1440)
const COLORS = Number(process.env.COLORS || 96); // GIF palette size (only if OUT=.gif)
const KEEP = process.argv.includes("--keep");
const PORT = Number(process.env.CDP_PORT || 9222);

// Full-desktop 16:9 layout at retina. dsf2 emits mixed-size frames mid-stream; the
// intermediate x264 pass normalizes them before palette/webp encoding.
const VW = 1920;
const VH = 1080;
const DSF = 2;

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
}

async function main() {
  const s = await startSession({ tag: "record-hero", port: PORT });
  const { Page, client, evalIn, selectBuildingNearCenter, scratch } = s;
  const framesDir = join(scratch, "frames");
  mkdirSync(framesDir);
  log(`target ${TARGET}`);
  log(`scratch ${scratch}`);

  const frames = [];
  try {
    await s.setViewport({ width: VW, height: VH, dsf: DSF });
    await s.navigateAndWait(TARGET);

    // Start screencast.
    client.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
      frames.push({ buf: Buffer.from(data, "base64"), t: metadata.timestamp });
      try {
        await Page.screencastFrameAck({ sessionId });
      } catch {
        /* stream stopped */
      }
    });
    await Page.startScreencast({
      format: "jpeg",
      quality: 90,
      maxWidth: VW * DSF,
      maxHeight: VH * DSF,
      everyNthFrame: 1,
    });
    log("screencast started");

    // Budget slider helpers (React-controlled input: native setter + input event).
    const setBudget = (v) =>
      evalIn(`(() => {
        const inp = [...document.querySelectorAll('input[type=range]')].find(i => i.max === '500000');
        if (!inp) return false;
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        set.call(inp, String(${v}));
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
    const sweep = async (from, to, steps, stepMs) => {
      for (let i = 0; i <= steps; i++) {
        const raw = from + (to - from) * (i / steps);
        await setBudget(Math.round(raw / 5000) * 5000); // snap to slider step
        await sleep(stepMs); // > 120ms repaint debounce so each recolor lands
      }
    };

    // --- Beat A: city overview (colorful cost surface) ----------------------
    await setBudget(120000);
    await evalIn(`window.__nnMap.jumpTo({ center: [-79.999, 40.4406], zoom: 11 }); true`);
    await sleep(1300);

    // --- Beat B: budget sweep re-lights the whole surface (the money shot) ---
    log("sweeping budget at overview…");
    await setBudget(500000);
    await sleep(700); // hold the all-green (max-budget) start
    await sweep(500000, 10000, 26, 130); // green -> red
    await sleep(700); // hold the red (min-budget) end

    // --- Beat C: reset to a readable budget + zoom to downtown footprints ----
    await setBudget(180000);
    await sleep(300);
    await evalIn(
      `(() => new Promise((res) => {
         const m = window.__nnMap;
         m.once('moveend', () => res(true));
         m.flyTo({ center: [-79.9959, 40.4415], zoom: 15.4, duration: 1800 });
       }))()`,
      true,
    );
    await sleep(700); // footprint tiles paint

    // --- Beat D: select a building -> dossier (closing detail beat) ----------
    await selectBuildingNearCenter();
    await sleep(1800); // hold the dossier (routed connector + itemized estimate)

    await Page.stopScreencast();
    log(`captured ${frames.length} frames`);
    if (frames.length < 10) throw new Error("too few frames captured — is the app rendering?");

    // Write frames + a concat list with per-frame durations from the screencast
    // timestamps (VFR; ffmpeg's fps filter resamples to constant).
    const t0f = frames[0].t;
    let lines = "";
    frames.forEach((f, i) => {
      const name = `f_${String(i).padStart(5, "0")}.jpg`;
      writeFileSync(join(framesDir, name), f.buf);
      const next = frames[i + 1]?.t ?? f.t + 0.4; // last frame gets a tail hold
      lines += `file '${name}'\nduration ${Math.max(0.001, next - f.t).toFixed(4)}\n`;
    });
    lines += `file 'f_${String(frames.length - 1).padStart(5, "0")}.jpg'\n`; // concat quirk
    const listPath = join(framesDir, "frames.txt");
    writeFileSync(listPath, lines);
    log(`wall-clock ${(frames[frames.length - 1].t - t0f).toFixed(1)}s of frames`);

    // Pass 0: normalize the (possibly mixed-size) VFR frames into a uniform,
    // constant-rate intermediate. libx264 tolerates the mid-stream size changes
    // that crash paletteuse and give the webp extractor a clean stream.
    const HEIGHT = Math.round((WIDTH * VH) / VW / 2) * 2; // even, 16:9
    const vf = `fps=${FPS},scale=${WIDTH}:${HEIGHT}:flags=lanczos:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1`;
    const inter = join(scratch, "inter.mp4");
    run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-vf", vf, "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", inter]);

    // Build a plain-palette GIF from the uniform intermediate (no stats_mode=diff —
    // this full-frame colored motion doesn't benefit from diff mode). That GIF is the
    // deliverable for OUT=.gif, else the source for gif2webp.
    const palette = join(scratch, "palette.png");
    const gif = OUT.toLowerCase().endsWith(".gif") ? OUT : join(scratch, "hero.gif");
    run("ffmpeg", ["-y", "-i", inter, "-vf", `palettegen=max_colors=${COLORS}`, palette]);
    run("ffmpeg", ["-y", "-i", inter, "-i", palette, "-lavfi", `paletteuse=dither=bayer:bayer_scale=4`, "-loop", "0", gif]);
    if (gif !== OUT) {
      // Animated WebP: gif2webp inter-frame-diffs the GIF, so a full-res 1920 hero
      // stays a few MB. (img2webp stores whole frames -> ~6x larger; ffmpeg here has
      // no libwebp, hence the GIF hop.)
      run("gif2webp", ["-q", String(QUALITY), "-m", "4", "-mixed", gif, "-o", OUT]);
    }

    const size = spawnSync("du", ["-h", OUT]).stdout?.toString().split("\t")[0] ?? "?";
    log(`wrote ${OUT} (${size})`);
  } finally {
    await s.close({ keep: KEEP });
  }
}

main().catch((e) => {
  console.error("[record-hero] FAILED:", e.message);
  process.exit(1);
});
