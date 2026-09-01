/* The whole build. ADR 0002 chose esbuild over Vite, so this file is the toolchain —
   if it grows past a screen, that decision is being quietly reversed. */
import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const serve = process.argv.includes("--serve");
/* The benchmark has to reach the renderer's internals to measure them, and that handle must
   not exist in the shipped page. It is compiled in only here, into its own directory, so the
   production bundle is not merely "the same minus a line" — it is the same file it was. */
const bench = process.argv.includes("--bench");
const outdir = bench ? "dist-bench" : "dist";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp("public", outdir, { recursive: true });

const options = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "esm",
  target: ["es2022"],
  outdir,
  sourcemap: true,
  minify: !watch,
  define: {
    // `false` here lets esbuild drop the block entirely, so nothing about it reaches `dist`.
    __BENCH__: String(bench),
    /* The archive's address, from the environment. `/api` is the deployed default: the page
       and the archive share an origin because a serverless function forwards to the real one,
       which keeps a hostname Cloudflare reassigns on every tunnel restart out of both this
       repository and the shipped bundle. Set ARCHIVE_URL to reach the archive directly. */
    __ARCHIVE_URL__: JSON.stringify(process.env.ARCHIVE_URL ?? "/api"),
  },
  // NFR: the shipped bundle is budgeted in ADR 0002 at 60 KB uncompressed.
  metafile: true,
  logLevel: "info",
};

if (watch || serve) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  if (serve) {
    const { host, port } = await ctx.serve({ servedir: "dist", port: 5174 });
    console.log(`serving http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`);
  }
} else {
  const result = await esbuild.build(options);
  const js = Object.entries(result.metafile.outputs).find(([f]) => f.endsWith(".js"));
  // The bench build is instrumented and is not what ships, so holding it to the shipped
  // bundle's budget would either fail for the wrong reason or quietly relax the real one.
  if (js && !bench) {
    const kb = js[1].bytes / 1024;
    console.log(`bundle ${kb.toFixed(1)} KB uncompressed  (budget 60 KB)`);
    if (kb > 60) {
      console.error("over budget — see docs/adr/0002-client-render-and-build.md");
      process.exitCode = 1;
    }
  }
}
