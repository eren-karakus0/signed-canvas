/* End to end, against the live service: does clicking actually place a signed pixel?
 *
 * Everything up to now has been measured in pieces — the signer against fixtures, the
 * failures against stubs, the archive against a temp file. This drives a real browser at the
 * built client, clicks a cell, and then asks technocore.chat and our own archive whether the
 * pixel is really there. It is the only test that can fail for a reason none of the others
 * can see.
 *
 * It writes to a public room permanently. That is the point, and it is why the cell is
 * chosen at random rather than fixed: repeated runs should not keep overwriting one cell.
 *
 * With `--no-relay` the relay request is cut at the browser, which is the only honest way to
 * test the fallback: the relay is healthy, so refusing to *reach* it is the failure a real
 * outage produces. What is being proven is that a browser can place a pixel with nothing of
 * ours in the path — the property that stops this project from being able to censor a write.
 */

import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { archiveOrigin, serveWithArchive } from "../../scripts/local-server.mjs";

const ROOT = new URL("../../dist/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const CONFIG = new URL("../../src/config.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const source = await readFile(CONFIG, "utf8");
const ROOM = /export const ROOM = "([^"]+)"/.exec(source)?.[1];
if (!ROOM) {
  console.error("could not read ROOM from src/config.ts");
  process.exit(2);
}
/* The archive's address is no longer compiled into the client — the deployed page asks its
   own origin for /api and a function forwards it. So the test gets the real address the same
   way the deployment does, from the environment, and serves /api locally the same way. */
let ARCHIVE;
try {
  ARCHIVE = archiveOrigin();
} catch (error) {
  console.error(String(error.message));
  process.exit(2);
}

const { base, close: closeServer } = await serveWithArchive(ROOT, ARCHIVE);

console.log(`room    ${ROOM}`);
console.log(`archive ${ARCHIVE}`);
console.log(`client  ${base}\n`);

const cutRelay = process.argv.includes("--no-relay");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

if (cutRelay) {
  // Aborted rather than answered with an error status: a relay that replies at all may be
  // relaying technocore's answer, and the client is required to tell those apart. This is
  // the case where it hears nothing.
  await page.route("**/relay", (route) => route.abort("connectionrefused"));
  console.log("relay: CUT — the write must reach the room directly\n");
}

await page.goto(base, { waitUntil: "load" });
await page.waitForFunction('document.querySelector("#ramp")?.children.length === 15', null, { timeout: 30000 });
console.log("ramp built");

// The identity gate blocks placement until it is acknowledged. Clicking through it is part
// of what is being tested: if it did not block, that is a T-8 regression.
const gateVisible = await page.locator("#gate").isVisible();
console.log(`identity gate shown: ${gateVisible}`);
if (!gateVisible) {
  console.error("FAIL: a fresh profile must be shown the key warning before placing");
  process.exit(1);
}
const did = await page.locator("[data-did]").getAttribute("title");
console.log(`identity ${did}`);
await page.locator("[data-ack]").click();
await page.waitForSelector("#gate", { state: "hidden" });

// Pick a random step and click a random point on the canvas.
const step = 1 + Math.floor(Math.random() * 15);
await page.locator(`#ramp button[aria-label="step ${String(step).padStart(2, "0")}"]`).click();

const box = await page.locator("#canvas").boundingBox();
const jitterX = 0.3 + Math.random() * 0.4;
const jitterY = 0.3 + Math.random() * 0.4;
await page.mouse.move(box.x + box.width * jitterX, box.y + box.height * jitterY);
await page.waitForTimeout(150);
const cell = await page.locator("#r-cell").innerText();
console.log(`\nclicking cell ${cell} with step ${step}…`);
await page.mouse.click(box.x + box.width * jitterX, box.y + box.height * jitterY);

await page.waitForFunction(
  () => {
    const text = document.querySelector("#status")?.textContent ?? "";
    return text.includes("placed at seq") || text.includes("not placed");
  },
  null,
  { timeout: 90000 },
);
const status = await page.locator("#status").innerText();
console.log(`status: ${status}`);

/* T-10: hovering the cell just placed must name its owner, say what the claim rests on, and
   arm the proof export. A canvas that says "every pixel is signed" and cannot show you whose
   is whose has not made the claim, only the slogan. */
