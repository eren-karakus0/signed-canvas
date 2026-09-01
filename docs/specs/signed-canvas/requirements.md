# Signed Canvas — Requirements

Status: draft · 2026-08-28
Visual identity: `.design/identity.md` (PLOT) · UI language: English

## What this is

A shared pixel canvas on [technocore.chat](https://technocore.chat) where **every pixel is a
signed `did:key` write**. Anyone — human or AI agent — places pixels, and the owner of any
pixel can be proved cryptographically rather than merely asserted.

One action: click a cell. The cooldown is the network's own rate limit, not a game rule.

---

## Measurements this rests on

Taken against the live service on 2026-08-28, service version 0.10.0. These are inputs to
the requirements below, not decoration.

| What | Measured |
|---|---|
| Signed write (one pixel), n=10 | min 706 ms · median **735 ms** · p90 771 ms · max 808 ms |
| Room read, `?format=json` | median **725 ms** |
| Write failures under load | 1 timeout observed in ~40 writes |
| Duplicate filter, 20 identical 38-char texts | **2 refused (422)** — fires, but per-worker so probabilistic |
| Note capacity | 8192 chars → ~12,288 px at 4-bit palette; **131,072 notes per namespace** |
| Rate limit | 300 writes/min/IP · 600 reads/min/IP |
| Room retention | ring trimmed past ~10 MiB, **guaranteed floor only 128 KiB** |
| Browser Ed25519 (T-1) | `crypto.subtle`: Chromium ✓ Firefox ✓ **WebKit ✗** · JS signer: all three ✓ |
| JS signer cost (T-1) | Chromium 0.65 ms · Firefox 1.15 ms · **WebKit 46 ms** per signature |
| Sustained writes (T-2) | 300 attempted over 685 s: **226 ok, 74 failed (24.7%)**, in bursts |
| Write latency under load (T-2) | median 754 ms · **p95 2,247 ms** — 3× the quiet-state p90 |
| Room read (T-2) | median 717 ms · p95 756 ms · 37.7 KiB for 200 messages |
| **Room read cap (T-2)** | **200 messages, hard.** `limit=500` returns 200; no backward paging exists |
| Failure attribution (T-2b) | 60 writes: **58 ok, 2 × 503**. No 429, no 422, no timeout |
| Failure rate varies (T-2, T-2b) | **24.7% then 3.3%** an hour later at identical pace — dependency load, not client behaviour |

Three consequences drive the design:

1. **A room is a live tail, not a queryable log.** Measured in T-2: reads return at most 200
   messages, `since=0` returns the *newest* 200 rather than the oldest, and `before`,
   `until`, `offset` and `from` are all ignored. Once a canvas has more than 200 placements,
   the ones before that are unreachable from the room by any request. This is not the ring
   trimming — it is the shape of the read API.
2. **Notes are world-writable and unsigned.** The server only accepts signed note writes for
   `room-owners` and `room-allow`. Anyone with a URL bar can overwrite a canvas snapshot
   stored in a note. A snapshot is therefore a cache, never the truth.
3. **Writes fail at a rate we do not control.** T-2 saw 24.7% fail, T-2b saw 3.3% an hour
   later at the same pace; T-2b attributed them to **503 Service Unavailable** — the service
   shedding load, with no 429, 422 or timeout among them. The client cannot reduce this rate
   by behaving better, so it must stay usable across that whole range.

---

## Functional requirements

**FR-1** A visitor can view the canvas without an identity, without signing in, and without
placing anything.

**FR-2** A visitor can generate a `did:key` identity in the browser; the private key is
generated locally and is never transmitted. Signing uses a bundled JS Ed25519 implementation
on every engine — not `crypto.subtle` — for the reason recorded in assumption 6.

**FR-3** A player with an identity can place one pixel by clicking a cell and choosing a
colour from the palette.

**FR-4** Placing a pixel writes one signed message to the canvas room, whose text encodes the
coordinate, the palette index, and a per-write nonce that makes the text unique.

**FR-5** *(revised 2026-08-29 — see the note below)* The canvas rendered to a viewer is
derived only from messages the room attributes to a `did:key` sender; a message from an
unsigned sender is ignored. Where a signature is held, it is verified and the pixel is marked
**witnessed**; otherwise the pixel is **attested** and the interface says so.

**FR-6** Hovering or selecting a cell shows the owning `did:key`, the room sequence number,
the time of the write, and whether the pixel is witnessed or attested.

**FR-7** *(revised 2026-08-29)* A viewer can copy, for any **witnessed** pixel, the exact
material needed to re-verify it offline: the canonical signed string, the signature, and the
DID. For an attested pixel the same action yields the canonical string, the DID, and a plain
statement that no signature is held — never a proof-shaped object that cannot be checked.

> ### Why FR-5 and FR-7 were weakened
>
> Both originally required verification of every rendered pixel. **The service makes that
> impossible for a reader.** The room read returns `seq`, `ts`, `from`, `text` and `nonce`
> and never the signature — measured across `format=json`, `verbose`, `full`, `include=sig`,
> `sig` and `signed`; there is no single-message route, `/openapi.json` declares no schemas,
> and `/config` has no knob. The server verifies on write and keeps the signature.
>
> A reader can rebuild the signed payload exactly and has nothing to check it against.
>
> The requirement is therefore **split rather than dropped**: a pixel placed through this
> product is witnessed, because the client computed the signature and posts it; a pixel
> written straight to the room by an agent (FR-10) is attested unless that agent also posts
> its signature. Both are shown, and shown apart.
>
> Writing "verified" over a pixel whose signature we have never seen would be the one lie
> this product cannot afford, and it would be invisible to the person reading it. The
> honest version is less impressive and is the version that ships. `design.md` carries the
> mechanism; `server/canvas/archive.py` carries it in the schema.
>
> **Update 2026-09-01 — the weakening is mostly lifted, and the split stays.** technocore.chat
> 0.11.0 (2026-08-31) now serves `sig` on room reads. Verified here, not assumed: 200
> unrelated records re-verified against the canonical string, 200 passed; and one of our own
> writes returned a byte-identical signature. Every pixel placed from now on is witnessed,
> including one written straight to the room by an agent that never touches this product.
>
> The split is **not** removed, for a reason that will not expire: records written before
> 0.11.0 carry no signature and never can. They stay attested, and the interface keeps showing
> the two apart — which is also what the service's own manual now instructs, in the same
> words this requirement chose: a missing signature means "not re-verifiable", not "invalid".

> ### FR-11 needs a relay, measured 2026-08-29
>
> technocore.chat sends no `access-control-allow-origin` on any endpoint. A browser can send
> a signed write but cannot read the response, so it cannot tell a rate limit from a
> duplicate from a success — and FR-11 asks for exactly that distinction.
>
> The write therefore goes through `POST /relay` on our own archive, which forwards it and
> returns the real upstream status. The key never leaves the browser; only the signature
> does, and a signature is public the moment it is written to a public room.
>
> **This makes the archive a hard dependency for placing, not only for reading old pixels.**
> Until it is reachable the interface says placing is unavailable and why, rather than
> putting a pixel on screen it cannot confirm.
>
> **Update 2026-09-01 — the premise is gone.** technocore.chat now answers every origin with
> `access-control-allow-origin: *`, and a preflight allows `GET, POST`. Confirmed from a real
> `http://` origin in Chromium, Firefox and WebKit — not from response headers alone, since
> it is the browser that enforces CORS: a cross-origin read of the room's JSON, of the signed
> write lane's own error body, and of `/export` all succeeded, and a preflighted `POST`
> completed. One limit remains: `X-Room-Generation` is not exposed to script (no
> `Access-Control-Expose-Headers`), which costs nothing here because `generation` is also in
> the JSON body.
>
> So FR-11 is implementable directly from the browser, and the relay is no longer *required*
> to satisfy it. The relay is not therefore pointless — it still centralises backoff against a
> dependency measured at 3–25% 503, and its idempotency handling on timeout. But it must stop
> being the only way to place: while it is, this product is the single point that can censor a
> write, and that is a worse property than the latency it saves.
>
> **Done 2026-09-01: the relay is preferred, not required.** `place()` tries it first and
> falls back to writing straight to the room when it does not answer. The archive is now what
> shows an *older* canvas, not what permits a pixel, and the interface names the lane it used.
>
> The whole difficulty is one distinction — did the relay reach technocore and repeat its
> answer, or did it never get there? Both surface as a status code and both can be 503, and
> the two mistakes are expensive in opposite directions: re-sending a write the service
> already refused as a duplicate, versus abandoning one it never saw. So it is stated rather
> than inferred. The relay sets `x-relay-upstream` (exposed through CORS) only when it has an
> upstream status to report; its absence means "no word from upstream", which is the reading
> that cannot place a second pixel. Before falling back, the room is asked whether the write
> landed anyway — the relay's own 504 says outright that it might have.
>
> **The lanes are not equals, and FR-11 is why.** Measured 2026-09-01 while the service was
> recovering from an outage: **9 of 9 `200` responses carried `access-control-allow-origin`,
> and 0 of 11 `503` responses did** — the load shedder answers in front of whatever adds
> those headers. So from a browser a 503 is an opaque `TypeError`, indistinguishable from the
> network being down, and the direct lane cannot satisfy the *"states which refusal occurred"*
> half of this requirement while the service is shedding. It still retries, still asks the
> room, and still says "not certain" rather than guessing — which is honest, and is less than
> FR-11 asks for.
>
> The relay is therefore not a convenience. It is the only way a browser learns which refusal
> happened, and it fully satisfies FR-11; the room is the fallback that keeps this project
> from being the single point that can censor a write. Both are needed, for different reasons,
> and the interface names the lane it used.

**FR-8** The canvas loads from a snapshot and then applies newer signed messages from the
room, so a first paint does not require replaying the whole history.

**FR-9** A client verifies a loaded snapshot against signed messages; when verification
fails, the client discards the snapshot and rebuilds from the archive.

**FR-10** An AI agent can place a pixel using a plain HTTP GET, with no browser and no
JavaScript, following the same message format a human client writes.

**FR-11** When a write is refused, the interface states which refusal occurred — rate limit
(429), duplicate (422), or nonce (400) — and what the player should do.

**FR-12** The interface shows the number of distinct signing keys that have placed at least
one pixel, and never shows a count it cannot derive from signatures.

---

## Non-functional requirements

**NFR-1 — First paint.** The canvas is visible within **2.5 s** at p95 on a 10 Mbit
connection, measured from navigation start.

*Settled by T-2:* this is **unachievable reading technocore.chat directly** and the number
did not have to move — the source did. A 4,096-pixel canvas is 21 sequential capped reads
× 725 ms = **15.2 s**, and the oldest placements cannot be fetched at all. The client
therefore loads one snapshot from our own archive (2 KiB packed, **386× smaller** than the
772 KiB of equivalent room JSON) plus one delta. Two requests, not twenty-one.

**NFR-2 — Placement feedback.** The clicked cell shows an optimistic state within **100 ms**
of the click, and its confirmed-or-failed state within **5 s** at p95.

*Revised by T-2 from 3 s.* Under sustained writing the p95 was 2,247 ms and roughly one
write in four failed, in bursts. A 3 s budget would have reported healthy writes as failures
during a burst. The interface must treat a slow write as slow, not as lost — the timeout
rule in `design.md` (re-read before retrying) is what keeps this from placing two pixels.

**NFR-3 — Write budget.** A single client issues at most **30 writes/minute**, one tenth of
the documented 300/min/IP ceiling, so that several players behind one NAT do not exhaust it.

**NFR-4 — Read budget.** A viewing client issues at most **12 reads/minute** while idle
(one delta poll per 5 s), against the documented 600/min/IP.

**NFR-5 — Verification cost.** Verifying the full canvas from the archive completes in under
**5 s** for 4,096 pixels on a mid-range laptop.

**NFR-6 — Archive durability.** No signed pixel write is lost once accepted.

*Revised by T-2.* The binding constraint is not the byte trim, it is the 200-message read
cap: the archiver permanently loses any write that falls more than 200 behind, because no
request can reach it. The archiver therefore polls such that it is **never more than 100
messages behind** — half the cap, so a burst has margin — which at a plausible peak of 5
placements/second means polling at least every **20 s**. Target RPO = 0 for accepted writes,
RTO < 10 min. A missed poll window is data loss that cannot be repaired later.

**NFR-7 — Canvas size.** First release is **64 × 64 = 4,096 cells**. Rationale: fillable by
the few hundred active participants measured in the ecosystem, and one 4-bit-palette snapshot
fits a single 8192-char note with room to spare.

**NFR-8 — Reduced motion.** With `prefers-reduced-motion: reduce`, all transition and
animation durations are at most 0.01 ms.

**NFR-9 — Contrast.** Body text meets 4.5:1 against its background; the identity's measured
pair is 13.3:1.

---

## Out of scope

Deliberately **not** in this release:

- Any token, payment, reward, or airdrop mechanic. This is a toy that demonstrates signed
  identity; it is not a claim on $FLOP and must not imply one.
- Accounts, profiles, follower graphs, chat between players.
- Moderation of canvas content beyond what the server already enforces.
- Multiple canvases, custom room creation, private canvases.
- Mobile-first layout. Mobile must remain usable and legible; it is not optimised.
- Localisation. English only; the copy is written so translation is possible later.
- Key recovery. A lost browser key is a lost identity, stated plainly in the interface.
- Anti-bot measures. Agents are welcome participants, not abuse.
- Server-side rendering, SEO.

---

## Assumptions and dependencies

Unverified assumptions, each of which invalidates part of the design if wrong:

1. **technocore.chat stays available and free.** The whole product is a client on it. No
   fallback exists. It is a service run by Flop Labs at their discretion. *Sharpened by T-2b:*
   availability is already visibly variable — between 3.3% and 24.7% of writes were refused
   with 503 in two runs an hour apart. This is the single largest risk to the product and it
   is entirely outside our control.
2. **Its message format stays stable.** The signed lane and the canonical string
   `room|nonce|text` are relied on directly. Version 0.10.0 changed caps and added a refusal
   in one day; the protocol itself has been stable, but that is observation, not a promise.
3. **A canvas room is not reaped.** Rooms idle 7 days are deleted. Play is expected to keep
   it alive; the archiver's own heartbeat is the fallback.
4. **The duplicate filter stays probabilistic.** Measured 2/20 refusals on identical text.
   If per-worker state becomes shared, identical texts would be refused reliably — the design
   already avoids identical texts, so this is safe either way.
5. **Participants number in the hundreds, not the millions.** 4,096 cells suits that. A
   larger audience needs sharding across notes, which the design allows but does not build.
6. ~~**Browsers can do Ed25519.**~~ **Settled by T-1 on 2026-08-28 — the assumption was
   wrong, and the requirement changed rather than the schedule.**

   Measured with Playwright: `crypto.subtle` Ed25519 works in Chromium 145 and Firefox 146,
   producing signatures byte-identical to the `#318` vectors. It is **absent** in WebKit 26.0,
   which reports `NotSupportedError` for Ed25519 *and* X25519 while supporting ECDSA and RSA —
   so it is a missing algorithm, not a naming or flag problem.

   Caveat stated plainly: **Playwright's WebKit is not Safari.** Published sources say Apple
   shipped Ed25519 in Safari; this run cannot confirm that, and real Safari was not tested.

   Resolution: a 18.8 KB dependency-free JS signer (`@noble/ed25519`) was measured in all
   three engines and produced byte-identical signatures to the same vectors — WebKit included
   (20 signatures in 931 ms, ~46 ms each; Chromium 13 ms, Firefox 23 ms). **FR-2 now specifies
   the JS signer as the single code path**, because one path that works everywhere is worth
   more than a capability branch that saves 45 ms on one engine.

---

## Verification checklist

- [x] **Validity** — each requirement is a need, not a solution in disguise. FR-8 and FR-9
      name outcomes (fast first paint, verified snapshot), not mechanisms.
- [x] **Consistency** — no requirement contradicts another. NFR-3 and NFR-4 are both well
      inside the server's published limits.
- [x] **Completeness** — covers viewing, identity, placing, verifying, failing, and agent
      access.
- [x] **Realism** — every timing target is derived from a measurement above rather than
      chosen. NFR-1 is the one with least headroom and is called out as the risk.
- [ ] **Verifiability** — FR-5 and NFR-5 need a test harness that replays a known canvas;
      not yet written. Every other item has an obvious test.

**Open tension:** NFR-1 (2.5 s first paint) against a measured 725 ms per read. Two sequential
reads plus render leaves ~1 s of margin. If the archive is served from our own host the reads
are faster and the risk disappears; if the client reads technocore.chat directly, it is tight.
This is a design decision, recorded in `design.md`, not resolved here.
