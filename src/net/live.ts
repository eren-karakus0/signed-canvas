/* Following the room as it happens.
 *
 * Until now the client loaded a snapshot once and never looked again: someone else's pixel
 * appeared when you reloaded, and not before. `since()` was written for T-6 and never wired
 * to anything, which is a quieter kind of missing than a broken feature.
 *
 * The room is followed directly rather than through our archive, for two reasons that both
 * matter more than saving a hop:
 *
 *   - the service holds a read open until a message lands (`wait=`), so a pixel arrives when
 *     it is written rather than at the top of some interval of ours;
 *   - the record carries `sig` since 0.11.0, so a placement can be **verified in the
 *     browser** before it is drawn. Every pixel that appears live has been checked here,
 *     which is the product's whole claim happening in front of the person reading it.
 *
 * The archive is still the source for the initial canvas — the room returns at most 200
 * messages and cannot page backwards — and it is the fallback when the service is shedding,
 * which it does at a measured 3-25% and occasionally far more.
 */

import { messagePayload } from "../crypto/canonical.ts";
import { verifyPayload } from "../crypto/verify.ts";
import { parsePlacement } from "../canvas/wire.ts";
import { read } from "./room.ts";
import { since as archiveSince } from "./archive.ts";

/** Seconds to hold each read open. The service caps this at 10. */
const WAIT_SECONDS = 10;
/** Consecutive room failures before falling back to the archive for a round. */
const FAILURES_BEFORE_FALLBACK = 2;
const BACKOFF_MS = [1_000, 3_000, 8_000, 20_000];

export interface LivePlacement {
  readonly seq: number;
  readonly ts: string;
  readonly did: string;
  readonly cx: number;
  readonly cy: number;
  readonly step: number;
  /**
   * The signature was checked in this browser, against the payload rebuilt from the record.
   *
   * False means the record carried none — everything written before service 0.11.0 — or that
   * the placement reached us through the archive, which reports its own verdict rather than
   * handing over the bytes. Never a claim that something failed to verify: a signature that
   * is present and does not check out is dropped, not drawn.
   */
  readonly verified: boolean;
}

export interface LiveEvents {
  /** A placement to draw. Called in sequence order, oldest first. */
  onPlacement(placement: LivePlacement): void;
  /** Where the stream currently is, so the caller can show it and resume from it. */
  onSeq(seq: number): void;
  /** Whether pixels are arriving as they are written, and why not when they are not. */
  onStatus(live: boolean, detail: string): void;
}

export interface Follower {
  stop(): void;
}

/**
 * Follow `room` from `fromSeq`, drawing what arrives.
 *
 * Never throws and never stops on its own: a service that is down comes back, and a follower
 * that gave up would leave a canvas that looks current and is not.
 *
 * @param archiveUrl where to fall back to, or "" for no fallback.
 */
export function follow(
  room: string,
  fromSeq: number,
  archiveUrl: string,
  events: LiveEvents,
): Follower {
  let seq = fromSeq;
  let stopped = false;
  let failures = 0;

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** Verify and emit one room record. Returns false if it was not a placement. */
  const emitFromRoom = async (message: {
    seq: number;
    ts: string;
    from: string;
    text: string;
    nonce: number;
    sig?: string | null;
  }): Promise<void> => {
    const placement = parsePlacement(message.text);
    if (placement === null) return;

    let verified = false;
    const signature = message.sig;
    if (typeof signature === "string" && signature !== "") {
      try {
        const payload = messagePayload({
          room,
          nonce: String(message.nonce),
          text: message.text,
        });
        verified = await verifyPayload(message.from, signature, payload);
        // A signature that is present and wrong is the one case worth refusing outright. It
        // cannot happen while the service checks on write, which is exactly why seeing it
        // would mean something is wrong somewhere that matters.
        if (!verified) return;
      } catch {
        // Malformed DID or signature: unusable, not proof of anything. The placement is in
        // the room either way, so it is drawn and reported as unverified.
        verified = false;
      }
    }

    events.onPlacement({
      seq: message.seq,
      ts: message.ts,
      did: message.from,
      cx: placement.cx,
      cy: placement.cy,
      step: placement.step,
      verified,
    });
  };

  const roundFromRoom = async (): Promise<void> => {
    const messages = await read(room, seq, WAIT_SECONDS);
    if (messages.length === 0) return; // the wait expired with nothing new: normal
    for (const message of messages) {
      if (stopped) return;
      await emitFromRoom(message);
      seq = Math.max(seq, Number(message.seq) || seq);
    }
    events.onSeq(seq);
  };

  const roundFromArchive = async (): Promise<void> => {
    if (archiveUrl === "") throw new Error("no archive to fall back to");
    const delta = await archiveSince(archiveUrl, seq);
    for (const cell of delta.placements) {
      if (stopped) return;
      events.onPlacement({
        seq: delta.seq,
        ts: "",
        did: "",
        cx: cell.cx,
        cy: cell.cy,
        step: cell.step,
        // The archive states its own verdict and does not hand over the bytes. Repeating it
        // as though we had checked would be borrowing a claim.
        verified: false,
      });
    }
    seq = Math.max(seq, delta.seq);
    events.onSeq(seq);
  };

  void (async () => {
    for (;;) {
      if (stopped) return;
      try {
        await roundFromRoom();
        if (failures > 0) events.onStatus(true, "live again");
        failures = 0;
      } catch (roomError) {
        failures += 1;
        const reason = roomError instanceof Error ? roomError.message : "unreachable";
        events.onStatus(false, reason);

        if (failures >= FAILURES_BEFORE_FALLBACK) {
          try {
            // Slower and without signatures, but it keeps the canvas honest while the
            // service is shedding — which is the state this is for.
            await roundFromArchive();
          } catch {
            // Both are down. The backoff below is the whole response.
          }
        }
        await sleep(BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)]!);
      }
    }
  })();

  return {
    stop(): void {
      stopped = true;
    },
  };
}
