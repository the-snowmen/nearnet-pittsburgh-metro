// Shared Chrome DevTools Protocol driving for the capture scripts (record-hero.mjs,
// capture-stills.mjs). Launches a headful Chrome, connects over CDP, and exposes the
// app-specific helpers both scripts need: an emulated viewport, onboarding
// suppression, a ready-wait, page eval, a real canvas click, and building selection.
// Not a screen recording — the app renders into an emulated viewport independent of
// the physical display.

import CDP from "chrome-remote-interface";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const makeLog = (tag) => (...a) => console.log(`[${tag}]`, ...a);

export const DEFAULT_CHROME =
  process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

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

// Launch Chrome + connect over CDP. Returns a session with app-aware helpers.
// The caller sets the viewport and navigates (both scripts differ there).
export async function startSession({
  tag = "cdp",
  port = 9222,
  chromeBin = DEFAULT_CHROME,
  windowSize = "1920,1080",
} = {}) {
  const log = makeLog(tag);
  const scratch = mkdtempSync(join(tmpdir(), "nn-cap-"));
  const profile = join(scratch, "chrome-profile");
  mkdirSync(profile);

  // Headful = real GPU for MapLibre WebGL; CDP capture reads the compositor, so the
  // window need not be visible or focused.
  const chrome = spawn(
    chromeBin,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-features=Translate,MediaRouter",
      // Pin the window to the target logical size so the screencast surface stays a
      // single size (without this the surface can shrink mid-capture -> mixed-aspect
      // frames that the cover-crop then shifts).
      `--window-size=${windowSize}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  chrome.on("error", (e) => {
    console.error(`Failed to launch Chrome at ${chromeBin}: ${e.message}`);
    process.exit(1);
  });

  await waitPort(port);
  const client = await CDP({ port });
  const { Page, Runtime, Input, Emulation } = client;
  await Page.enable();
  await Runtime.enable();
  Runtime.consoleAPICalled(({ type, args }) => {
    if (type === "error" || type === "warning")
      log(`page ${type}:`, args.map((a) => a.value ?? a.description ?? "").join(" "));
  });
  Runtime.exceptionThrown(({ exceptionDetails }) =>
    log("page exception:", exceptionDetails.exception?.description || exceptionDetails.text),
  );

  // Suppress the first-run onboarding card before any app JS runs.
  await Page.addScriptToEvaluateOnNewDocument({
    source: `try{localStorage.setItem('nn-onboard-dismissed','1')}catch(e){}`,
  });

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

  // A real canvas click (MapLibre hit-tests native events). The move + small gaps
  // matter — a press/release fired in the same tick can be missed.
  const clickAt = async (x, y) => {
    await Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
    await sleep(60);
    await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
    await sleep(60);
    await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 1 });
  };

  const setViewport = ({ width, height, dsf, mobile = false }) =>
    Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: dsf, mobile });

  const navigateAndWait = async (url, { settleMs = 1200 } = {}) => {
    await Page.navigate({ url });
    await Page.loadEventFired();
    log(`loaded ${url}; waiting for __nnMap + facts…`);
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
          hasMap: !!window.__nnMap, mapLoaded: window.__nnMap ? window.__nnMap.loaded() : null,
          hasStat: !!document.querySelector('.nn-stat-big'),
          bodyHead: document.body.innerText.slice(0, 160),
        })`);
        log("ready diagnostic:", diag);
        throw new Error("app never became ready (no __nnMap/.nn-stat-big)");
      }
      await sleep(250);
    }
    await sleep(settleMs); // let tiles paint
  };

  // Scan outward from the viewport centre for a footprint pixel, click it, and
  // VERIFY the dossier opened — retrying candidate points if a click misses (the
  // exact centre is often a street/gap with no building).
  const selectBuildingNearCenter = async ({ maxTries = 6 } = {}) => {
    const candidates =
      (await evalIn(`(() => {
        const m = window.__nnMap;
        const W = m.getContainer().clientWidth, H = m.getContainer().clientHeight;
        const cx = W / 2, cy = H / 2, out = [];
        for (const r of [0, 40, 80, 120, 160, 200, 260]) {
          const pts = r === 0 ? [[cx, cy]] :
            [0,45,90,135,180,225,270,315].map(a => [
              Math.round(cx + r*Math.cos(a*Math.PI/180)),
              Math.round(cy + r*Math.sin(a*Math.PI/180)),
            ]);
          for (const [x, y] of pts)
            if (m.queryRenderedFeatures([x, y], { layers: ['buildings-fill'] }).length) out.push([x, y]);
        }
        return out;
      })()`)) || [];
    for (const [x, y] of candidates.slice(0, maxTries)) {
      log(`clicking building at ${x},${y}`);
      await clickAt(x, y);
      await sleep(500);
      if (await evalIn(`!!document.querySelector('.nn-dossier')`)) return true;
    }
    log("WARN: dossier did not open after clicks");
    return false;
  };

  const close = async ({ keep = false } = {}) => {
    try {
      await client.close();
    } catch {}
    try {
      chrome.kill("SIGTERM");
    } catch {}
    await sleep(600); // let Chrome release the profile dir
    if (keep) log(`kept scratch ${scratch}`);
    else {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch (e) {
        log(`scratch cleanup skipped (${e.code}); rm -rf ${scratch}`);
      }
    }
  };

  return {
    client, Page, Runtime, Input, Emulation, chrome, scratch, log,
    evalIn, clickAt, setViewport, navigateAndWait, selectBuildingNearCenter, close,
  };
}
