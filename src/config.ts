/* What this build points at.
 *
 * The room name is permanent and public: a room exists because someone wrote to it, and the
 * first writer takes the name. Changing it here does not move a canvas, it starts a new one.
 */

/** The canvas room. Currently the room T-2 load-tested; the production name is not chosen. */
export const ROOM = "fplace";

/**
 * Where the archive answers.
 *
 * Set at build time by `build.mjs` from `$ARCHIVE_URL`, defaulting to the relative `/api`.
 * That default is the deployed shape: the page and the archive share an origin, because
 * `api/proxy.js` forwards to the real archive from the server side. Three things follow
 * from a same-origin archive, and the third is the one worth the arrangement:
 *
 *   - no CORS between this page and our own archive, at all;
 *   - the archive's address is not in this repository and not in the shipped bundle, so
 *     moving it is an environment variable rather than a rebuild and a redeploy;
 *   - a temporary hostname stops being a published fact. The archive currently sits behind a
 *     Cloudflare *quick* tunnel, whose name Cloudflare reassigns on every restart. Baked into
 *     a build, that name is a broken site waiting for a restart.
 *
 * For local work, point it straight at the archive and skip the proxy:
 *
 *     ARCHIVE_URL=https://<tunnel>.trycloudflare.com npm run build
 *
 * Empty means no archive: the client then reads the room directly — the newest 200 placements
 * and nothing older, which the interface states rather than passing off as the whole canvas.
 * Placing still works, since service 0.11.0 let a browser write to the room and read the
 * answer; the archive is what shows an older canvas, not what permits a pixel.
 */
declare const __ARCHIVE_URL__: string;
export const ARCHIVE_URL: string = __ARCHIVE_URL__;

export const hasArchive = (): boolean => ARCHIVE_URL !== "";

/**
 * Where a signed write is forwarded, when there is somewhere to forward it.
 *
 * This used to be the only way to place a pixel, because technocore.chat sent no
 * `access-control-allow-origin` anywhere and a browser could write but never read the answer.
 * That stopped being true in service 0.11.0 (2026-08-31) for successful responses — but *not*
 * for its 503s, which carry no CORS headers at all (measured: 9 of 9 `200`s had them, 0 of 11
 * `503`s did). So a browser writing directly cannot tell load shedding from the network being
 * down, and FR-11 asks for exactly that distinction.
 *
 * Hence both lanes. The relay is preferred because it is the only one that can name the
 * refusal; `place()` falls back to writing straight to the room when the relay does not
 * answer, because a relay that is the only write path is a relay that could censor one.
 */
export const relayUrl = (): string | undefined =>
  ARCHIVE_URL === "" ? undefined : `${ARCHIVE_URL.replace(/\/$/, "")}/relay`;
