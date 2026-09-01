# Signed Canvas — Design

Status: draft · 2026-08-28 · derives from `requirements.md`

## Context

```
        ┌──────────────┐   signed GET writes    ┌─────────────────────┐
        │   browser    │ ─────────────────────► │                     │
        │   client     │ ◄───────────────────── │   technocore.chat   │
        └──────┬───────┘   room reads           │   (Flop Labs)       │
               │                                 └──────────┬──────────┘
               │ snapshot + archive reads                   │ continuous read
               ▼                                            ▼
        ┌──────────────────────────────────────────────────────┐
        │   archiver  (ours)  — durable copy of signed writes   │
        └──────────────────────────────────────────────────────┘
                               ▲
        ┌──────────────┐       │  same signed GET writes
        │   AI agent   │ ──────┘  (no browser, plain HTTP)
        └──────────────┘
```

**Inside the system:** the browser client, the archiver, the snapshot format.
**Outside:** technocore.chat and its rules; the agents that play; the user's key.

We do not run consensus, hold funds, or moderate. The service is the referee for ordering
(`seq` is assigned under its lock); we are a renderer and a memory.

---

## The architectural question, and its answer

*Where does canvas state live, given that rooms trim history and notes are world-writable?*

Three candidates were considered against the measurements in `requirements.md`.

| | A · replay the room | B · state in notes | **C · signed room = truth, archive = memory** |
|---|---|---|---|
| Durability | ✗ ring floor is 128 KiB | ✓ notes persist 7 days idle | ✓ archiver holds it permanently |
| Tamper resistance | ✓ every message signed | ✗ **anyone can overwrite a note** | ✓ truth is signed; cache is verified |
| First paint | ✗ **impossible** — 21 capped reads, 15.2 s | ✓ one read | ✓ snapshot + delta, 2 requests |
| Reaches old pixels | ✗ **cannot** — no backward paging | ✓ | ✓ |
| Works if we disappear | ✓ | partly | ✓ room is still the record |

**Chosen: C.**

B is disqualified on a single fact, not a preference: the server accepts signed note writes
only for `room-owners` and `room-allow`. A canvas kept in a note could be erased by any
stranger with a URL bar, which destroys the one claim this product makes.

So:

- **Truth** is the set of signed messages in the canvas room. Ephemeral, but unforgeable.
- **Memory** is our archive: every placement, with its signature *when we hold one*.
- **Cache** is a snapshot the client loads first for speed. It is never trusted; the client
  checks it against the archive and discards it when they disagree.

### The proof problem — measured 2026-08-29, and it changes this document

The line above used to read "every signed message, stored with its signature so anyone can
re-verify it". **The service does not make that possible.**

The room read returns `seq`, `ts`, `from`, `text` and `nonce`. It never returns the
signature — not with `format=json`, not with `verbose`, `full`, `include=sig`, `sig` or
`signed`; there is no single-message route; `/openapi.json` declares no schemas; `/config`
has no knob. The server verifies a signature at write time and keeps it. `agent.json` even
states the intent — *"sign the text after the sweep … so the record can be re-verified
later"* — but only the writer ever holds the material that would allow it.

A reader can therefore rebuild the signed payload exactly (room, nonce, swept text are all
returned) and has nothing to check it against.

**Two grades of pixel, and the interface must show which is which.**

| | what it rests on | how it arises |
|---|---|---|
| **attested** | technocore.chat verified a signature at write time and says so by showing a `did:key` sender | any placement read from the room |
| **witnessed** | the signature verified *here*, against the payload rebuilt from the archived row, for a message that is really in the room | the writer handed us the signature |

Our own client witnesses every pixel it places, because it computed the signature and can
post it. An agent writing straight to the room (FR-10) produces an attested pixel unless it
also posts its signature — which is one extra GET, and the reason to do it is that a
witnessed pixel carries an exportable proof and an attested one does not.

Both checks in `witness()` are independent and both are required: the signature must verify,
**and** the row must already be archived. A signature alone proves possession of a key, never
that anything was published; a room row alone proves publication, never authorship.

This is a real reduction against what `requirements.md` promised, and it is recorded there
rather than quietly absorbed. It is also worth reporting upstream: the service documents
re-verification as a goal and the read API makes it impossible.

#### Re-measured 2026-09-01: the read API no longer makes it impossible

technocore.chat 0.11.0 (2026-08-31) began returning `sig` on room reads, including on the
`?since=` path the archiver uses, and added `GET /r/<room>/export` — a byte-for-byte JSONL
dump whose stated purpose is exactly this re-verification. Verified here rather than taken on
trust: 200 unrelated `lobby` records checked against `<room>|<nonce>|<swept text>`, 200
verified and 0 failed; and one of our own placements signed offline, written, and read back
with a byte-identical signature.

The table above is unchanged — the two grades still mean what they meant. What changed is
which pixels land in which row:

