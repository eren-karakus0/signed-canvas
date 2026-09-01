/* Every refusal in the `design.md` table, forced.
 *
 * A retry policy that has only ever seen a 200 is a hope. Each status here is produced
 * deliberately by a stubbed `fetch`, and the assertions are about what the *interface* is
 * told, because that is what a person acts on.
 *
 * The load-bearing one is the timeout: a write that times out may already have landed, and
 * the test counts write attempts to prove the second pixel is never placed.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import { fromSeedHex } from "../src/identity/key.ts";
import { place, type Outcome } from "../src/net/room.ts";

const SEED = "01".repeat(32);
const ROOM = "p-canvas-test";
const TEXT = "px 12,47 3 k8f2a1";
const NONCE = "1787900000000";
const FAST = [1, 1, 1] as const;

interface Call {
  readonly url: string;
  readonly write: boolean;
}

/** Stub `fetch` with a scripted sequence of responses, recording what was asked for. */
function stubFetch(script: Array<Response | "timeout">): Call[] {
  const calls: Call[] = [];
  let index = 0;
  (globalThis as { fetch: unknown }).fetch = async (input: unknown): Promise<Response> => {
    const url = String(input);
    calls.push({ url, write: url.includes("/say-signed/") });
    const next = script[Math.min(index, script.length - 1)];
    index += 1;
    if (next === "timeout") {
      throw new DOMException("aborted", "AbortError");
    }
    // A Response body can be read once. Handing the same object back twice throws a
    // TypeError that the client reads as a network failure — which turned a "refused"
    // assertion into an "unknown" and looked exactly like a bug in the retry policy.
    return (next as Response).clone();
  };
  return calls;
}

const ok = (body: string): Response =>
  new Response(body, { status: 200, headers: { "content-type": "text/plain" } });

const fail = (status: number, body = "", headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers });

const roomWith = (messages: object[]): Response =>
  new Response(JSON.stringify({ messages }), { status: 200 });

const ACCEPTED = "[471] 2026-08-29T00:00:00.000000Z <z6Mk…abcd> px 12,47 3 k8f2a1";

async function attempt(
  script: Array<Response | "timeout">,
  overrides: Partial<Parameters<typeof place>[0]> = {},
): Promise<{ outcome: Outcome; calls: Call[] }> {
  const calls = stubFetch(script);
  const identity = await fromSeedHex(SEED);
  const outcome = await place({
    identity,
    room: ROOM,
    text: TEXT,
    nonce: NONCE,
    sinceSeq: 400,
    backoffMs: FAST,
    ...overrides,
  });
  return { outcome, calls };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = originalFetch;
});

describe("a placement that is accepted", () => {
  it("reports the sequence the room assigned", async () => {
    const { outcome, calls } = await attempt([ok(ACCEPTED)]);
    assert.equal(outcome.kind, "placed");
    assert.equal(outcome.kind === "placed" && outcome.seq, 471);
    assert.equal(calls.length, 1);
  });

  it("signs the payload and carries the signature back for witnessing", async () => {
    const { outcome, calls } = await attempt([ok(ACCEPTED)]);
    assert.equal(outcome.kind, "placed");
    if (outcome.kind !== "placed") return;
    assert.match(outcome.signature, /^[A-Za-z0-9_-]{86}$/);
    assert.ok(calls[0]!.url.includes(`/${outcome.signature}/`), "the signature must be in the URL");
    assert.ok(calls[0]!.url.includes(`/${NONCE}/`));
    assert.ok(calls[0]!.url.includes(encodeURIComponent(TEXT)));
  });
});

describe("503 — the measured common failure", () => {
  it("retries and succeeds", async () => {
    const { outcome, calls } = await attempt([fail(503, "Service Unavailable"), ok(ACCEPTED)]);
    assert.equal(outcome.kind, "placed");
    assert.equal(calls.filter((c) => c.write).length, 2);
  });

  it("gives up after the schedule and says the service refused, not the person", async () => {
    const { outcome, calls } = await attempt([fail(503, "Service Unavailable")]);
    assert.equal(outcome.kind, "refused");
    assert.equal(calls.filter((c) => c.write).length, FAST.length + 1);
    assert.doesNotMatch(
      outcome.kind === "refused" ? outcome.reason : "",
      /you|your/i,
      "a 503 is the dependency shedding load and must never read as the player's fault",
    );
  });

  it("tells the interface each time it retries", async () => {
    const seen: string[] = [];
    await attempt([fail(503), fail(503), ok(ACCEPTED)], {
      onRetry: (attempt_, reason) => seen.push(`${attempt_}:${reason}`),
    });
    assert.equal(seen.length, 2);
    assert.match(seen[0]!, /^1:/);
  });
});

