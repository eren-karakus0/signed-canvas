/* A local stand-in for the deployment: static files, plus /api forwarded to the archive.
 *
 * The client asks for `/api/...` on its own origin, because that is what it does once
 * deployed — `api/proxy.js` forwards it. Serving `dist/` alone would leave every archive
 * request a 404 here and nowhere else, which is the worst shape for a local check: the canvas
 * comes up empty and the screenshot looks like a rendering bug.
 *
 * So local matches deployed, and it is the same one variable that configures both.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/**
 * Where the archive really is, for this machine.
 *
 * Reads `.env.local` when there is one — the file `vercel env pull` writes, and the same
 * variable the deployed function uses — so a local run needs no ceremony beyond having pulled
 * it once. It is gitignored and holds the tunnel's temporary hostname, nothing durable.
 *
 * Throws rather than defaulting. The alternative is a benchmark that measures paint work on
 * an empty grid, or a screenshot of a canvas that failed to load, and both of those report
 * better news than the truth.
 *
 * @throws {Error} when no archive address is configured.
 */
export function archiveOrigin() {
  if (!process.env.ARCHIVE_ORIGIN && existsSync(".env.local")) {
    try {
      process.loadEnvFile(".env.local");
    } catch {
      // An unreadable or malformed file is not worth failing over; the check below reports
      // the same missing variable either way.
    }
  }
  const origin = process.env.ARCHIVE_ORIGIN ?? process.env.ARCHIVE_URL ?? "";
  if (origin === "" || origin === "/api") {
    throw new Error(
      "no archive address: set ARCHIVE_ORIGIN, or run `vercel env pull .env.local`.\n" +
        "  ARCHIVE_ORIGIN=https://<name>.trycloudflare.com npm run shots",
    );
  }
  return origin.replace(/\/$/, "");
}

/**
 * Serve `root` on a free port, forwarding `/api/*` to the archive.
 *
 * @returns {Promise<{ base: string, close: () => void }>}
 */
export async function serveWithArchive(root, origin = archiveOrigin()) {
  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";

    if (url.startsWith("/api/")) {
      const target = origin + url.slice("/api".length);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        const upstream = await fetch(target, {
          method: req.method,
          ...(chunks.length === 0
            ? { headers: { accept: "application/json" } }
            : {
                headers: { "content-type": "application/json" },
                body: Buffer.concat(chunks),
              }),
        });
        const headers = {};
        for (const name of ["content-type", "cache-control", "x-relay-upstream", "retry-after"]) {
          const value = upstream.headers.get(name);
          if (value !== null) headers[name] = value;
        }
        res.writeHead(upstream.status, headers);
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (error) {
        res.writeHead(504, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "the archive did not answer", detail: String(error) }));
      }
      return;
    }

    let rel = url.split("?")[0];
    while (rel.startsWith("/")) rel = rel.slice(1);
    if (rel === "") rel = "index.html";
    try {
      const body = await readFile(join(root, rel));
      res.writeHead(200, { "content-type": TYPES[extname(rel)] ?? "text/html; charset=utf-8" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}/`,
    close: () => server.close(),
  };
}