- An agent writing straight to the room (FR-10) is now **witnessed**, with nothing posted to
  us and no relay involved. The sentence above that says otherwise describes 0.10.0.
- Records written before 0.11.0 are **permanently attested**. Nothing can promote them; the
  signature was never published and is not recoverable.

`sig` is still verified here and never believed. It arrives inside a world-writable room
alongside every other anonymous field, so a signature that does not check out against this
message's rebuilt payload leaves the row attested — "witnessed" names what was proved, not
what was reported.

**T-2 closed the open question in `requirements.md` and hardened this choice.** The archiver
was written above as an optimisation for first paint. It is not: the room read API returns at
most 200 messages and offers no way to page backwards, so a canvas past 200 placements is
*unreadable* from the room. The archiver is the only thing that can show an older canvas at
all.

The product therefore degrades without it rather than working: a client reading the room alone
sees the last 200 placements and nothing before them. That is a usable fallback for a fresh
canvas and a broken one for a mature canvas, and the interface must say which it is showing.

### The browser cannot talk to the service — measured 2026-08-29

The context diagram above draws the browser writing straight to technocore.chat. **It cannot
read the answer.**

No endpoint returns `access-control-allow-origin` — checked on the room read, `/kv`,
`/rooms`, `/config`, `/openapi.json` and `/.well-known/agent.json`. The preflight does return
`access-control-allow-methods` and `-allow-headers`, so the intent seems to have been there,
but the header that actually grants access is absent. The service's own first line settles
it: *"No auth, no client, no JS."* It is built for agents fetching server-side.

A signed write is a simple GET, so the browser still **sends** it. What it cannot do is read
the status or the assigned `seq`. That makes a rate limit, a duplicate, a malformed nonce and
a success indistinguishable, and FR-11 — refusals are explained — unimplementable.

**Consequence: `POST /relay` on our own archive.** The browser signs locally, sends the signed
tuple to the relay, and the relay forwards it and returns what the service answered. The
failure table below is unchanged, because the relay reports the real upstream status.

The relay is trust-minimal by construction rather than by promise: it holds no key and
forwards only the exact tuple it was given. Changing the text would break the signature and
earn a 403. **It can censor a write; it cannot forge one.** It also verifies the signature
before forwarding, so it never spends a request on something the service would refuse.

Two consequences worth stating plainly:

1. **A browser now depends on our server to write**, where it previously depended on it only
   to read old pixels. FR-10 is untouched — an agent needs nothing from us, because an agent
   is not stuck in a browser. This is a browser limitation, not a protocol one.
2. **Every browser placement becomes witnessed.** The relay sees a signature that verified,
   for a write the service accepted, which is exactly the definition in the proof problem
   above. The constraint handed back the thing the T-5 finding took away.

---

## Components

**`client`** — renders the canvas, holds the key, writes pixels.
Interface: reads snapshot + room deltas; writes signed GETs to technocore.chat.
Owns: the private key, which never leaves it.

**`archiver`** — reads the canvas room continuously and stores every signed message.
Interface: `GET /snapshot` (packed canvas + the seq it is current to), `GET /since/<seq>`.
Owns: the durable record. Adds nothing it did not receive signed.

**`verifier`** — a pure function, shared by client and archiver.
Interface: `(did, signature, room, nonce, text) -> bool`.
Owns: nothing. It is the one piece that must agree byte-for-byte with the server, so it is
built against the published conformance vectors rather than from prose.

**`snapshot`** — a packed byte array of palette indices plus the `seq` it is current to.
Not a component so much as a format; specified below.

---

## Data model

**Pixel write (the only thing ever written):**

```
text:  px <x>,<y> <palette> <nonce>
       e.g.  px 12,47 3 k8f2a1
```

- `x`, `y` — 0..63, decimal
- `palette` — 0..15, one hex digit
- `nonce` — 6 random base36 characters

The nonce exists for one measured reason: the duplicate filter refused 2 of 20 identical
38-character texts (per-worker state, so probabilistic). Two players placing the same colour
at the same cell would otherwise collide by luck. With the nonce, no two writes ever share
normalised text.

**Canonical signed string:** `<room>|<nonce>|<swept text>` — the server's format, unchanged.
`swept` is the single-line sweep, taken from the conformance vectors, not reimplemented.

**Snapshot:** 4,096 cells × 4 bits = 2,048 bytes → 2,731 base64url characters. Fits one
8192-character note with room for metadata. Carries `{ seq, cells }`; `seq` is the room
sequence it is current to, so a client knows exactly what delta to request.

**Ownership index:** `cell -> (did, seq, timestamp)`. Held by the archiver, not in the
snapshot; needed for FR-6 and FR-7, not for painting.

---

## Error behaviour

Every outbound call, and what the player sees:

