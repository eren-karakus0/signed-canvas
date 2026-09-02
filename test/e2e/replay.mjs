/* End to end: does the replay actually replay, on screen?
 *
 * The obvious check — read the "31 / 149" counter and watch it climb — passes on a canvas
 * that never changes. It did, for a while: the replay drew into its own bitmap and nothing
 * asked the view to blit it, so the counter counted up over a blank board. So this counts
 * coloured pixels on the visible canvas instead, which is the only thing a person can see.
 *
 * Read-only against the live archive, so unlike `place.mjs` it writes nothing. It is not in
 * `npm run check` for the same reason `place.mjs` is not: the archive is over the network,
 * and a check script that fails during someone else's outage stops being believed.
 *
 *   node test/e2e/replay.mjs
 */

import { chromium } from "playwright";
import { serveWithArchive } from "../../scripts/local-server.mjs";

const ROOT = new URL("../../dist/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const VIEWPORT = { width: 1366, height: 768 };
/** Samples during playback. Long enough that a stalled replay cannot look like a slow one. */
const SAMPLES = 4;
const SAMPLE_MS = 1500;

const { base, close } = await serveWithArchive(ROOT);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT });
const failures = [];
page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));

/* Anything that is neither the ground nor a rule is paint. Counting pixels rather than
 * comparing whole images: the hover mark, the cursor and antialiasing all move a few pixels
 * between frames, and an equality test on the bitmap would fail on those every time. */
const paintedPixels = () =>
  page.evaluate(() => {
    const canvas = document.querySelector("#canvas");
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 12 || r < 200) painted++;
    }
    return painted;
  });

const readout = (selector) => page.locator(selector).innerText().then((t) => t.trim());

await page.goto(base, { waitUntil: "load" });
await page.waitForFunction('document.querySelector("#live-feed")?.children.length > 0', null, {
  timeout: 60_000,
});
await page.locator("[data-ack]").click();
await page.waitForSelector("#gate", { state: "hidden" });

const livePixels = await paintedPixels();
const livePainted = Number((await readout("#r-painted")).split("/")[0]);
console.log(`live            : ${livePainted} placed, ${livePixels} px on screen`);

await page.locator("#replay").click();
await page.waitForFunction(() => Number(document.querySelector("#scrub-bar")?.max) > 0, null, {
  timeout: 60_000,
});
console.log(`history         : ${await page.locator("#scrub-bar").getAttribute("max")} placements`);

// The scrubber spans the board and covers these, so a replay that left them visible would
// leave buttons that look live and cannot be clicked — including the one that opened it.
const buried = [];
for (const id of ["#reset", "#tilt", "#replay"]) {
  if (await page.locator(id).isVisible()) buried.push(id);
}
console.log(`covered buttons : ${buried.length === 0 ? "all hidden" : `STILL VISIBLE ${buried.join(" ")}`}`);

const screen = [];
const counter = [];
for (let i = 0; i < SAMPLES; i++) {
  await page.waitForTimeout(SAMPLE_MS);
  screen.push(await paintedPixels());
  counter.push(await readout("#scrub-at"));
}
console.log(`counter         : ${counter.join("  ->  ")}`);
console.log(`on screen       : ${screen.join("  ->  ")} px`);
console.log(`timestamp       : ${await readout("#scrub-when")}`);

// It must start from empty and build. A replay that opens at the finished picture shows the
// one thing the viewer already had.
const startedEmpty = screen[0] < livePixels;
const grew = screen.every((n, i) => i === 0 || n >= screen[i - 1]) && screen.at(-1) > screen[0];
console.log(`starts empty    : ${startedEmpty ? "yes" : "NO — it opened at the finished canvas"}`);
console.log(`paint arrives   : ${grew ? "yes" : "NO — the board did not change while the counter ran"}`);

// Pacing: a hundred placements and a hundred thousand should both take about a look. Measured
// from the samples rather than trusted from the constant.
const at = (text) => Number(text.split("/")[0]);
const history = Number(await page.locator("#scrub-bar").getAttribute("max"));
const perSecond = (at(counter.at(-1)) - at(counter[0])) / (((SAMPLES - 1) * SAMPLE_MS) / 1000);
const projected = perSecond > 0 ? history / perSecond : Infinity;
console.log(`pace            : ${perSecond.toFixed(1)}/s, whole history ≈ ${projected.toFixed(0)}s`);
const paced = projected > 8 && projected < 40;
console.log(`pacing sane     : ${paced ? "yes" : "NO — too fast to watch or too slow to sit through"}`);

// Placing must be refused: you would be painting onto the past.
const box = await page.locator("#canvas").boundingBox();
await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4);
await page.waitForTimeout(300);
const refusal = await readout("#status");
console.log(`clicking        : ${refusal}`);
const refused = /replay/i.test(refusal);

// Backwards rebuilds from empty, because a placement cannot be undone.
await page.locator("#scrub-bar").fill("5");
await page.locator("#scrub-bar").dispatchEvent("input");
await page.waitForTimeout(600);
const backPixels = await paintedPixels();
console.log(`scrubbed to 5   : ${await readout("#scrub-at")}, ${backPixels} px`);
const rewound = backPixels < screen.at(-1);

await page.locator("#scrub-close").click();
await page.waitForTimeout(800);
// The count only ever grows: the room is live and placements keep arriving mid-run. What is
// being proven is that the live canvas came back, not that the number is identical.
const after = Number((await readout("#r-painted")).split("/")[0]);
console.log(`closed          : ${after} placed`);
const restored = after >= livePainted;

await browser.close();
close();

const ok = buried.length === 0 && startedEmpty && grew && paced && refused && rewound && restored && failures.length === 0;
for (const failure of failures) console.log(failure);
console.log(`\n${ok ? "PASS" : "FAIL"} — the replay ${grew ? "paints" : "DOES NOT PAINT"} on screen, live canvas ${restored ? "restored" : "NOT RESTORED"}`);
process.exit(ok ? 0 : 1);