await page.mouse.move(box.x + box.width * 0.05, box.y + box.height * 0.05);
await page.waitForTimeout(200);
await page.mouse.move(box.x + box.width * jitterX, box.y + box.height * jitterY);
await page.waitForFunction(
  () => (document.querySelector("#r-owner")?.textContent ?? "—") !== "—",
  null,
  { timeout: 20000 },
).catch(() => {});
const owner = await page.locator("#r-owner").innerText();
const basis = await page.locator("#r-basis").innerText();
const proofEnabled = await page.locator("#proof").isEnabled();
console.log(`
hover → owner ${owner} · basis ${basis} · proof ${proofEnabled ? "armed" : "DISABLED"}`);

/* The proof *text* is a pure function and is asserted in test/proof.test.ts, including that
   a witnessed export verifies independently. Reading the clipboard in headless Chromium is
   unreliable, so what is checked here is the part only a browser can answer: the button
   arms, the click is accepted, and the interface confirms what it copied. */
let proofConfirmed = "";
if (proofEnabled) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.locator("#proof").click();
  await page.waitForFunction(
    () => /copied|dialog|could not copy/.test(document.querySelector("#status")?.textContent ?? ""),
    null,
    { timeout: 10000 },
  ).catch(() => {});
  proofConfirmed = await page.locator("#status").innerText();
}

if (errors.length) console.log(`page errors: ${errors.join(" | ")}`);
await browser.close();
closeServer();

/* The service sheds load at a measured 3-25%, so a verification read that does not retry
   fails for the same reason the product is built to survive. A test that cannot tolerate
   what the product tolerates reports the dependency's mood, not the code's correctness. */
async function getJson(url, attempts = 6) {
  let last = "";
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (response.ok && body.trimStart().startsWith("{")) return JSON.parse(body);
      last = `${response.status} ${body.slice(0, 60)}`;
    } catch (error) {
      last = String(error);
    }
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  throw new Error(`gave up on ${url}: ${last}`);
}

const placed = /placed at seq (\d+)/.exec(status);
if (!placed) {
  console.error("\nFAIL: the pixel was not placed");
  process.exit(1);
}
const seq = Number(placed[1]);

// Now the part only the network can answer: is it really in the room, and did our own
// archive see it and hold a signature for it?
const room = await getJson(`https://technocore.chat/r/${ROOM}?since=${seq - 1}&limit=5&format=json`);
const mine = (room.messages ?? []).find((m) => m.seq === seq);
console.log(`\nin the room:  ${mine ? `[${mine.seq}] ${mine.from.slice(0, 16)}… ${mine.text}` : "NOT FOUND"}`);

const cellMatch = /(\d+),\s*(\d+)/.exec(cell);
// Give the ingest loop a moment: it long-polls, so the pixel usually appears within seconds.
await new Promise((r) => setTimeout(r, 6000));
const history = await getJson(`${ARCHIVE}/cell/${Number(cellMatch[1])}/${Number(cellMatch[2])}`);
const archived = (history.placements ?? []).find((p) => p.seq === seq);
console.log(
  `in the archive: ${archived ? `seq ${archived.seq} witnessed=${archived.witnessed} sig=${archived.sig ? archived.sig.slice(0, 12) + "…" : "null"}` : "not yet (ingest polls on a delay)"}`,
);

// Any of the three outcomes is a pass here: what is being tested is that the interface
// *says* which one happened. A silent copy button is the failure.
const proofOk = /copied|dialog|could not copy/.test(proofConfirmed);
console.log(`proof export: ${proofOk ? proofConfirmed : "the interface did not confirm a copy"}`);

// With the relay cut, the interface must also say which lane carried it. Silently using
// the fallback would be correct behaviour reported as something it was not.
const laneOk = !cutRelay || /straight to the room/.test(status);
if (cutRelay) {
  console.log(`lane: ${laneOk ? "reported as direct" : "NOT REPORTED — the status does not name the lane"}`);
}

const ok = Boolean(mine) && mine.from === did && mine.text.startsWith(`px ${Number(cellMatch[1])},${Number(cellMatch[2])} `) && owner !== "—" && proofOk && laneOk;
console.log(`\n${ok ? "PASS" : "FAIL"} — the room ${ok ? "holds" : "does not hold"} the pixel this client signed`);
process.exit(ok ? 0 : 1);