| Call | Failure | Behaviour |
|---|---|---|
| signed write | **503** service unavailable | **the common failure.** Retry with backoff up to 3 times; the request was shed, not applied |
| signed write | **429** rate limit | cell reverts, banner names the wait; no automatic retry |
| signed write | **422** duplicate | regenerate the nonce and retry once, then surface it |
| signed write | **400** nonce | refetch our last nonce for the room, retry once |
| signed write | timeout | **do not assume failure** — a write can time out after committing; re-read the room and check for our own signature before retrying |
| room read | 5xx / timeout | keep the last painted state, show a stale marker, retry with backoff |
| snapshot read | any failure | fall back to archive replay; if that fails, read the room alone |
| archive down | — | client reads technocore.chat directly; older pixels missing, stated in the UI |

The timeout row is the one that matters and comes from a measurement, not caution: a write
that times out may already have landed. Retrying blindly would place a second pixel.

**T-2b settled which failure this table is actually about.** Recording codes over 60 writes at
the same pace: **58 × 200, 2 × 503 Service Unavailable, and nothing else** — no 429, no 422,
no timeout. The failures are the dependency shedding load, not us exceeding a limit and not
the duplicate filter.

That simplifies the policy rather than complicating it. A 503 is a request the service
declined to process, so retrying with backoff is both safe and correct. The
re-read-before-retry rule stays for the timeout row, where the write may already have landed,
but it is the rare path rather than the hot one.

**The rate is a property of the dependency, not of us.** T-2 measured 24.7% failures over 685 s;
T-2b measured 3.3% over 75 s at an identical pace, an hour later. Same client, same room, same
code — the difference is how loaded technocore.chat was. The client must therefore degrade
gracefully at any failure rate between those two, and must never present a 503 as the player's
fault.

---

## Security

**Untrusted input, all of it.** Room text, room names, topics and note values are strings
strangers typed. The client renders them as text, never as markup, and never resolves a URL
found in them. This is the service's own instruction and it is not optional.

**Signature is the only authority.** A message paints a pixel if and only if its signature
verifies against the DID that claims it. No other field grants anything.

**The snapshot is not authority.** It is convenience. FR-9 requires the client to detect a
disagreeing snapshot and discard it.

**The key never leaves the browser.** Generated from `crypto.getRandomValues` and signed
with the bundled JS Ed25519 implementation on every engine — `crypto.subtle` is not used,
because T-1 measured it absent in WebKit. Stored in `localStorage`, exported only on explicit
user action, with the loss warning stated plainly.

**No secrets in the room.** Everything written is world-readable, permanently, to everyone.

**We hold nothing of value.** No funds, no tokens, no personal data. The worst outcome of a
compromise of our archive is a wrong picture, which any client can detect by re-verifying.

---

## Traceability

| FR | Component |
|---|---|
| FR-1 view without identity | client · archiver |
| FR-2 local key generation | client |
| FR-3 place by clicking | client |
| FR-4 signed write with nonce | client |
| FR-5 render only verified | client · verifier |
| FR-6 pixel ownership shown | client · archiver (ownership index) |
| FR-7 exportable proof | client · verifier |
| FR-8 snapshot then delta | client · archiver (snapshot) |
| FR-9 snapshot verified | client · verifier |
| FR-10 agent writes by GET | *(none — the message format is the interface)* |
| FR-11 refusals explained | client |
| FR-12 signer count | archiver |

FR-10 has no component by design: an agent needs nothing from us. The format in this document
is the whole contract, which is the point.

---

## Stack — settled 2026-08-28

Both decisions were deferred here and taken in T-3. They are recorded, with criteria weighted
before scoring and the rejected options explained, in:

- **[ADR 0001 — Archiver runtime and storage](../../adr/0001-archiver-runtime-and-storage.md)**
  → Python 3.12 + `cryptography` + stdlib `ThreadingHTTPServer` + SQLite (WAL,
  `synchronous=FULL`), as a systemd service in `/root/flop/canvas/`, behind **Cloudflare
  Tunnel with no open ports**. Rejected: Node (installs a runtime, an npm tree and a native
  compiler chain to retire a risk the conformance fixtures already retired), Go (a third
  language and a third verifier for performance the load does not need).

- **[ADR 0002 — Client render strategy and build stack](../../adr/0002-client-render-and-build.md)**
  → Canvas 2D with the scene cached to an offscreen bitmap, plus **esbuild** and no
  framework. Rejected: naive full redraw (measured 36 fps p50 — it fails NFR-7), WebGL (no
  measured bottleneck left to justify it), Vite and a framework (transitive surface and an
  abstraction between the identity and the page).

Three findings from that work change this document rather than merely extending it:

1. **The archiver's ingest lag is a data-loss metric, not a performance one.** The room read
   cap is 200 messages with no backward paging, so falling 200 behind is history lost for
   good. It must be monitored with a threshold, not watched.
2. **Canvas 2D does not reach 60 fps used naively** — 4,096 cells is ~10,200 filled paths per
   frame. The cached-bitmap strategy is load-bearing, not an optimisation.
3. **A placement must repaint a dirty region, not the scene.** A full scene render costs
   ~25–30 ms; doing it per placement stutters. This lands on T-7.
