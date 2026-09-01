import { chromium } from "playwright";
import { serveWithArchive } from "./local-server.mjs";
// The client asks its own origin for /api, so the local server has to forward it the way the
// deployment does. Serving dist/ alone would render an empty canvas and photograph it.
const ROOT = new URL("../dist/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const { base, close: closeServer } = await serveWithArchive(ROOT);
const b = await chromium.launch();
const p = await b.newPage({ viewport:{width:1440,height:900} });
p.on("pageerror", e => console.log("PAGE ERROR:", e.message));
await p.goto(base,{waitUntil:"load"});
await p.waitForTimeout(4000);
await p.locator("[data-ack]").click().catch(()=>{});
await p.waitForTimeout(1500);
console.log("painted:", await p.locator("#r-painted").innerText());
const box = await p.locator("#canvas").boundingBox();
// Tuvali tara, boyali bir hucre bulana kadar
let found = null;
for (let fx=0.2; fx<0.85 && !found; fx+=0.01) {
  for (let fy=0.2; fy<0.85; fy+=0.025) {
    await p.mouse.move(box.x+box.width*fx, box.y+box.height*fy);
    const step = await p.locator("#r-step").innerText();
    if (step !== "empty" && step !== "—") { found = {fx,fy,step}; break; }
  }
}
if (found) { await p.waitForTimeout(1200);
  console.log("bulundu:", await p.locator("#r-cell").innerText(), "step", found.step,
    "| owner:", await p.locator("#r-owner").innerText(),
    "| basis:", await p.locator("#r-basis").innerText(),
    "| proof:", await p.locator("#proof").isEnabled() ? "armed" : "disabled");
} else console.log("boyali hucre bulunamadi");
await p.screenshot({ path: "shots/proof.png" });
await b.close(); closeServer();
