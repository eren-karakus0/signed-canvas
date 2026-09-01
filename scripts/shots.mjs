/* Screenshots of the built client, over HTTP because ES modules do not load from file://
   in Chromium or WebKit. Output goes to shots/ for the identity review loop. */

import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const ROOT = new URL("../dist/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const OUT = new URL("../shots/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
};

const server = createServer(async (req, res) => {
  const rel = normalize(decodeURI((req.url ?? "/").split("?")[0])).replace(/^([/\\])+/, "");
  try {
    const path = join(ROOT, rel === "" ? "index.html" : rel);
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;
await mkdir(OUT, { recursive: true });

const SHOTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "wide", width: 1920, height: 1080 },
  { name: "narrow", width: 420, height: 820 },
];

const browser = await chromium.launch();
for (const shot of SHOTS) {
  const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  // Hover a cell so the crosshair and the readout are in the frame: an empty readout would
  // not show whether hit-testing agrees with what is drawn.
  const box = await page.locator("#canvas").boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.52);
    await page.waitForTimeout(120);
  }

  await page.screenshot({ path: join(OUT, `${shot.name}.png`) });
  const readout = await page.locator("#readout").innerText();
  console.log(`${shot.name.padEnd(8)} ${shot.width}x${shot.height}  readout: ${readout.replace(/\s+/g, " ")}`);
  if (errors.length) console.log(`  page errors: ${errors.join(" | ")}`);
  await page.close();
}
await browser.close();
server.close();