describe("refusals that must not be retried", () => {
  it("429 surfaces the wait the server named", async () => {
    const { outcome, calls } = await attempt([fail(429, "slow down", { "retry-after": "30" })]);
    assert.equal(outcome.kind, "refused");
    assert.equal(outcome.kind === "refused" ? outcome.retryAfter : 0, 30);
    assert.equal(calls.filter((c) => c.write).length, 1, "429 must not be retried automatically");
  });

  it("422 names the duplicate filter", async () => {
    const { outcome, calls } = await attempt([fail(422, "duplicate")]);
    assert.equal(outcome.kind, "refused");
    assert.match(outcome.kind === "refused" ? outcome.reason : "", /duplicate/i);
    assert.equal(calls.filter((c) => c.write).length, 1);
  });

  it("400 carries the server's own words, since the nonce is the likely cause", async () => {
    const { outcome } = await attempt([fail(400, "nonce must increase")]);
    assert.equal(outcome.kind, "refused");
    assert.match(outcome.kind === "refused" ? outcome.reason : "", /nonce must increase/);
  });

  it("403 says the client and server disagree about the bytes", async () => {
    // The one refusal that means our own code is wrong: the server verified a signature
    // against a payload we built differently. It must not read as a transient failure.
    const { outcome } = await attempt([fail(403, "")]);
    assert.equal(outcome.kind, "refused");
    assert.match(outcome.kind === "refused" ? outcome.reason : "", /signature did not verify/i);
  });
});

describe("timeout — the write may already have landed", () => {
  it("does not place a second pixel when the first one arrived", async () => {
    const calls = stubFetch([
      "timeout",
      roomWith([{ seq: 471, ts: "t", from: "", text: TEXT, nonce: 1 }]),
    ]);
    const identity = await fromSeedHex(SEED);
    // The room attributes the message to our own DID, so the stub has to say so.
    (globalThis as { fetch: unknown }).fetch = (() => {
      let n = 0;
      return async (input: unknown): Promise<Response> => {
        const url = String(input);
        calls.push({ url, write: url.includes("/say-signed/") });
        if (n++ === 0) throw new DOMException("aborted", "AbortError");
        return roomWith([{ seq: 471, ts: "t", from: identity.did, text: TEXT, nonce: 1 }]);
      };
    })();

    const outcome = await place({
      identity, room: ROOM, text: TEXT, nonce: NONCE, sinceSeq: 400, backoffMs: FAST,
    });

    assert.equal(outcome.kind, "placed", "the pixel was in the room; it must be reported placed");
    assert.equal(
      calls.filter((c) => c.write).length,
      1,
      "retrying after a landed write would place a second pixel",
    );
  });

  it("retries when the room has no record of it", async () => {
    const identity = await fromSeedHex(SEED);
    const calls: Call[] = [];
    let n = 0;
    (globalThis as { fetch: unknown }).fetch = async (input: unknown): Promise<Response> => {
      const url = String(input);
      calls.push({ url, write: url.includes("/say-signed/") });
      n += 1;
      if (n === 1) throw new DOMException("aborted", "AbortError");
      if (n === 2) return roomWith([]);
      return ok(ACCEPTED);
    };
    const outcome = await place({
      identity, room: ROOM, text: TEXT, nonce: NONCE, sinceSeq: 400, backoffMs: FAST,
    });
    assert.equal(outcome.kind, "placed");
    assert.equal(calls.filter((c) => c.write).length, 2);
  });

  it("says it does not know rather than guessing, once the retries are spent", async () => {
    const identity = await fromSeedHex(SEED);
    let n = 0;
    (globalThis as { fetch: unknown }).fetch = async (input: unknown): Promise<Response> => {
      n += 1;
      if (String(input).includes("/say-signed/")) throw new DOMException("aborted", "AbortError");
      return roomWith([]);
    };
    const outcome = await place({
      identity, room: ROOM, text: TEXT, nonce: NONCE, sinceSeq: 400, backoffMs: FAST,
    });
    assert.equal(outcome.kind, "unknown");
    assert.ok(n > 0);
  });

  it("treats an unreadable room during the check as unknown, not as success", async () => {
    // The check itself can fail. Reading "the room did not answer" as "the pixel is not
    // there" would send a duplicate; reading it as "it is there" would lose the pixel.
    const identity = await fromSeedHex(SEED);
    (globalThis as { fetch: unknown }).fetch = async (input: unknown): Promise<Response> => {
      if (String(input).includes("/say-signed/")) throw new DOMException("aborted", "AbortError");
      throw new TypeError("network down");
    };
    const outcome = await place({
      identity, room: ROOM, text: TEXT, nonce: NONCE, sinceSeq: 400, backoffMs: [1],
    });
    assert.equal(outcome.kind, "unknown");
  });
});

