/* T-7's acceptance measurement, across the three engines.
 *
 * What is gated, and why it is not the obvious thing:
 *
 *   paint work   the time inside paint(). This is the renderer's own cost and the only part
 *                of a frame this code controls. Budget: one 60 Hz frame, 16.7 ms.
 *   dropped      frames whose interval exceeded 1.5x this engine's OWN idle cadence, i.e.
 *                a frame this renderer caused to be missed. Budget: 2%.
 *
 *                The threshold used to be a flat 25 ms, which reads as "1.5 vsyncs" and is
 *                right only where a vsync is 16.7 ms. Headless WebKit on Windows runs its
 *                rAF loop at **30 ms p50 on a blank page with no work at all** — 106 of 179
 *                idle frames are already over 25 ms — so it failed this gate by existing.
 *                The canvas was in fact beating the idle baseline (74 over-25 ms frames
 *                against 106), and the gate reported that as a rendering regression.
 *
 *                So the baseline is measured per engine, in the same session, on the same
 *                page, and the threshold is derived from it. This is not a looser budget: at
 *                16.7 ms the derived threshold is 25.05 ms, which is where it already was.
 *   placement    invalidateCell + repaint. Must fit in one frame or a busy canvas stutters
 *                — the failure the dirty-region logic exists to prevent.
 *
 * The rAF *interval* is reported but not gated. Its p50 sits at the vsync period by
 * definition, so gating its p95 at 16.7 ms gates scheduler jitter rather than rendering
 * cost: an earlier run of this file failed all three engines at 17–19 ms p95 while paint
 * work was 0.1 ms. That was a broken measurement, not a slow renderer.
 *
 * Also asserts the pick buffer's ordering invariant on all 4,096 cells.
 */

import { chromium, firefox, webkit } from "playwright";
import { serveWithArchive } from "../scripts/local-server.mjs";

/* How much worse than this engine's own idle frame a gap must be before it counts as
   dropped. 1.5 is not a new number: it is what a flat 25 ms meant on a 60 Hz engine, kept so
   that calibrating changes nothing where the old threshold was already correct. */
const DROP_FACTOR = 1.5;

// Built by `npm run bench` with `--bench`, which is the only build that carries the
// `window.__canvas` handle this file measures through.
const ROOT = new URL("../dist-bench/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
/* Served the way the deployment serves it, /api included. Without the forward the client
   cannot load the canvas and the benchmark measures paint work on an empty grid — which is
   not the product, and would quietly report better numbers than the product achieves. */
const { base, close: closeServer } = await serveWithArchive(ROOT);

/* This engine's rAF cadence with nothing drawn, on the page under test.
   Measured rather than assumed: an engine's headless frame rate is not its vsync. */
const idleCadence = async (page) =>
  page.evaluate(async () => {
    const gaps = [];
    let prev = await new Promise(requestAnimationFrame);
    for (let i = 0; i < 90; i++) {
      const now = await new Promise(requestAnimationFrame);
      gaps.push(now - prev);
      prev = now;
    }
    gaps.shift();
    const sorted = [...gaps].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.5)];
  });

