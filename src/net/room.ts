/* Writing a pixel to technocore.chat, and every way that fails.
 *
 * The failure table in `design.md` is implemented here literally, with one adaptation forced
 * by the T-5 finding. The timeout rule was written as "re-read the room and check for our own
 * signature before retrying". The room did not return signatures then, so that check was
 * impossible as written — but the placement text already carries a random six-character
 * token, added for the duplicate filter, and it makes each attempt unique. Looking for our
 * DID and that exact text answers the same question more directly than a signature would.
 *
 * A write that times out may already have landed. Retrying blindly places a second pixel.
 *
 * TWO LANES, and why there are two.
 *
 * Measured 2026-08-29 against service 0.10.0: technocore.chat sent no
 * `access-control-allow-origin` anywhere — its own first line still reads "No auth, no
 * client, no JS". A browser could send a signed write, because that is a simple GET, but
 * never read the answer, so every write had to go through our relay.
 *
 * Re-measured 2026-09-01 against 0.11.2: the service now answers every origin with `*`, and a
 * preflight allows GET and POST. Confirmed from a real `http://` origin in Chromium, Firefox
 * and WebKit rather than from response headers, since it is the browser that enforces CORS.
 *
 * So the relay is no longer required, and it must not be the only way to place a pixel:
 * while it is, this project is the single point that could censor a write, which is a worse
 * property than the round trip it saves. It is still tried first — it centralises backoff
 * against a dependency measured at 3-25% 503, and it holds the signature the instant the
 * write is accepted. But when the relay does not answer, the write goes straight to the room,
 * and the archive picks the signature up out of the room on its next pass.
 *
 * The distinction that makes the fallback safe is "did the relay reach technocore and repeat
 * its answer, or did it never get there". Both can arrive as a 503. Re-sending a write the
 * service already refused as a duplicate is a different mistake from abandoning one it would
 * have taken, so this is never inferred: the relay states it in `x-relay-upstream`, and its
 * absence is read as "no answer from upstream", which is the safe default.
 */

import { messagePayload } from "../crypto/canonical.ts";
import { type Identity, sign } from "../identity/key.ts";

export const BASE_URL = "https://technocore.chat";
const READ_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 20_000;
const BACKOFF_MS = [700, 1800, 4200];

/** Six base36 characters. Makes every attempt's text unique, for the duplicate filter. */
export function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

export interface RoomMessage {
  readonly seq: number;
  readonly ts: string;
  readonly from: string;
  readonly text: string;
  readonly nonce: number;
  /** Present since service 0.11.0. Absent on older records — "not re-verifiable", not "invalid". */
  readonly sig?: string | null;
}

/** Which path carried the write. Placing is the same either way; witnessing is not. */
export type Lane = "relay" | "room";

export type Outcome =
  /** The pixel is in the room. */
  | {
      readonly kind: "placed";
      readonly seq: number;
      readonly signature: string;
      readonly nonce: string;
      readonly text: string;
      readonly via: Lane;
    }
  /** Refused, and the person needs to know why. `retryAfter` is seconds where the server said. */
  | { readonly kind: "refused"; readonly reason: string; readonly retryAfter?: number }
  /** We could not find out. The pixel may or may not be in the room. */
  | { readonly kind: "unknown"; readonly reason: string };

export class RoomError extends Error {
  readonly status: number | "timeout" | "network";
  readonly body: string;
  readonly retryAfter?: number;
  /**
   * The status technocore.chat gave our relay, when the relay reached it.
   *
   * `null` means this failure carries no word from the service: either the request never went
   * through a relay, or the relay could not deliver an answer. Never inferred from the status
   * code, which cannot tell the two apart.
   */
  readonly upstreamStatus: number | null;

  constructor(
    message: string,
    status: number | "timeout" | "network",
    body = "",
    upstreamStatus: number | null = null,
  ) {
    super(message);
    this.name = "RoomError";
    this.status = status;
    this.body = body;
    this.upstreamStatus = upstreamStatus;
  }
}

interface Answer {
  readonly body: string;
  readonly upstreamStatus: number | null;
}

