/* The archive, served from this page's own origin.
 *
 * Everything under /api is forwarded to $ARCHIVE_ORIGIN and answered back unchanged. It is a
 * proxy and nothing else — it does not read the body, does not decide anything, and cannot
 * make a claim the archive did not make.
 *
 * Why it exists at all, given the archive is already reachable over HTTPS:
 *
 *   1. The archive sits behind a Cloudflare *quick* tunnel, and Cloudflare reassigns that
 *      hostname on every restart. A hostname compiled into the client is a site that breaks
 *      on a restart and needs a rebuild and a redeploy to fix. Here it is one environment
 *      variable, changed without touching the build.
 *   2. Same origin means no CORS between this page and our own archive, so no preflight, no
 *      exposed-header list, and no class of failure that only appears in a browser.
 *
 * What it must not do is add trust. The archive already states, per pixel, whether it holds a
 * signature; this forwards that answer verbatim, including the headers a client reads to tell
 * one failure from another.
 */

/* Reached through an explicit rewrite in `vercel.json` rather than a `[...path]` catch-all
   file. Measured under `vercel dev`: the catch-all matched `/api/health` and `/api/a` and
   404'd on `/api/a/b` and `/api/cell/20/20`, i.e. it behaved like a single-segment `[path]`.
   Rather than deploy something whose routing is a guess, the rewrite states the mapping. */

/** Headers worth carrying back. Everything else is this platform's business, not the caller's. */
const PASS_THROUGH = [
  "content-type",
  "cache-control",
  // The client's whole fallback decision hangs on this one: present means the relay reached
  // technocore.chat and is repeating its answer, absent means it never got there. Dropping it
  // here would silently turn every refusal into "no word from upstream", and a browser would
  // re-send writes the service had already refused.
  "x-relay-upstream",
  "retry-after",
];

/** Requests are small — a signed placement is a few hundred bytes. Anything larger is not ours. */
const MAX_BODY_BYTES = 8192;

const TIMEOUT_MS = 25_000;

export default async function handler(request, response) {
  const origin = process.env.ARCHIVE_ORIGIN;
  if (!origin) {
    // Configuration, not a transient failure, and it is worth saying so plainly: a proxy
    // pointed nowhere would otherwise look exactly like an archive that is down.
    response.status(503).json({ error: "ARCHIVE_ORIGIN is not set on this deployment" });
    return;
  }

  if (request.method !== "GET" && request.method !== "POST") {
    response.status(405).json({ error: "only GET and POST reach the archive" });
    return;
  }

  // `path` is everything after /api, handed over by the rewrite. Split and re-encode rather
  // than pasting: a segment carrying `..` or a slash must not be able to steer this at a
  // different path on the archive.
  const raw = Array.isArray(request.query.path) ? request.query.path[0] : (request.query.path ?? "");
  const suffix = String(raw)
    .split("/")
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..")
    .map(encodeURIComponent)
    .join("/");

  const extra = new URLSearchParams();
  for (const [key, value] of Object.entries(request.query)) {
    if (key !== "path") extra.append(key, String(value));
  }
  const query = extra.toString();
  const target = `${origin.replace(/\/$/, "")}/${suffix}${query ? `?${query}` : ""}`;

  let body;
  if (request.method === "POST") {
    body = typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {});
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      response.status(413).json({ error: `body must be at most ${MAX_BODY_BYTES} bytes` });
      return;
    }
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(target, {
      method: request.method,
      signal: abort.signal,
      ...(body === undefined
        ? { headers: { accept: "application/json" } }
        : { headers: { "content-type": "application/json" }, body }),
    });

    for (const name of PASS_THROUGH) {
      const value = upstream.headers.get(name);
      if (value !== null) response.setHeader(name, value);
    }
    response.status(upstream.status).send(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    // 504 rather than 502, and the distinction is load-bearing for a write: the archive may
    // have received it and answered into a connection that was already gone. The client reads
    // this the same way it reads a timeout — ask the room, never re-send blindly.
    response
      .status(504)
      .json({ error: "the archive did not answer", detail: String(error).slice(0, 160) });
  } finally {
    clearTimeout(timer);
  }
}