/* The two lanes.
 *
 * The relay stopped being mandatory when technocore.chat opened CORS in 0.11.0. It is still
 * tried first, but a relay that is the only write path is a relay that can censor one, so a
 * write must be able to reach the room without it.
 *
 * The whole difficulty is one distinction: did the relay reach technocore and repeat its
 * answer, or did it never get there? Both arrive as a status code, and both can be 503.
 * Getting it wrong is expensive in opposite directions — re-sending a write the service
 * already refused places nothing and burns budget, while abandoning one it never saw loses a
 * pixel. So it is read from `x-relay-upstream` and never inferred, and its absence means "no
 * word from upstream", which is the assumption that cannot place a second pixel.
 */

const RELAY = "https://archive.example/relay";

/** What the relay sends when it reached technocore: the upstream status, stated. */
const relayReplied = (
  status: number,
  payload: object = {},
  init: ResponseInit = {},
): Response =>
  new Response(JSON.stringify({ upstream_status: status, ...payload }), {
    status: status === 200 ? 200 : status,
    headers: { "content-type": "application/json", "x-relay-upstream": String(status) },
    ...init,
  });

/** What a broken relay, or something in front of it, sends: no word about upstream. */
const relaySilent = (status: number, body = ""): Response =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

const isRelay = (c: Call): boolean => c.url === RELAY;

describe("with a relay configured", () => {
  it("uses it, and reports the lane", async () => {
    const { outcome, calls } = await attempt([relayReplied(200, { seq: 471 })], {
      relayUrl: RELAY,
    });
    assert.equal(outcome.kind, "placed");
    assert.equal(outcome.kind === "placed" && outcome.seq, 471);
    assert.equal(outcome.kind === "placed" && outcome.via, "relay");
    assert.equal(calls.length, 1);
    assert.ok(isRelay(calls[0]!));
  });

  it("retries the relay when it reports upstream shedding load, rather than going around it", async () => {
    // A 503 the relay is *quoting* is technocore's, and technocore's 503 means the request
    // was shed, not applied. Retrying the same lane is correct; switching lanes would be a
    // second write against a service that is already refusing them.
    const { outcome, calls } = await attempt(
      [relayReplied(503), relayReplied(200, { seq: 472 })],
      { relayUrl: RELAY },
    );
    assert.equal(outcome.kind, "placed");
    assert.equal(outcome.kind === "placed" && outcome.via, "relay");
    assert.equal(calls.filter((c) => c.write).length, 0, "no direct write should happen");
    assert.equal(calls.length, 2);
  });

  it("does not go around the relay when it reports a refusal", async () => {
    // The load-bearing one. A duplicate is a real answer from the service. Re-sending the
    // same bytes down another lane is refused again at best, and at worst is how one click
    // becomes two pixels.
    const { outcome, calls } = await attempt([relayReplied(422, {}, {})], {
      relayUrl: RELAY,
    });
    assert.equal(outcome.kind, "refused");
    assert.match(outcome.kind === "refused" ? outcome.reason : "", /duplicate/);
    assert.equal(calls.filter((c) => c.write).length, 0);
    assert.equal(calls.length, 1);
  });

  it("does not go around the relay when it reports a rate limit", async () => {
    const { outcome, calls } = await attempt([relayReplied(429)], { relayUrl: RELAY });
    assert.equal(outcome.kind, "refused");
    assert.equal(calls.filter((c) => c.write).length, 0);
  });
});

