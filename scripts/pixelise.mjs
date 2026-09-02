/* Turn an image into a placement plan for the canvas.
 *
 * An authoring step, not a runtime one: it reads a picture, decides which palette step each
 * cell should be, and writes a plan that `agents/draw.py` can place. Kept apart from the
 * placing so the picture can be looked at before anything is signed — a placement is permanent
 * in the archive even after it is painted over, so "render it and see" has to come first.
 *
 * Rendering is done by the browser that is already a dependency for the tests rather than by
 * an image library: an SVG is then rasterised by the same engine that will draw the canvas,
 * and no new dependency is added to turn one picture into a list of cells.
 *
 *   node scripts/pixelise.mjs <source> --at <x>,<y> --size <w>x<h> [options]
 *
 *     --at    <x>,<y>     top-left cell. Required.
 *     --size  <w>x<h>     size in cells. One side may be `auto` to keep the aspect ratio.
 *     --bg    <step|none> what to do with a transparent cell: fill it with that palette step,
 *                         or leave it alone. Default none.
 *     --alpha <0..1>      coverage below which a cell counts as transparent. Default 0.5.
 *     --only  <steps>     comma-separated palette steps to choose from. Default all of them.
 *     --trim              crop to the drawing before scaling. An exported logo usually carries
 *                         its own margin, and on a 144x64 canvas that margin is real estate.
 *     --out   <path>      plan file. Default plans/<source name>.json
 *
 * The plan is JSON: { source, at, size, cells: [[x, y, step], ...] }.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { chromium } from "playwright";
import { COLS, ROWS } from "../src/canvas/projection.ts";
import { GRID_LINE, GROUND, PALETTE } from "../src/canvas/palette.ts";
import { distance } from "../src/canvas/distance.ts";
import { MAX_STEP, MIN_STEP } from "../src/canvas/wire.ts";

/* Each cell is averaged from this many rendered pixels a side. Sampling one point per cell
 * picks up whatever happened to be under it, which turns a logo built from outlined shapes
 * into a dotted line. */
const SUPERSAMPLE = 8;

/* The preview's cell size, matching what a cell occupies on a 1366px screen: the board is
 * about 995 px across 144 cells. A preview drawn larger flatters the picture. */
const PREVIEW_CELL = 7;

const usage = (problem) => {
  console.error(
    `${problem}\n\nnode scripts/pixelise.mjs <source> --at <x>,<y> --size <w>x<h> [--bg <step|none>] [--alpha <0..1>] [--only <steps>] [--out <path>]`,
  );
  process.exit(2);
};

const argv = process.argv.slice(2);
const source = argv[0];
if (!source || source.startsWith("--")) usage("a source image or SVG is required");

const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) usage(`--${name} needs a value`);
  return value;
};

const atMatch = /^(\d{1,3}),(\d{1,3})$/.exec(flag("at") ?? "");
if (!atMatch) usage("--at is required, as <x>,<y>");
const originX = Number(atMatch[1]);
const originY = Number(atMatch[2]);

const sizeMatch = /^(\d{1,3}|auto)x(\d{1,3}|auto)$/.exec(flag("size") ?? "");
if (!sizeMatch) usage("--size is required, as <w>x<h>, where one side may be `auto`");
if (sizeMatch[1] === "auto" && sizeMatch[2] === "auto") {
  usage("--size cannot be auto on both sides");
}

const backgroundFlag = flag("bg", "none");
const background = backgroundFlag === "none" ? null : Number.parseInt(backgroundFlag, 10);
if (
  background !== null &&
  (!Number.isInteger(background) || background < MIN_STEP || background > MAX_STEP)
) {
  usage(`--bg must be none or a palette step ${MIN_STEP}..${MAX_STEP}`);
}

const alphaFloor = Number(flag("alpha", "0.5"));
if (!(alphaFloor >= 0 && alphaFloor <= 1)) usage("--alpha must be between 0 and 1");

const allowed = flag("only", "")
  .split(",")
  .map((part) => part.trim())
  .filter(Boolean)
  .map((part) => {
    const step = Number.parseInt(part, 10);
    if (!Number.isInteger(step) || step < MIN_STEP || step > MAX_STEP) {
      usage(`--only must list palette steps ${MIN_STEP}..${MAX_STEP}`);
    }
    return step;
  });

