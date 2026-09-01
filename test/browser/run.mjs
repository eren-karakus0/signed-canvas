/* Build the browser conformance page and run it in all three engines.
 *
 * Reports the shipped size of the crypto path alongside the result: ADR 0002 budgets the
 * whole bundle at 60 KB, and the verifier is the only production dependency in it.
 */

import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import * as esbuild from "esbuild";
import { chromium, firefox, webkit } from "playwright";

const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const out = await mkdtemp(join(tmpdir(), "signed-canvas-crypto-"));

const build = await esbuild.build({
  entryPoints: [join(here, "crypto-check.ts")],
  bundle: true,
  format: "esm",
  target: ["es2022"],
  outfile: join(out, "check.js"),
  minify: true,
  metafile: true,
});
const bytes = Object.values(build.metafile.outputs)[0].bytes;

await writeFile(
  join(out, "index.html"),
  `<!doctype html><meta charset="utf-8"><title>running</title><script type="module" src="./check.js"></script>`,
);
await writeFile(
  join(out, "vectors.json"),
  await readFile(join(here, "..", "vectors", "technocore-318.json")),
);

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json" };
const server = createServer(async (req, res) => {
  const name = (req.url ?? "/").split("?")[0].replace(/^\/+/, "") || "index.html";
  try {
    const body = await readFile(join(out, name));
    res.writeHead(200, { "content-type": TYPES[extname(name)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

console.log(`verifier bundle: ${(bytes / 1024).toFixed(1)} KB minified\n`);

let failed = false;
for (const [name, engine] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  const browser = await engine.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base, { waitUntil: "load" });
  await page.waitForFunction('document.title === "DONE"', null, { timeout: 60000 });
  const result = await page.evaluate(() => window.__cryptoCheck);

  const bad = result.results.filter((r) => !r.ok);
  if (bad.length || errors.length) failed = true;
  console.log(
    `${name.padEnd(9)} ${browser.version().padEnd(16)} ${result.passed} passed, ${result.failed} failed  ${bad.length ? "FAIL" : "OK"}`,
  );
  for (const r of bad.slice(0, 6)) console.log(`   ${r.name}: ${r.detail}`);
  if (errors.length) console.log(`   page errors: ${errors.join(" | ")}`);
  await browser.close();
}

server.close();
process.exit(failed ? 1 : 0);