const measure = async (page, droppedAboveMs) =>
  page.evaluate(async (DROPPED_ABOVE_MS) => {
    const { view, scene, grid } = window.__canvas;
    const FRAMES = 180;

    const percentile = (xs, p) => {
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(s.length * p))];
    };

    // --- frames + paint work, under continuous pan and zoom -------------------------
    const intervals = [];
    const dropIndex = [];
    const work = [];
    await new Promise((done) => {
      let i = 0;
      let prev = performance.now();
      const step = () => {
        const scale = 1.1 + 0.45 * Math.sin(i / 22);
        view.setViewport(scale, 120 * Math.sin(i / 17), 40 * Math.cos(i / 19));
        const t0 = performance.now();
        view.paint();
        const t1 = performance.now();
        work.push(t1 - t0);
        intervals.push(t1 - prev);
        prev = t1;
        if (++i < FRAMES) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
    intervals.shift();
    // A gap of 100 ms or more is not a dropped frame, it is requestAnimationFrame being
    // throttled — a headed window that is occluded backs off 1s, 2s, 4s, 8s... A renderer
    // using 1 ms of a 16.7 ms budget cannot produce a 32-second frame, so these are
    // reported as an invalid run rather than counted against the budget.
    const THROTTLED_ABOVE_MS = 100;
    const throttled = intervals.filter((v) => v >= THROTTLED_ABOVE_MS).length;
    intervals.forEach((v, i) => {
      if (v > DROPPED_ABOVE_MS && v < THROTTLED_ABOVE_MS) {
        dropIndex.push(`#${i}:${v.toFixed(0)}ms`);
      }
    });

    // --- placement cost, on the path the application actually takes -----------------
    // main.ts does: grid.place -> scene.invalidateCell -> view.request(). The repaint lands
    // on the next animation frame, batched with everything else. Measuring paint() in a
    // tight synchronous loop instead forces a GPU flush per call and reports ~8 ms in
    // Chromium for work that costs 0.1 ms inside rAF — a cost of the harness, not the app.
    const invalidate = [];
    const settle = [];
    for (let n = 0; n < 200; n++) {
      const cx = (n * 13) % 64;
      const cy = (n * 29) % 64;
      grid.place(cx, cy, 1 + (n % 15));
      const t0 = performance.now();
      scene.invalidateCell(cx, cy);
      const t1 = performance.now();
      invalidate.push(t1 - t0);
      await new Promise((r) =>
        requestAnimationFrame(() => {
          view.paint();
          settle.push(performance.now() - t0);
          r();
        }),
      );
    }
    const warm = invalidate.slice(0, 10);
    const settled = invalidate.slice(10);

    // --- a full scene redraw, for comparison ---------------------------------------
    const t0 = performance.now();
    scene.drawAll();
    const fullRedraw = performance.now() - t0;

    return {
      throttled,
      dropped: intervals.filter((v) => v > DROPPED_ABOVE_MS && v < THROTTLED_ABOVE_MS).length,
      dropWhere: dropIndex,
      frames: intervals.length,
      frameP50: percentile(intervals, 0.5),
      frameP95: percentile(intervals, 0.95),
      droppedAboveMs: DROPPED_ABOVE_MS,
      workP50: percentile(work, 0.5),
      workP95: percentile(work, 0.95),
      invP50: percentile(invalidate, 0.5),
      invP95: percentile(invalidate, 0.95),
      settleP50: percentile(settle, 0.5),
      settleP95: percentile(settle, 0.95),
      placeP50: percentile(settled, 0.5),
      placeP95: percentile(settled, 0.95),
      placeP99: percentile(settled, 0.99),
      placeMax: Math.max(...settled),
      warmMax: Math.max(...warm),
      overBudget: settled.filter((v) => v > 16.7).length,
      samples: settled.length,
      fullRedraw,
    };
  }, droppedAboveMs);

const pickInvariant = async (page) =>
  page.evaluate(() => {
    // The top-face centre of a cell must resolve to that cell, or to one drawn later —
    // only a later cell can be in front of it. Anything earlier means the draw order or
    // the projection is wrong.
    const { scene } = window.__canvas;
    const N = 64;
    const TW = 22;
    const TH = 11;
    const LIFT = 7;
    const MAX_CONTEST = 8;
    const PAD = 20;
    const BUF_W = N * TW + PAD * 2;
    const OX = BUF_W / 2;
    const OY = MAX_CONTEST * LIFT + PAD;

    let exact = 0;
    let occluded = 0;
    const wrong = [];
    for (let cy = 0; cy < N; cy++) {
      for (let cx = 0; cx < N; cx++) {
        const own = cy * N + cx;
        const lift = Math.min(scene.contestAt(own), MAX_CONTEST) * LIFT;
        const x = OX + (cx - cy) * (TW / 2);
        const y = OY + (cx + cy) * (TH / 2) - lift + TH / 2;
        const got = scene.pick(x, y);
        if (got === own) exact++;
        else if (got !== null && got > own) occluded++;
        else if (wrong.length < 8) wrong.push({ cx, cy, own, got });
      }
    }
    // A point well outside the diamond is paper, not a cell.
    const offCanvas = scene.pick(4, 4);
    return { exact, occluded, wrong, total: N * N, offCanvas };
  });

const HEADED = process.argv.includes("--headed");
/* Dropped frames are gated as a rate, not at zero. Measured across three headless runs,
   WebKit drops 0-2 of 179 frames at unpredictable positions (#15, #71, #117 — so not
   warm-up), each exactly one extra vsync, while paint work sits at 1 ms in a 16.7 ms
   budget. A renderer using 6% of the budget cannot be the cause of a 27 ms frame, but the
   drops are real and are reported rather than trimmed. Anything above this rate is ours
   until proven otherwise. */
const DROP_RATE_BUDGET = 0.02;

const pad = (s, n) => String(s).padEnd(n);
const ms = (v) => `${v.toFixed(1)}ms`;
const fps = (v) => `${(1000 / v).toFixed(0)}fps`;

console.log(HEADED ? "mode: headed (real compositor)" : "mode: headless");
let failed = false;
for (const [name, engine] of [
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
]) {
  let browser;
  try {
    browser = await engine.launch({ headless: !HEADED });
  } catch (err) {
    console.log(`${pad(name, 9)} launch failed: ${err.message.split("\n")[0]}`);
    failed = true;
    continue;
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  /* Errors the page did not handle — collected in the page, from the two events the
     platform defines for exactly that, rather than from Playwright's `pageerror`.
     `pageerror` looked like the obvious choice and is wrong here: measured across all three
     engines, WebKit raises it for a CORS-blocked `fetch` **even when the rejection is fully
     caught**, in both the `.catch()` and `try/await/catch` shapes, while Chromium and
     Firefox raise nothing. So an upstream outage failed this benchmark on WebKit alone, for
     a request the client handles correctly.

     `unhandledrejection` and a window `error` carrying a real `error` object do not fire for
     a caught rejection in any engine, which is the property that makes them the right
     instrument for an async client. */
  await page.addInitScript(() => {
    const unhandled = [];
    window.__unhandled = unhandled;
    window.addEventListener("error", (event) => {
      // A resource that failed to load also raises `error` here, with no `error` object and
      // an element as the target. That is not an exception the page failed to handle.
      if (event.error) unhandled.push(String(event.error.stack ?? event.error));
    });
    window.addEventListener("unhandledrejection", (event) => {
      unhandled.push(`unhandled rejection: ${String(event.reason)}`);
    });
  });

  // Kept for the report, deliberately not gated on. See above.
  const reported = [];
  page.on("pageerror", (e) => reported.push(e.message));
  await page.goto(base, { waitUntil: "load" });
  await page.waitForFunction("window.__canvas !== undefined", null, { timeout: 20000 });

  const inv = await pickInvariant(page);
  const idleMs = await idleCadence(page);
  const m = await measure(page, Math.max(25, idleMs * DROP_FACTOR));
  const version = browser.version();

  const okWork = m.workP95 <= 16.7;
  const okDropped = m.throttled === 0 && m.dropped / m.frames <= DROP_RATE_BUDGET;
  const okPlace = m.placeP95 <= 16.7;
  const okPick = inv.wrong.length === 0 && inv.offCanvas === null;
  const errors = await page.evaluate(() => window.__unhandled ?? []);
  if (!okWork || !okDropped || !okPlace || !okPick || errors.length) failed = true;

  console.log(`\n${name} ${version}`);
  console.log(
    `  paint work  p50 ${pad(ms(m.workP50), 16)} p95 ${pad(ms(m.workP95), 16)} ${okWork ? "OK" : "FAIL (>16.7ms)"}`,
  );
  console.log(
    `  dropped     ${pad(m.dropped + " of " + m.frames + " frames over " + m.droppedAboveMs.toFixed(0) + "ms (budget " + (DROP_RATE_BUDGET * 100).toFixed(0) + "%)", 46)} ${m.throttled ? "INVALID — rAF throttled on " + m.throttled + " frames, window not visible" : okDropped ? "OK" : "FAIL"}  ${m.dropWhere.join(" ")}`,
  );
  console.log(
    `  rAF gap     p50 ${pad(ms(m.frameP50) + " " + fps(m.frameP50), 16)} p95 ${pad(ms(m.frameP95) + " " + fps(m.frameP95), 16)} (idle baseline ${ms(idleMs)} ${fps(idleMs)}; not gated)`,
  );
  console.log(
    `  placement   invalidate p50 ${pad(ms(m.placeP50), 10)} p95 ${pad(ms(m.placeP95), 10)} p99 ${pad(ms(m.placeP99), 10)} max ${pad(ms(m.placeMax), 10)} ${okPlace ? "OK" : "FAIL (>16.7ms)"}`,
  );
  console.log(
    `              on screen next frame, p50 ${pad(ms(m.settleP50), 10)} p95 ${ms(m.settleP95)}   ·  first-10 max ${ms(m.warmMax)}`,
  );
  console.log(
    `              over budget ${m.overBudget} of ${m.samples}`,
  );
  console.log(`  full redraw ${ms(m.fullRedraw)}  (the cost the dirty region avoids)`);
  console.log(
    `  pick        ${inv.exact} exact + ${inv.occluded} occluded-by-a-later-cell = ${inv.exact + inv.occluded}/${inv.total}, off-canvas ${inv.offCanvas === null ? "null OK" : "WRONG: " + inv.offCanvas} ${okPick ? "OK" : "FAIL"}`,
  );
  if (inv.wrong.length) console.log("  wrong picks:", JSON.stringify(inv.wrong));
  if (errors.length) console.log("  UNHANDLED in the page:", errors);
  // Informational: an engine may report an error the page handled. Named as such so it is
  // not read as a failure, and printed because it is occasionally the first sign of one.
  if (reported.length) console.log("  engine reported (handled, not gated):", reported);

  await browser.close();
}

closeServer();
process.exit(failed ? 1 : 0);