const sourcePath = resolve(source);
const MIME = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const type = MIME[extname(sourcePath).toLowerCase()];
if (!type) usage(`unsupported source type: ${extname(sourcePath) || "(none)"}`);
const url = `data:${type};base64,${(await readFile(sourcePath)).toString("base64")}`;

const browser = await chromium.launch();
const page = await browser.newPage();

const trim = argv.includes("--trim");

/* The natural size decides an `auto` side. A viewBox-only SVG reports zero in some engines,
 * so it falls back to the default replaced-element box rather than dividing by zero.
 *
 * With --trim the drawing's own bounding box is measured here, at a fixed working resolution,
 * and every later step reads the picture through it. */
const natural = await page.evaluate(
  async ({ href, wanted }) => {
    const image = new Image();
    await new Promise((done, fail) => {
      image.onload = done;
      image.onerror = () => fail(new Error("the source could not be decoded"));
      image.src = href;
    });
    const w = image.naturalWidth || 300;
    const h = image.naturalHeight || 150;
    if (!wanted) return { w, h, crop: { x: 0, y: 0, w, h } };

    // A fixed working size rather than the natural one: an SVG's natural size can be tiny,
    // and a bounding box measured at that size rounds the drawing's edges away.
    const scale = Math.min(1600 / w, 1600 / h);
    const probe = document.createElement("canvas");
    probe.width = Math.max(1, Math.round(w * scale));
    probe.height = Math.max(1, Math.round(h * scale));
    const g = probe.getContext("2d", { willReadFrequently: true });
    g.drawImage(image, 0, 0, probe.width, probe.height);
    const data = g.getImageData(0, 0, probe.width, probe.height).data;

    let left = probe.width;
    let top = probe.height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < probe.height; y++) {
      for (let x = 0; x < probe.width; x++) {
        if (data[(y * probe.width + x) * 4 + 3] === 0) continue;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
    if (right < left || bottom < top) throw new Error("the source is entirely transparent");
    const crop = {
      x: left / scale,
      y: top / scale,
      w: (right - left + 1) / scale,
      h: (bottom - top + 1) / scale,
    };
    return { w: crop.w, h: crop.h, crop };
  },
  { href: url, wanted: trim },
);

const cellsWide =
  sizeMatch[1] === "auto"
    ? Math.max(1, Math.round((Number(sizeMatch[2]) * natural.w) / natural.h))
    : Number(sizeMatch[1]);
const cellsHigh =
  sizeMatch[2] === "auto"
    ? Math.max(1, Math.round((Number(sizeMatch[1]) * natural.h) / natural.w))
    : Number(sizeMatch[2]);

if (originX + cellsWide > COLS || originY + cellsHigh > ROWS) {
  await browser.close();
  usage(`${cellsWide}x${cellsHigh} at ${originX},${originY} runs off a ${COLS}x${ROWS} canvas`);
}

/* Rendered on transparent black, so a cell's coverage is its alpha and its colour is not
 * contaminated by a backdrop the picture never had. */
const sampled = await page.evaluate(
  async ({ href, w, h, ss, crop }) => {
    const image = new Image();
    await new Promise((done, fail) => {
      image.onload = done;
      image.onerror = () => fail(new Error("decode failed"));
      image.src = href;
    });
    const canvas = document.createElement("canvas");
    canvas.width = w * ss;
    canvas.height = h * ss;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    g.imageSmoothingQuality = "high";
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.drawImage(image, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
    const data = g.getImageData(0, 0, canvas.width, canvas.height).data;

    const cells = [];
    for (let cy = 0; cy < h; cy++) {
      for (let cx = 0; cx < w; cx++) {
        let red = 0;
        let green = 0;
        let blue = 0;
        let covered = 0;
        for (let y = 0; y < ss; y++) {
          for (let x = 0; x < ss; x++) {
            const i = ((cy * ss + y) * canvas.width + (cx * ss + x)) * 4;
            // Weighted by alpha: a nearly transparent bright edge must not drag the average.
            const alpha = data[i + 3] / 255;
            red += data[i] * alpha;
            green += data[i + 1] * alpha;
            blue += data[i + 2] * alpha;
            covered += alpha;
          }
        }
        cells.push(
          covered === 0
            ? { r: 0, g: 0, b: 0, coverage: 0 }
            : {
                r: red / covered,
                g: green / covered,
                b: blue / covered,
                coverage: covered / (ss * ss),
              },
        );
      }
    }
    return cells;
  },
  { href: url, w: cellsWide, h: cellsHigh, ss: SUPERSAMPLE, crop: natural.crop },
);

const hex = ({ r, g, b }) =>
  `#${[r, g, b]
    .map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0"))
    .join("")}`;

const choices = allowed.length > 0 ? allowed : PALETTE.map((_, i) => i).slice(MIN_STEP);

const nearestStep = (colour) => {
  let best = { step: choices[0], apart: Infinity };
  for (const step of choices) {
    const apart = distance(PALETTE[step], colour);
    if (apart < best.apart) best = { step, apart };
  }
  return best.step;
};

const cells = [];
const tally = new Map();
const record = (cx, cy, step) => {
  cells.push([cx, cy, step]);
  tally.set(step, (tally.get(step) ?? 0) + 1);
};

sampled.forEach((sample, index) => {
  const cx = originX + (index % cellsWide);
  const cy = originY + Math.floor(index / cellsWide);
  if (sample.coverage < alphaFloor) {
    if (background !== null) record(cx, cy, background);
    return;
  }
  record(cx, cy, nearestStep(hex(sample)));
});

const out = resolve(flag("out", `plans/${basename(sourcePath, extname(sourcePath))}.json`));
await mkdir(dirname(out), { recursive: true });
await writeFile(
  out,
  `${JSON.stringify({
    source: basename(sourcePath),
    at: [originX, originY],
    size: [cellsWide, cellsHigh],
    cells,
  })}\n`,
);

/* A preview is written every time, not on request.
 *
 * The plan is a list of numbers and a list of numbers cannot be judged. Every placement in it
 * is permanent in the archive once made — painting over a cell does not remove the record — so
 * the only safe order is render, look, then place. Drawn on the real ground at the size a cell
 * actually occupies on screen, because a logo that reads at 16 px a cell and dissolves at 7 is
 * a logo that does not work here. */
const preview = out.replace(/\.json$/, ".png");
await page.setViewportSize({ width: COLS * PREVIEW_CELL, height: ROWS * PREVIEW_CELL });
await page.evaluate(
  ({ cells, palette, ground, rule, cell, cols, rows }) => {
    document.body.style.margin = "0";
    const canvas = document.createElement("canvas");
    canvas.width = cols * cell;
    canvas.height = rows * cell;
    document.body.append(canvas);
    const g = canvas.getContext("2d");
    g.fillStyle = ground;
    g.fillRect(0, 0, canvas.width, canvas.height);
    for (const [x, y, step] of cells) {
      g.fillStyle = palette[step];
      g.fillRect(x * cell, y * cell, cell, cell);
    }
    g.strokeStyle = rule;
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i <= cols; i += 8) {
      g.moveTo(i * cell + 0.5, 0);
      g.lineTo(i * cell + 0.5, canvas.height);
    }
    for (let i = 0; i <= rows; i += 8) {
      g.moveTo(0, i * cell + 0.5);
      g.lineTo(canvas.width, i * cell + 0.5);
    }
    g.stroke();
  },
  {
    cells,
    palette: [...PALETTE],
    ground: GROUND,
    rule: GRID_LINE,
    cell: PREVIEW_CELL,
    cols: COLS,
    rows: ROWS,
  },
);
await page.screenshot({ path: preview });
await browser.close();

console.log(`${basename(sourcePath)}  ->  ${cellsWide}x${cellsHigh} cells at ${originX},${originY}`);
console.log(`${cells.length} placements, ${tally.size} colours`);
for (const [step, count] of [...tally].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  step ${String(step).padStart(2)}  ${PALETTE[step]}  ${String(count).padStart(5)}`);
}
console.log(`plan: ${out}`);
console.log(`preview: ${preview}`);