/** The relay's word about upstream, or null when it said nothing. */
function upstreamOf(headers: Headers): number | null {
  const raw = headers.get("x-relay-upstream");
  if (raw === null) return null;
  const status = Number(raw);
  return Number.isInteger(status) && status > 0 ? status : null;
}

async function request(
  url: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
  init: RequestInit = {},
): Promise<Answer> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: abort.signal,
      headers: { accept: "text/plain", ...(init.headers ?? {}) },
      ...(init.method === undefined ? {} : { method: init.method }),
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    const body = await response.text();
    const upstreamStatus = upstreamOf(response.headers);
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const error = new RoomError(
        `${response.status}`,
        response.status,
        body.slice(0, 200),
        upstreamStatus,
      );
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        (error as { retryAfter: number }).retryAfter = retryAfter;
      }
      throw error;
    }
    return { body, upstreamStatus };
  } catch (error) {
    if (error instanceof RoomError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new RoomError("timed out", "timeout");
    }
    throw new RoomError(error instanceof Error ? error.message : "network failure", "network");
  } finally {
    clearTimeout(timer);
  }
}

/** Messages newer than `since`, oldest first. */
export async function read(room: string, since = 0): Promise<RoomMessage[]> {
  const { body } = await request(
    `${BASE_URL}/r/${encodeURIComponent(room)}?since=${since}&limit=${READ_LIMIT}&format=json`,
  );
  const parsed = JSON.parse(body) as { messages?: RoomMessage[] };
  return parsed.messages ?? [];
}

/** The highest nonce this identity has already used in this room, or 0. */
export async function lastNonce(room: string, did: string): Promise<number> {
  const messages = await read(room);
  let highest = 0;
  for (const message of messages) {
    if (message.from === did && Number.isFinite(message.nonce)) {
      highest = Math.max(highest, Number(message.nonce));
    }
  }
  return highest;
}

/**
 * The message with exactly this text from this identity, if it reached the room.
 *
 * The whole message, not just its sequence, because an attempt that landed may not be the
 * attempt we last signed — each retry carries a fresh nonce, so the record in the room is the
 * only account of which one the service actually took.
 */
