// Record the README hero animation (docs/images/hero.gif) by driving the app in
// Chrome over the Chrome DevTools Protocol and streaming compositor frames
// (Page.startScreencast) into ffmpeg. NOT a screen recording: output size and
// framing are deterministic and independent of the display, and capture works
// even when the browser window is occluded.
//
// Storyboard: city dot-overview -> zoom in (dots resolve to footprints) ->
// click a building (dossier + routed connector) -> close it -> sweep the budget
// slider so the cost surface re-lights green<->red and the reachable count ticks.
//
// Usage:  cd web && npm run build && npm run preview     # serves :5173
//         cd scripts && npm install && node record-hero.mjs
// See scripts/README.md for flags/env.

import CDP from "chrome-remote-interface";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

// --- config (env-overridable) ------------------------------------------------
// Default = the `vite preview` port (4173). `vite dev` uses 5173; override with URL=.
const TARGET = process.env.URL || "http://localhost:4173/";
const OUT = resolve(REPO, process.env.OUT || "docs/images/hero.gif");
const WIDTH = Number(process.env.WIDTH || 800); // output width; height derives from aspect
const FPS = Number(process.env.FPS || 10);
const COLORS = Number(process.env.COLORS || 96); // GIF palette size (>=64 to keep the ramp smooth)
const KEEP = process.argv.includes("--keep");
const PORT = Number(process.env.CDP_PORT || 9222);
const CHROME_BIN =
  process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Capture at retina: logical 1280x706 @ dsf=2 -> ~2560x1412 device frames (labels
// stay sized for a 1280 layout = readable, but at 2x detail). Screencast can emit
// mixed 1280x706 / 2560x1412 frames mid-stream; the encode's intermediate-video
// pass normalizes them (paletteuse alone crashes on a size change, so we never feed
// it the raw frames). Downscaled to WIDTH -> a crisp, supersampled hero.
const VW = 1280;
const VH = 706;
const DSF = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[record-hero]", ...a);

// --- wait for Chrome's debug endpoint ---------------------------------------
function getJSON(url) {
  return new Promise((res, rej) => {
    http
      .get(url, (r) => {
        let b = "";
        r.on("data", (c) => (b += c));
        r.on("end", () => res(b));
      })
      .on("error", rej);
  });
}
async function waitPort(port, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    try {
      await getJSON(`http://127.0.0.1:${port}/json/version`);
      return;
    } catch {
      if (Date.now() - t0 > timeoutMs) throw new Error(`Chrome debug port ${port} not up`);
      await sleep(150);
    }
  }
}