describe("when the relay does not answer", () => {
  it("asks the room before writing anything, and does not place a second pixel", async () => {
    // The relay's own 504 says outright that the write may have landed and the answer been
    // lost. Falling straight through to a direct write would be the duplicate this whole
    // module exists to avoid.
    const identity = await fromSeedHex(SEED);
    const calls: Call[] = [];
    let n = 0;
    (globalThis as { fetch: unknown }).fetch = async (input: unknown): Promise<Response> => {
      const url = String(input);
      calls.push({ url, write: url.includes("/say-signed/") });
      n += 1;
      if (n === 1) return relaySilent(504, '{"upstream":"unreachable"}');
      return roomWith([
        { seq: 990, ts: "2026-09-01T00:00:00Z", from: identity.did, text: TEXT, nonce: 1 },
      ]);
    };
    const outcome = await place({
      identity, room: ROOM, text: TEXT, nonce: NONCE, sinceSeq: 400, backoffMs: FAST,
      relayUrl: RELAY,
    });
    assert.equal(outcome.kind, "placed");
    assert.equal(outcome.kind === "placed" && outcome.seq, 990);
    assert.equal(outcome.kind === "placed" && outcome.via, "relay", "it did land via the relay");
    assert.equal(calls.filter((c) => c.write).length, 0, "nothing may be written again");
  });

  it("falls back to the room when the write is not there", async () => {
    const { outcome, calls } = await attempt(
      [relaySilent(504, '{"upstream":"unreachable"}'), roomWith([]), ok(ACCEPTED)],
      { relayUrl: RELAY },
    );
    assert.equal(outcome.kind, "placed");
    assert.equal(outcome.kind === "placed" && outcome.via, "room");
    assert.equal(calls.filter((c) => c.write).length, 1);
    assert.ok(isRelay(calls[0]!));
  });

  it("falls back when the relay is unreachable entirely", async () => {
    const { outcome, calls } = await attempt(["timeout", roomWith([]), ok(ACCEPTED)], {
      relayUrl: RELAY,
    });
    assert.equal(outcome.kind, "placed");
    assert.equal(outcome.kind === "placed" && outcome.via, "room");
    assert.equal(calls.filter((c) => c.write).length, 1);
  });

  it("falls back when the relay refuses on its own terms rather than upstream's", async () => {
    // A relay refusal with no upstream status is the relay disagreeing with us, not the
    // service. The most likely cause is the relay pointing at a different room, in which
    // case the signature is wrong for *its* room and right for ours — so asking the room is
    // both the safe answer and the correct one.
    const { outcome, calls } = await attempt(
      [relaySilent(422, "signature does not verify"), roomWith([]), ok(ACCEPTED)],
      { relayUrl: RELAY },
    );
    assert.equal(outcome.kind, "placed");
    assert.equal(outcome.kind === "placed" && outcome.via, "room");
    assert.equal(calls.filter((c) => c.write).length, 1);
  });

  it("only ever falls back once", async () => {
    // After the switch the lane is the room, so a room failure must be handled as a room
    // failure — never as another reason to "fall back" and loop. Scripted directly rather
    // than through `attempt`, because the sequence has to keep failing: a script that runs
    // out repeats its last entry, which quietly turns a room read into the write's answer.
    const identity = await fromSeedHex(SEED);
    const calls: Call[] = [];
    (globalThis as { fetch: unknown }).fetch = async (input: unknown): Promise<Response> => {
      const url = String(input);
      calls.push({ url, write: url.includes("/say-signed/") });
      if (url === RELAY || url.includes("/say-signed/")) {
        throw new DOMException("aborted", "AbortError");
      }
      return roomWith([]);
    };
    const outcome = await place({
      identity, room: ROOM, text: TEXT, nonce: NONCE, sinceSeq: 400, backoffMs: FAST,
      relayUrl: RELAY,
    });
    assert.equal(outcome.kind, "unknown");
    assert.equal(calls.filter(isRelay).length, 1, "the relay is tried exactly once");
    assert.ok(calls.filter((c) => c.write).length >= 1, "the room lane was actually used");
  });
});

describe("with no relay configured", () => {
  it("writes to the room and says so", async () => {
    const { outcome, calls } = await attempt([ok(ACCEPTED)]);
    assert.equal(outcome.kind, "placed");
    assert.equal(outcome.kind === "placed" && outcome.via, "room");
    assert.equal(calls.filter((c) => c.write).length, 1);
  });
});