async function landed(
  room: string,
  did: string,
  text: string,
  since: number,
): Promise<RoomMessage | null> {
  const messages = await read(room, since);
  for (const message of messages) {
    if (message.from === did && message.text === text) return message;
  }
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface PlaceRequest {
  readonly identity: Identity;
  readonly room: string;
  readonly text: string;
  /**
   * A fresh nonce, strictly greater than every one this key has used in this room.
   *
   * A function rather than a value, because every attempt needs its own. A nonce is spent the
   * moment it is issued: while one attempt is backing off, another placement can take a
   * higher one and land, and the first attempt's retry is then refused with *"is not greater
   * than … the last one this key used"*. That was a real 400 on the deployed site, and it
   * only appears when someone places faster than the service answers.
   */
  readonly nextNonce: () => string;
  /** Room head before the attempt, so the timeout check only reads what came after. */
  readonly sinceSeq: number;
  /** Called when a refusal is being retried, so the interface can say what is happening. */
  readonly onRetry?: (attempt: number, reason: string) => void;
  /** The retry schedule. Overridable so tests can force every path without waiting for it. */
  readonly backoffMs?: readonly number[];
  /**
   * Our own relay, tried first when present. Optional: without it, and whenever it fails to
   * answer, the write goes straight to the room.
   */
  readonly relayUrl?: string;
}

/**
 * Write one signed placement, handling every refusal the service is known to produce.
 *
 * Never throws for a server refusal — a refusal is an outcome the interface has to render,
 * not an exception. It throws only if signing itself fails, which is a bug here rather than
 * a condition out there.
 */
export async function place(request_: PlaceRequest): Promise<Outcome> {
  const { identity, room, text, nextNonce, sinceSeq, onRetry, relayUrl } = request_;
  const backoff = request_.backoffMs ?? BACKOFF_MS;

  // Signed per attempt, not once. See `nextNonce` above: re-sending a nonce that was issued
  // before a concurrent placement is a 400 the person cannot act on. The *text* is fixed for
  // the whole call, including its random token, which is what makes the "did it land anyway"
  // check possible at all.
  let nonce = "";
  let signature = "";
  const signAttempt = async (): Promise<void> => {
    nonce = nextNonce();
    signature = await sign(identity, messagePayload({ room, nonce, text }));
  };

  /** What we can honestly say about a message the room already holds. */
  const fromRoom = (message: RoomMessage, via: Lane): Outcome => ({
    kind: "placed",
    seq: message.seq,
    // The record in the room, not the attempt we happen to hold. They differ whenever an
    // earlier attempt landed late, and reporting ours would export a proof for a message
    // that was never published.
    nonce: String(message.nonce),
    signature: typeof message.sig === "string" && message.sig !== "" ? message.sig : signature,
    text,
    via,
  });

  let lane: Lane = relayUrl === undefined ? "room" : "relay";

  const sendDirect = async (): Promise<number> => {
    const url =
      `${BASE_URL}/r/${encodeURIComponent(room)}/say-signed/${identity.did}/${signature}/` +
      `${nonce}/${encodeURIComponent(text)}`;
    const { body } = await request(url);
    // The answer to a write is a room view: many [n] markers, ours last. The first one is
    // the oldest message still in the window and has nothing to do with this write.
    const markers = [...body.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    return markers.length === 0 ? 0 : Math.max(...markers);
  };

  const sendViaRelay = async (): Promise<number> => {
    const { body } = await request(relayUrl!, REQUEST_TIMEOUT_MS, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ did: identity.did, sig: signature, nonce, text }),
    });
    const parsed = JSON.parse(body) as { seq?: number };
    return Number(parsed.seq ?? 0);
  };

  for (let attempt = 0; ; attempt++) {
    try {
      await signAttempt();
      const seq = lane === "relay" ? await sendViaRelay() : await sendDirect();
      return { kind: "placed", seq, signature, nonce, text, via: lane };
    } catch (error) {
      if (!(error instanceof RoomError)) throw error;

      // The relay produced no word from technocore, so this failure says nothing about
      // whether the write was refused — only that we did not hear. Fall through to the room.
      //
      // The room is asked first regardless. The relay's own 504 states outright that the
      // write may have landed and the answer been lost, and re-sending it would place a
      // second pixel — the exact mistake the timeout rule exists to prevent.
      if (lane === "relay" && error.upstreamStatus === null) {
        const message = await landed(room, identity.did, text, sinceSeq).catch(() => null);
        if (message !== null) return fromRoom(message, "relay");
        lane = "room";
        onRetry?.(attempt + 1, "the relay did not answer — writing to the room directly");
        // No backoff: this is a different path, not another go at the same one.
        continue;
      }

      // 503 — the common failure, measured at 3-25% depending on the hour. The request was
      // shed, not applied, so retrying is both safe and correct.
      if (error.status === 503 && attempt < backoff.length) {
        onRetry?.(attempt + 1, "the service is shedding load");
        await sleep(backoff[attempt]!);
        continue;
      }

      // A timeout may have landed. Ask the room before doing anything else.
      if (error.status === "timeout" || error.status === "network") {
        const message = await landed(room, identity.did, text, sinceSeq).catch(() => null);
        if (message !== null) return fromRoom(message, lane);
        if (attempt < backoff.length) {
          onRetry?.(attempt + 1, "no answer — the pixel is not in the room, trying again");
          await sleep(backoff[attempt]!);
          continue;
        }
        return { kind: "unknown", reason: "the network did not answer and the room has no record yet" };
      }

      if (error.status === 429) {
        const wait = error.retryAfter;
        return {
          kind: "refused",
          reason: "the service is rate-limiting this key",
          ...(wait === undefined ? {} : { retryAfter: wait }),
        };
      }
      if (error.status === 422) {
        return { kind: "refused", reason: "the room refused this text as a duplicate" };
      }
      if (error.status === 400) {
        return { kind: "refused", reason: `the write was malformed or the nonce was reused — ${error.body}` };
      }
      if (error.status === 403) {
        return { kind: "refused", reason: "the signature did not verify — the client and the server disagree about the bytes" };
      }
      return { kind: "refused", reason: `${error.status}: ${error.body || error.message}` };
    }
  }
}