// --- ffmpeg two-pass palette -------------------------------------------------
function ffmpeg(args) {
  const r = spawnSync("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) throw new Error(`ffmpeg exited ${r.status}`);
}

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), "nn-hero-"));
  const framesDir = join(scratch, "frames");
  const profile = join(scratch, "chrome-profile");
  mkdirSync(framesDir);
  mkdirSync(profile);

  log(`target ${TARGET}`);
  log(`scratch ${scratch}`);

  // 1. Launch Chrome headful (real GPU for MapLibre WebGL; screencast reads the
  //    compositor so the window need not be visible/focused).
  const chrome = spawn(
    CHROME_BIN,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-features=Translate,MediaRouter",
      `--window-size=${VW},${VH}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  chrome.on("error", (e) => {
    console.error(`Failed to launch Chrome at ${CHROME_BIN}: ${e.message}`);
    process.exit(1);
  });

  let client;
  const frames = [];
  try {
    await waitPort(PORT);
    client = await CDP({ port: PORT });
    const { Page, Runtime, Input, Emulation } = client;
    await Page.enable();
    await Runtime.enable();
    // Surface page console + uncaught errors so a blank map is diagnosable.
    Runtime.consoleAPICalled(({ type, args }) => {
      if (type === "error" || type === "warning")
        log(`page ${type}:`, args.map((a) => a.value ?? a.description ?? "").join(" "));
    });
    Runtime.exceptionThrown(({ exceptionDetails }) =>
      log("page exception:", exceptionDetails.exception?.description || exceptionDetails.text),
    );

    // helper: run an expression in the page, throw on JS exception.
    const evalIn = async (expression, awaitPromise = false) => {
      const { result, exceptionDetails } = await Runtime.evaluate({
        expression,
        returnByValue: true,
        awaitPromise,
      });
      if (exceptionDetails)
        throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
      return result.value;
    };
    // helper: a real canvas click (MapLibre hit-tests native events). The move +
    // small gaps matter — a press/release fired in the same tick can be missed.
    const clickAt = async (x, y) => {
      await Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
      await sleep(60);
      await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
      await sleep(60);
      await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 1 });
    };

    // 2. Deterministic viewport.
    await Emulation.setDeviceMetricsOverride({
      width: VW,
      height: VH,
      deviceScaleFactor: DSF,
      mobile: false,
    });

    // 3. Suppress the first-run onboarding card before app JS runs.
    await Page.addScriptToEvaluateOnNewDocument({
      source: `try{localStorage.setItem('nn-onboard-dismissed','1')}catch(e){}`,
    });

    // 4. Navigate + wait for the map + facts to be ready.
    await Page.navigate({ url: TARGET });
    await Page.loadEventFired();
    log("loaded; waiting for __nnMap + facts…");
    const t0 = Date.now();
    for (;;) {
      const ok = await evalIn(`(() => {
        const m = window.__nnMap;
        if (!m || !m.loaded()) return false;
        return !!document.querySelector('.nn-stat-big');
      })()`);
      if (ok) break;
      if (Date.now() - t0 > 30000) {
        const diag = await evalIn(`JSON.stringify({
          hasMap: !!window.__nnMap,
          mapLoaded: window.__nnMap ? window.__nnMap.loaded() : null,
          hasStat: !!document.querySelector('.nn-stat-big'),
          statText: (document.querySelector('.nn-stat') || {}).textContent || null,
          bodyLen: document.body.innerText.length,
          bodyHead: document.body.innerText.slice(0, 200),
        })`);
        log("ready diagnostic:", diag);
        throw new Error("app never became ready (no __nnMap/.nn-stat-big)");
      }
      await sleep(250);
    }
    await sleep(1200); // settle tiles

    // 5. Start screencast.
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
    await setBudget(120000); // a mid budget -> a good green/red mix to open on
    await evalIn(`window.__nnMap.jumpTo({ center: [-79.999, 40.4406], zoom: 11 }); true`);
    await sleep(1300);

    // --- Beat B: budget sweep re-lights the whole surface (the money shot) ---
    // Done at the city overview, where more/fewer buildings crossing the budget
    // is dramatic; the reachable count ticks with it. Down-only (high->low) keeps
    // GIF size down (the full-surface re-light is the heaviest segment).
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
    // Scan outward from center for a footprint pixel, click it, and VERIFY the
    // dossier opened (retry a few candidate points if the first click misses).
    const findHits = () =>
      evalIn(`(() => {
        const m = window.__nnMap;
        const W = m.getContainer().clientWidth, H = m.getContainer().clientHeight;
        const cx = W / 2, cy = H / 2, out = [];
        for (const r of [0, 40, 80, 120, 160, 200]) {
          const pts = r === 0 ? [[cx, cy]] :
            [0,45,90,135,180,225,270,315].map(a => [
              Math.round(cx + r*Math.cos(a*Math.PI/180)),
              Math.round(cy + r*Math.sin(a*Math.PI/180)),
            ]);
          for (const [x, y] of pts)
            if (m.queryRenderedFeatures([x, y], { layers: ['buildings-fill'] }).length) out.push([x, y]);
        }
        return out;
      })()`);
    const dossierOpen = () => evalIn(`!!document.querySelector('.nn-dossier')`);
    const candidates = (await findHits()) || [];
    let selected = false;
    for (const [x, y] of candidates.slice(0, 6)) {
      log(`clicking building at ${x},${y}`);
      await clickAt(x, y);
      await sleep(500);
      if (await dossierOpen()) {
        selected = true;
        break;
      }
    }
    if (!selected) log("WARN: dossier did not open after clicks");
    await sleep(1800); // hold the dossier (routed connector + itemized estimate)

    await Page.stopScreencast();
    log(`captured ${frames.length} frames`);
    if (frames.length < 10) throw new Error("too few frames captured — is the app actually rendering?");

    // 6. Write frames + a concat demuxer list with per-frame durations from the
    //    screencast timestamps (VFR; ffmpeg's fps filter resamples to constant).
    const t0f = frames[0].t;
    let lines = "";
    frames.forEach((f, i) => {
      const name = `f_${String(i).padStart(5, "0")}.jpg`;
      writeFileSync(join(framesDir, name), f.buf);
      const next = frames[i + 1]?.t ?? f.t + 0.4; // last frame gets a tail hold
      const dur = Math.max(0.001, next - f.t);
      lines += `file '${name}'\nduration ${dur.toFixed(4)}\n`;
    });
    // concat quirk: repeat the last file so its duration is honored.
    lines += `file 'f_${String(frames.length - 1).padStart(5, "0")}.jpg'\n`;
    const listPath = join(framesDir, "frames.txt");
    writeFileSync(listPath, lines);
    log(`wall-clock ${(frames[frames.length - 1].t - t0f).toFixed(1)}s of frames`);

    // 7. Encode: two-pass palette GIF (or animated WebP if OUT ends in .webp).
    // Screencast frames vary in size during animation, so force every frame to an
    // exact WIDTH×HEIGHT (cover-crop, no distortion) BEFORE paletteuse — a uniform
    // stream is required or paletteuse crashes ("Internal bug").
    const HEIGHT = Math.round((WIDTH * VH) / VW / 2) * 2; // even, 1.81 aspect
    const isWebp = OUT.toLowerCase().endsWith(".webp");
    const norm = `scale=${WIDTH}:${HEIGHT}:flags=lanczos:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1`;
    const vf = `fps=${FPS},${norm}`;
    // Pass 0: normalize the (possibly mixed-size) VFR screencast frames into a
    // uniform, constant-rate intermediate. libx264 tolerates the mid-stream size
    // changes that crash paletteuse, so downstream passes see one clean stream.
    const inter = join(scratch, "inter.mp4");
    ffmpeg([
      "-y", "-f", "concat", "-safe", "0", "-i", listPath,
      "-vf", vf,
      "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p",
      inter,
    ]);

    if (isWebp) {
      ffmpeg(["-y", "-i", inter, "-c:v", "libwebp", "-q:v", "70", "-loop", "0", OUT]);
    } else {
      // Two-pass palette on the uniform intermediate. A PLAIN palette (no
      // stats_mode=diff / diff_mode=rectangle) wins here: this content is a
      // full-frame colored surface that changes across most of the timeline, so
      // diff mode only adds overhead. Size levers, in order: shorten motion (done
      // in the storyboard) -> fps -> palette size -> width.
      const palette = join(scratch, "palette.png");
      ffmpeg(["-y", "-i", inter, "-vf", `palettegen=max_colors=${COLORS}`, palette]);
      ffmpeg([
        "-y", "-i", inter, "-i", palette,
        "-lavfi", `paletteuse=dither=bayer:bayer_scale=4`,
        "-loop", "0",
        OUT,
      ]);
    }

    const size = spawnSync("du", ["-h", OUT]).stdout?.toString().split("\t")[0] ?? "?";
    log(`wrote ${OUT} (${size})`);
  } finally {
    try {
      if (client) await client.close();
    } catch {}
    try {
      chrome.kill("SIGTERM");
    } catch {}
    await sleep(600); // let Chrome release the profile dir before rmSync
    if (KEEP) {
      log(`kept scratch ${scratch}`);
    } else {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch (e) {
        log(`scratch cleanup skipped (${e.code}); rm -rf ${scratch}`);
      }
    }
  }
}

main().catch((e) => {
  console.error("[record-hero] FAILED:", e.message);
  process.exit(1);
});
