// Regenerate the four README stills (docs/images/{cost,dossier,cells,mobile}.webp)
// by driving the app over the DevTools Protocol and taking Page.captureScreenshot at
// retina, then downscaling to a crisp .webp with cwebp. Same emulated-viewport
// approach as record-hero.mjs (no screen capture); reuses scripts/cdp.mjs.
//
// Usage:  cd web && npm run build && npm run preview     # serves :4173
//         cd scripts && node capture-stills.mjs
// Env: URL (default :4173), CHROME_BIN, --keep.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startSession, sleep, makeLog } from "./cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const IMG = resolve(REPO, "docs/images");
const log = makeLog("capture-stills");

const TARGET = process.env.URL || "http://localhost:4173/";
const KEEP = process.argv.includes("--keep");
const PORT = Number(process.env.CDP_PORT || 9222);

// Desktop stills: full-desktop 16:9 at retina -> downscaled to 1920 wide.
const DESKTOP = { width: 1920, height: 1080, dsf: 2 };
const DESKTOP_OUT_W = 1920;
// Mobile still: a phone viewport -> downscaled to 640 wide (portrait).
const MOBILE = { width: 390, height: 844, dsf: 3 };
const MOBILE_OUT_W = 640;

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
}

async function main() {
  const s = await startSession({ tag: "capture-stills", port: PORT });
  const { Page, evalIn, selectBuildingNearCenter, scratch } = s;
  log(`target ${TARGET}`);

  // Screenshot the current page (retina PNG) -> downscale to a `width`-wide .webp.
  const shoot = async (name, width, q = 90) => {
    const { data } = await Page.captureScreenshot({ format: "png" });
    const png = join(scratch, `${name}.png`);
    writeFileSync(png, Buffer.from(data, "base64"));
    const out = join(IMG, `${name}.webp`);
    run("cwebp", ["-resize", String(width), "0", "-q", String(q), png, "-o", out]);
    const size = spawnSync("du", ["-h", out]).stdout?.toString().split("\t")[0] ?? "?";
    log(`wrote ${out} (${size.trim()})`);
  };

  try {
    // ---- Desktop stills -----------------------------------------------------
    await s.setViewport(DESKTOP);
    await s.navigateAndWait(TARGET);

    // cost — default Buildings view, downtown + rivers cost surface.
    await evalIn(`window.__nnMap.jumpTo({ center: [-79.9975, 40.4425], zoom: 13.1 }); true`);
    await sleep(1600); // tiles + surface settle
    await shoot("cost", DESKTOP_OUT_W);

    // dossier — a selected building at close zoom + its routed connector.
    await evalIn(`window.__nnMap.jumpTo({ center: [-79.9959, 40.4415], zoom: 16.6 }); true`);
    await sleep(1200);
    await selectBuildingNearCenter();
    await sleep(1600); // dossier + async routed connector draw
    await shoot("dossier", DESKTOP_OUT_W);

    // cells — Cell overview altitude (H3 hexes).
    await evalIn(
      `(() => { const b=[...document.querySelectorAll('.nn-altitude .nn-seg-btn')]
         .find(x=>/cell/i.test(x.textContent)); if(b){b.click(); return true} return false })()`,
    );
    await sleep(400);
    await evalIn(`window.__nnMap.jumpTo({ center: [-79.995, 40.443], zoom: 12.1 }); true`);
    await sleep(1600); // hexes render
    await shoot("cells", DESKTOP_OUT_W);

    // ---- Mobile still -------------------------------------------------------
    // Re-emulate a phone and reload so the app mounts its mobile bottom-sheet layout.
    await s.setViewport(MOBILE);
    await s.navigateAndWait(TARGET);
    await evalIn(`window.__nnMap.jumpTo({ center: [-79.9959, 40.4415], zoom: 16.6 }); true`);
    await sleep(1200);
    await selectBuildingNearCenter();
    await sleep(1200);
    // Expand the bottom sheet to full so the itemized estimate shows (toggle reads
    // "☰ Controls" while collapsed, "✕ Close" when open).
    await evalIn(
      `(() => { const t=document.querySelector('.nn-panel-toggle');
         if (t && /controls/i.test(t.textContent)) { t.click(); return 'expanded' }
         return t ? t.textContent.trim() : 'no-toggle' })()`,
    );
    await sleep(900);
    await shoot("mobile", MOBILE_OUT_W);
  } finally {
    await s.close({ keep: KEEP });
  }
}

main().catch((e) => {
  console.error("[capture-stills] FAILED:", e.message);
  process.exit(1);
});
