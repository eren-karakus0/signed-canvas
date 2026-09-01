# Signed Canvas — Tasks

Status: draft · 2026-08-28 · derives from `design.md`

Ordered by **risk first**. The unknowns that could invalidate the design are settled before
anything is built on top of them. Learning early is cheaper than replanning late.

Estimates are ranges. The basis is stated because a range without one is still a guess.

---

## Phase 0 — settle the unknowns

**T-1 · Confirm Ed25519 in the browser** — serves FR-2 — ✅ **DONE 2026-08-28**

Result: the assumption was wrong and the requirement moved.

- `crypto.subtle` Ed25519: **Chromium 145 ✓ · Firefox 146 ✓ · WebKit 26.0 ✗**
  (`NotSupportedError` for Ed25519 *and* X25519, while ECDSA and RSA work — a missing
  algorithm, not a flag)
- Bundled JS signer (`@noble/ed25519`, 18.8 KB): **✓ in all three**, signatures
  byte-identical to the `#318` vectors, `did:key` derivation matching the fixture identity
- Cost per signature: Chromium 0.65 ms · Firefox 1.15 ms · WebKit 46 ms

**Decision:** the JS signer is the single code path on every engine. A capability branch
would save 45 ms on one engine and buy a second path to keep correct; not worth it.

*Caveat carried forward:* Playwright's WebKit is not Safari. Real Safari was not tested and
published sources say Apple shipped Ed25519. The decision above makes the question moot,
which is why it was taken that way.

*Artifacts:* `t1-browser-ed25519.html`, `t1-fallback.html`, `noble-ed25519.js`
*Actual:* ~1.5 h against a 2–4 h estimate.

**T-2 · Claim the canvas room and measure it under load** — serves NFR-1, NFR-7 — ✅ **DONE 2026-08-28**

300 placements written to `p-canvas-f4b520b52f488873` over 685 s, then read back.

- **Writes: 226 ok, 74 failed (24.7%)**, bursty rather than steady; median 754 ms,
  **p95 2,247 ms** — 3× the quiet-state p90 of 771 ms
- Reads: median 717 ms, p95 756 ms, 37.7 KiB per 200 messages
- **The finding that changed the design: the read cap is 200 messages and there is no
  backward paging.** `limit=500` returns 200; `since=0` returns the *newest* 200, not the
  oldest; `before`, `until`, `offset`, `from` are all ignored. A canvas past 200 placements
  cannot be read from the room by any request.

**Consequences, all recorded in `requirements.md`:**
NFR-1 kept at 2.5 s but the source moved — direct reads would need 21 sequential requests
(15.2 s) and still miss the oldest pixels; the snapshot is 386× smaller than the equivalent
JSON. NFR-2 relaxed 3 s → 5 s. NFR-6 rewritten: the binding constraint is the 200-message
cap, not the byte trim, so the archiver must stay within 100 messages of the head.

*Measurement gap, stated:* the harness counted failures without recording their status codes,
so the 24.7% is not attributed between 429, 422 and timeout. **T-2b** below closes that.
*Actual:* ~40 min wall clock against a 2–3 h estimate.

**T-2b · Attribute the write failures** — serves NFR-2, NFR-3 — ✅ **DONE 2026-08-28**

60 writes at the same pace, codes recorded: **58 × 200, 2 × 503 Service Unavailable.**
No 429, no 422, no timeout.

The retry assumption was wrong in a way that simplifies the design: failures are the service
shedding load, so backoff-and-retry is safe and correct. NFR-3's write budget needed no
change — at 120 writes/min against a 300/min ceiling, 429 never fired.

**The uncomfortable half:** the same client at the same pace saw 24.7% failures an hour
earlier. The rate belongs to the dependency, not to us. Recorded against assumption 1, which
it sharpens into the product's largest uncontrolled risk.

*Actual:* ~15 min against a 1 h estimate.

**T-2c · Canvas palette and 3D language** — serves FR-1, FR-3, NFR-7 — ✅ **DONE 2026-08-28**

Not a risk task; it became one because T-7 cannot be built against an undecided palette.

Chosen: **Patina**, a 15-step hot→cold ramp (copper oxidising). Two alternatives — Ember
(fire to ice) and Kiln (fired earth) — were rendered at 64×64 in the same scene and
rejected on measurement, not taste: Ember's step 11 sits 8.8 ΔE from the interface accent
that the crosshair is drawn in; Kiln's cold end carries no chroma.

Two defects were found by measuring and fixed before the choice was put:

- **Compressed cold end.** Ramps built in HSL lightness gave adjacent-step ΔE of 15–25 at
  the hot end and 3–7 from step 09 on, so neighbouring swatches were indistinguishable.
  Resampling at equal Lab arc length raised the minimum from 4.8 to 6.5 and cut
  indistinguishable pairs from 7 to 4.
- **A green step in Kiln.** The 40°→206° hue rotation crossed green while saturation was
  still 7%. Neutralising the crossing (chroma 2.3) removed it.

Recorded with the full ramp, the measurements, and the resulting constraint — *no
ink-coloured interface element may sit over the canvas* — in `.design/identity.md`.
The 3D language (2:1 axonometric, elevation = contest count) is recorded there too.

*Actual:* ~1.5 h, unestimated.

**T-3 · Decide the stack** — `/tech-select`, serves the open decision in `design.md` — ✅ **DONE 2026-08-28**

Two ADRs, three-plus candidates each, weights fixed before scoring:
`docs/adr/0001-archiver-runtime-and-storage.md` · `docs/adr/0002-client-render-and-build.md`

- **Archiver:** Python 3.12 + `cryptography` + stdlib `ThreadingHTTPServer` + SQLite (WAL,
  `synchronous=FULL`), systemd service in `/root/flop/canvas/`, behind **Cloudflare Tunnel —
  no open ports**. Host inventory drove this: Python 3.12.3, `cryptography` 41.0.7 and
  SQLite 3.45.1 are already installed and already used by `flop-agent`; **Node, npm, nginx
  and Docker are not**, and only port 22 was reachable.
- **Client:** Canvas 2D with the scene cached offscreen, esbuild, no framework.

**The measurement that changed the plan.** 180 frames of pan and zoom over a fully-painted
4,096-cell scene, headless Chromium 145 (`bench/fps-bench.html`):

| strategy | p50 | p95 |
|---|---|---|
| full redraw every frame | 27.8 ms · **36 fps** | 47.1 ms · 21 fps |
| scene cached, blitted under transform | 16.7 ms · **60 fps** | 18.0 ms |
| cached + full invalidation per frame | 37.0 ms · **27 fps** | 47.2 ms |

The default approach fails NFR-7, and a full scene render costs ~25–30 ms — so **T-7 must
repaint a dirty region on placement, not the scene.** Requirement discovered by measuring,
added to T-7 below.

*Actual:* ~1 h against a 1–2 h estimate.

---

## Phase 1 — the spine

**T-4 · `verifier`, shared** — serves FR-5, FR-9 — ✅ **DONE 2026-08-28**

`src/crypto/` — `sweep` (the six invisible categories), `did` (did:key parse, public key,
fingerprint), `canonical` (the payload strings), `verify` (Ed25519 via `@noble/ed25519`).
10.3 KB minified, one production dependency.

**Node:** 60 checks from the fixture pass — 20 sweep cases, 3 identities × 2, 8 rejected
`did:key` shapes, 5 signature cases × 5.

**Browsers:** 54 checks pass in **Chromium 145, Firefox 146 and WebKit 26.0**
(`npm run test:browser`). This run is not redundant with Node: T-1 measured WebKit with no
Ed25519 in `crypto.subtle`, and the verifier still needs WebCrypto for SHA-512 and SHA-256,
so only the browser run says the product works rather than the logic.

**Beyond the fixture.** The vectors say what must *pass*; what must *fail* is ours to assert
and is the half that matters, because a verifier that returns true unconditionally passes
every positive vector. Added: a payload with one byte appended must not verify; a signature
must not verify against a different identity; and each swept character must produce its own
space rather than a collapsed run — the mistake that reads as tidying up and signs a string
the server never stores.

**Provenance, recorded and not glossed:** `#318` was still an **open pull request from a
fork** when the fixture was taken. It is generated from the server's implementation and
`technocore-keykit` passes all of it, but it is not upstream and carries no guarantee. The
file is committed with its hash (`test/vectors/README.md`) rather than fetched, so a change
upstream shows up as a diff instead of as a silent drift — which matters here because the
server answers 403 for a wrong sweep and a forgery alike, and would never say which.

*Depends on:* T-1.
*Actual:* ~1 h against a 3–5 h estimate · the port from `technocore-keykit` was the easy
part; the browser matrix run was the part worth doing.

**T-5 · `archiver`: read, verify, persist** — serves FR-8, FR-12, NFR-6 — ✅ **DONE 2026-08-29**

`server/canvas/` — `verifier.py` (the Python half of the signed lane), `placement.py` (the
wire format), `archive.py` (SQLite, WAL, `synchronous=FULL`), `ingest.py` (the loop).
Its own systemd service in `/root/flop/canvas/`, sharing no code and no state with
`flop-agent`. **23 Python tests pass.**

**The finding that changed the product** *(measured 2026-08-29 against service 0.10.0;
superseded 2026-09-01 — see T-14)*. The room read returns `seq, ts, from, text, nonce` and
**never the signature** — checked across `format=json`, `verbose`, `full`, `include=sig`,
`sig`, `signed`; no single-message route; `/openapi.json` declares no schemas; `/config` has
no knob. The server verifies on write and keeps the signature to itself.

So an archive built from room reads cannot let anyone re-verify anything. FR-5 and FR-7 were
revised rather than quietly reinterpreted, and the archive now records which of two claims
each pixel rests on: **attested** (the service's word) or **witnessed** (a signature that
verified here, against the payload rebuilt from the archived row, for a message that really
is in the room). Both checks in `witness()` are required and independent — a signature alone
proves possession of a key, never publication; a room row alone proves publication, never
authorship.

**Live end-to-end.** Against the T-2 room: 200 messages read, **115 placements archived, 2
signers, lag 0**, one 503 handled by backoff. The other 85 lines were rejected — they read
`px 51,25 13 c53172`, a two-digit decimal step, while the format in `design.md` is one hex
digit. Our own T-2 load-test script wrote a non-conformant format, and the parser refusing it
is the strictness working, not a bug. Strict stays: two spellings of one pixel would mean two
signatures for one meaning.

**Durability, stated at the strength it was actually proven.** `KillMidStream` SIGKILLs a
writer mid-stream and finds no acknowledged write lost. But the test was re-run with
`synchronous=OFF` and **still passed** — the OS page cache outlives a process, so killing one
tests batch atomicity, not the fsync setting. Only losing the machine would. `synchronous=FULL`
is set for that case and is guarded by a pragma assertion rather than claimed as verified.
Saying "RPO = 0, proven" on the kill test alone would have been overclaiming.

**Ingest lag: ADR 0001 was wrong and is corrected there.** It set the threshold at 200 and
called falling 200 behind data loss. `?since=<seq>` pages forward, so a reader 1,000 behind
catches up in five requests; the 200 cap bounds a batch, not reachability. The real loss
condition is the room trimming before we read, and retention is not published — so the
threshold is now 500 and `ingest.py` labels it a conservative guess, not a derived bound.

*Depends on:* T-3, T-4.
*Actual:* ~2 h against a 1–2 day estimate. Most of the time went to establishing the
signature finding well enough to act on it.

*Not done here:* the service is written but **not yet deployed** — no systemd unit installed,
no `cloudflared` tunnel, nothing running on the server. That is T-6's other half.

**T-6 · `archiver`: snapshot and delta endpoints** — serves FR-8 — ✅ **DONE 2026-08-29**

`server/canvas/snapshot.py` (packing) and `app.py` (five routes, loopback only).
**36 Python tests pass** across the four test files.

    GET  /snapshot        two packed planes plus the seq they are current to
    GET  /since/<seq>     placements newer than <seq>, oldest first
    GET  /cell/<x>/<y>    every placement in one cell — FR-6, and the FR-7 export material
    POST /witness         attach a signature to an archived placement
    GET  /health          what the archive holds, including ingest lag

**The snapshot carries two planes, not one.** 2,048 bytes of palette indices *and* 512 bytes
of witness bits. A client given only colours would have to paint every pixel as equally
proven, and after the T-5 finding it is not. Whether a pixel is witnessed or attested has to
survive the packing or the interface cannot tell the truth about what it is showing.
Measured on the server: **3,505 bytes of JSON for 114 painted cells.**

**Acceptance met byte-for-byte.** `snapshot + delta == full replay` is asserted on the packed
planes, not on pixel counts — the failures worth catching are the ones where the canvas is
*nearly* right: a cell keeping an older colour because two placements landed in it, a witness
bit surviving a repaint, an off-by-one at the delta boundary. Both planes compared, over the
archive directly and over HTTP.

**A test that was passing vacuously, found and fixed.** The HTTP round-trip built its second
batch with sequences `1..40` against an archive already holding `1..120`. `seq` is the primary
key, so every row was ignored, the delta came back empty, and the assertion compared a
snapshot with itself. It now asserts the delta actually carries 40 placements, and the helper
documents why `start` exists — a test that cannot fail is worse than no test, because it is
counted.

**Deployed and running on the server.**

```
/health → {"room":"p-canvas-f4b520b52f488873","seq":286,"room_seq":286,
           "lag":0,"placements":115,"witnessed":0,"signers":2}
```

- `canvas-ingest.service` and `canvas-api.service`, both `active`, in `/root/flop/canvas/`
- **27 MB resident between them**, against the 300 MB threshold ADR 0001 set
- `ss -tlnp`: still only port 22 outward, `8787` on loopback — no port was opened
- `flop-agent` and `flop-watchdog` untouched and still triggering on schedule

*One deployment bug, found by the install script's own health check:* `ProtectHome=true`
hides `/root` from a unit, and the service's data lives at `/root/flop/canvas`, so systemd
refused the working directory before Python started (`status=200/CHDIR`). The hardening
contradicted the data location. `ProtectSystem=strict` plus a single `ReadWritePaths` is what
actually confines this service, and the unit now says so.

*Depends on:* T-5.
*Actual:* ~1.5 h against a 4–6 h estimate.

*Not done, and it needs you:* the **Cloudflare Tunnel is not set up**. `cloudflared tunnel
login` opens a browser and needs the account holder, and the token it mints is a credential
this repository must not hold. Steps are in `server/deploy/TUNNEL.md`. Until then the archive
is reachable only from the host, and the client falls back to reading the room directly —
the last 200 placements and nothing older, which the interface must state rather than pass
off as the whole canvas.

---

## Phase 2 — the thing people touch

**T-7 · Canvas render and hit-testing** — serves FR-1, FR-3, NFR-7 — ✅ **DONE 2026-08-28**

Built as `src/canvas/` — `projection` (2:1 axonometric), `grid` (cell state), `scene`
(offscreen scene bitmap + pick buffer + dirty regions), `view` (pan, zoom, input, one
paint). 10.4 KB bundled against a 60 KB budget. `npm run check` runs the lot.

**Measured, headed, real compositor** (`npm run bench -- --headed`):

| | Chromium 145 | Firefox 146 | WebKit 26.0 |
|---|---|---|---|
| paint work p95 | 0.2 ms | 1.0 ms | 1.0 ms |
| placement invalidate p95 | 0.3 ms | 1.0 ms | 1.0 ms |
| full redraw, avoided | 7.9 ms | 25.0 ms | 7.0 ms |
| dropped frames / 179 | 0 | 0 | 1 |
| pick correctness | 4096/4096 | 4096/4096 | 4096/4096 |

Hit-testing uses a second offscreen buffer that paints each cell's index as a colour, rather
than inverting the projection: elevation makes "which cell is under the pointer" a
visibility question, and a raised tile hides the tiles behind it. Nine pixels are sampled
and the majority taken, because an antialiased boundary pixel holds a blend of two ids and
can decode to a third cell — and a mis-pick would place a signed pixel in the wrong cell,
which is not recoverable. Verified on all 4,096 cells against an invariant that does not
assume the answer: the top-face centre of a cell must resolve to that cell or to one drawn
later, never to one drawn earlier. 3,825 exact, 271 correctly occluded, 0 wrong.

**Three things the measurement corrected, each after the number disagreed with the plan:**

1. **The first gate was measuring the wrong thing.** Gating rAF *interval* p95 at 16.7 ms
   failed all three engines at 17–19 ms while paint work was 0.1 ms — it was gating vsync
   and scheduler jitter. The gate is now paint work plus dropped frames.
2. **The dirty region was buying nothing, then it was.** Chromium measured 11.2 ms per
   placement against 13.7 ms for redrawing all 4,096 cells. Cause: the ground grid lines
   span the whole buffer, so clipping alone did not make them cheap. Clipping each segment
   to the region (Liang–Barsky) brought it to 0.2 ms.
3. **The placement benchmark measured a path the application does not take.** Calling
   `paint()` in a tight synchronous loop forces a GPU flush per call and reported ~8 ms for
   work that costs 0.1 ms inside rAF. `main.ts` schedules one frame instead.

**Not clean, and recorded rather than trimmed:** headless WebKit drops 0–8 of 179 frames
(up to 4.5%) at unpredictable positions, while paint work stays at 1 ms. Headed WebKit on
the same machine drops 0–1. A renderer using 6% of the frame budget cannot cause a 30 ms
frame, but this is not attributed and the gate tolerates 2%, not 0.

*Actual:* ~3 h against a 1–2 day estimate. The render was a known quantity from
`palette-lab.html`; the time went to the measurement being wrong three times.

*What was not done here:* keyboard navigation of the canvas itself (T-12), and any real
data — the canvas paints from `src/sample.ts` and says so in the interface.

---

**T-7 original scope, for reference** — serves FR-1, FR-3, NFR-7
64×64 in the PLOT identity: zero radius, crosshair, accent cyan, 2:1 axonometric, elevation =
contest count, PATINA ramp. Pan, zoom, per-cell hover.

Two constraints come from ADR 0002 and are not negotiable inside this task:
- The scene is drawn **once** to an offscreen bitmap; pan and zoom blit it under a transform.
- A placement repaints **only its dirty region**. A full scene render is ~25–30 ms and will
  stutter if done per placement.

*Done when:* 4,096 cells render and hover correctly with **p95 frame time ≤ 16.7 ms on real
hardware across Chromium, Firefox and WebKit** — the ADR's numbers are headless Chromium
only — a placement repaint stays under 16.7 ms, and the result is screenshot-verified against
`.design/identity.md`.
*Depends on:* T-3.
*Estimate:* 1–2 gün · basis: the render is a known quantity from `palette-lab.html`; the
dirty-region logic and the three-engine measurement are the new parts and are where the
spread comes from.

**T-8 · Identity in the browser** — serves FR-2 — ✅ **DONE 2026-08-29**

`src/identity/` — `key.ts` (generate, derive `did:key`, sign) and `store.ts` (persist,
export, import, forget). `src/ui/identity-panel.ts` carries the warning.

**The signer is checked against the server's own output, not against itself.** The fixture
carries a seed *and* the signature the server's implementation produced for a known payload,
so `sign(seed, payload) === sig_canonical` is a real assertion. A signer that only satisfies
our own verifier proves self-consistency and nothing else. All five signature cases match
byte for byte, and all three published identities derive their published DID.

**The warning blocks placement on the visit where the key is created.** Not a settings page,
not a footnote: a panel over the canvas, dismissible only by acknowledging, offering "copy the
seed, then continue" first. Friction once, deliberately, because the alternative is someone
finding out by losing something. `isPersistent()` also probes storage up front — a private
window that will not keep the key says so before the first pixel, not on reload.

`load()` throws rather than discarding an unreadable record: silently replacing a key would
orphan every pixel already signed with it.

**Not done:** the seed is stored in plain `localStorage`. Encrypting it under a passphrase was
considered and rejected for now — it would mean a passphrase prompt on every visit for a key
whose whole appeal is that placing a pixel takes one click. The exposure is documented in
`store.ts` and in the panel rather than papered over.

*Actual:* ~1 h against a 4–6 h estimate.

**T-9 · Placement, with the failure paths** — serves FR-3, FR-4, FR-11, NFR-2, NFR-3 — ✅ **DONE 2026-08-29**

`src/net/room.ts` (the write and every refusal), `src/net/nonce.ts` (strictly increasing per
key and room), `src/canvas/wire.ts` (the placement grammar, both directions).
**125 Node tests pass**, 13 of them forcing one refusal each.

| forced | behaviour |
|---|---|
| 200 | placed, `seq` reported, signature kept for witnessing |
| 503 | retried on a backoff schedule, then refused — and the message never blames the person |
| 429 | reverted, the server's own `retry-after` surfaced, **not** retried |
| 422 | reverted, named as the duplicate filter |
| 400 | reverted, the server's words carried through — the nonce is the likely cause |
| 403 | reverted, named as *our* bug: the client and server disagree about the bytes |
| timeout, write landed | **reported placed, and the test counts write attempts to prove no second pixel** |
| timeout, not landed | retried |
| timeout, room unreadable | reported `unknown` — never guessed either way |

**Two adaptations forced by measurement, both recorded where they bite:**

1. `design.md` said a timeout should "re-read the room and check for our own signature". The
   room never returns signatures. The placement text already carries a random six-character
   token for the duplicate filter, and that makes each attempt unique — so the check is our
   DID plus that exact text, which answers the question more directly than a signature would.
2. **technocore.chat is not readable from a browser** *(true of 0.10.0; the service opened
   CORS in the 0.11 line — see T-14)*. No endpoint sends
   `access-control-allow-origin`; its own first line is "No auth, no client, no JS". A signed
   write is a simple GET so the browser still sends it, but the status and `seq` are
   invisible — which makes FR-11 unimplementable. Writes now go through `POST /relay` on our
   archive, which forwards the signed tuple and returns the real upstream status. **Deployed
   and verified on the server:** a bad signature is refused with 422 *before* any upstream
   request is spent, a malformed body with 400.

**A bug a screenshot caught, not a test.** The canvas was loaded with a top-level `await`, so
the ramp and the counters were built after it. A slow or failed room read — 3–25% by
measurement — left the page with no colours to pick. The interface is now built first and the
network never blocks it.

**Blocked, and this is the honest state:** placing does not work from a browser yet, because
the relay lives behind the archive and **the tunnel is not up**. The CORS finding moved the
tunnel from "nice to have" onto the critical path. The interface says so on click rather than
painting a pixel it cannot confirm.

*Actual:* ~2 h against a 1–2 day estimate.

**T-10 · Pixel record and exportable proof** — serves FR-6, FR-7 — ✅ **DONE 2026-08-29**

`src/net/proof.ts` (the record and the export), `src/ui/clipboard.ts` (copying, and saying
what happened). Hovering a painted cell names its owner and what the claim rests on; one
button exports the material.

**The export is two different documents, because the claim is two different claims.** A
witnessed pixel exports the canonical payload, the signature and the DID — checkable by a
stranger, offline, with no reference to this site. An attested pixel exports the payload, the
DID, and a plain statement that **the signature was never published and nobody can re-check
it**. It carries no signature field at all: a proof-shaped block with a payload and no
signature reads like a proof to anyone not looking closely, and that is the one deception
this product cannot afford.

Tested as a pure function (`test/proof.test.ts`, 11 checks) rather than through the browser,
because the thing worth asserting is the text. The strongest one parses the DID, payload and
signature back out of the exported text — the way a stranger would — and verifies them; and
the attested export is asserted to contain nothing matching an 86-character signature.

**Three bugs found by the end-to-end test, none of which a unit test could see:**

1. **The identity gate would not close.** `hidden` was set, but `.gate { display: grid }`
   overrides the user agent's `[hidden] { display: none }`. A person clicking "I understand"
   would have been stuck behind it.
2. **The proof button could never be clicked.** Moving the pointer from the canvas towards
   the button fired `pointerleave`, which cleared the hover, which disabled the button. The
   inspection is now pinned to the last painted cell and the hint names which cell it is for.
3. **Your own pixel was reported as not existing.** Ownership came from the archive, and for
   a few seconds after a placement the ingest loop has not read it back yet — so the
   interface said "nothing placed here yet" about a pixel just placed. The client now records
   its own placement locally, where it holds better material than the archive anyway: it
   computed the signature, so the proof is exportable immediately.

**And one it found in code written earlier:** a refused clipboard was silent. `writeText`
rejects more often than it looks — insecure context, denied permission, unfocused page — and
the two things this product copies are an identity seed and a proof. Someone who believes
they have a seed and does not finds out at the worst possible moment. `copyText` now returns
the outcome and every caller states it.

*Depends on:* T-6, T-7.
*Actual:* ~1.5 h against a 4–6 h estimate.

*Verified end-to-end five times* against the live service (seq 6, 9, 10, 11, 12 in `fplace`),
each time placing a pixel, finding it in the room, and finding it witnessed in the archive.

---

---

## Phase 3 — before anyone sees it

**T-14 · Follow technocore.chat 0.10.0 → 0.11.2** — serves FR-5, FR-7 — ✅ **DONE 2026-09-01**

The dependency changed under two findings this product was built on. Both were re-measured
rather than re-read, because the manual is the thing that changed and believing it is how a
correction becomes a second error.

| claim | 2026-08-29 (0.10.0) | 2026-09-01 (0.11.2) | how it was re-checked |
|---|---|---|---|
| room reads carry no signature | true | **false** — `sig` on `?format=json` and `?since=` | 200 `lobby` records re-verified locally: 200 pass, 0 fail |
| no CORS on any endpoint | true | **false** — `access-control-allow-origin: *` | real cross-origin fetch from an `http://` origin in Chromium, Firefox, WebKit |
| whole-room dump | none | `GET /r/<room>/export`, raw JSONL | fetched; byte-for-byte as stored |

Round-tripped one placement to close the loop: signed offline, written with one GET, read
back with a **byte-identical** signature that re-verifies from the room read alone.

Changed: `archive.py` reads `sig` off each message and verifies it here before storing;
`ingest.py --backfill` re-reads a room from its start, because `?since=` only pages forward
and the cursor was already past every pre-0.11.0 row. 13 new tests in
`test_room_signatures.py`, mutation-checked — trusting the field instead of verifying it
fails 6 of them, removing the backfill fails 1. **55 Python tests pass**, up from 42.

Deployed and backfilled on the server, archive backed up first: **`fplace` is now 7 of 8
placements witnessed**, up from 6, and the eighth is the third-party pixel from 2026-08-29,
which predates the field and is permanently attested. The archived cursor did not move.

*Two things this did not do, both deliberate:* the witnessed/attested split stays, because
pre-0.11.0 records can never gain a signature; and the relay is still the only write path,
which is now a censorship point rather than a necessity — recorded as open work in
`requirements.md` under FR-11.

*Not re-derived:* `LAG_ALERT = 500` was picked when no retention bound was published. One is
now documented (~10 MiB ring, 64 KiB guaranteed floor), so the guess is replaceable with a
derived number and has been left as a labelled guess instead.

*Actual:* ~2 h, mostly measurement.

**T-15 · The relay stops being the only write path** — serves FR-11 — ✅ **DONE 2026-09-01**

`place()` tries the relay first and writes straight to the room when it does not answer.
Until 0.11.0 there was no choice about this, and the consequence was easy to miss: while the
relay is the only lane, this project is the single point that can censor a write. That is a
worse property than the round trip the relay saves.

The whole difficulty is one distinction — **did the relay reach technocore and repeat its
answer, or did it never get there?** Both arrive as a status code and both can be 503, and the
two mistakes run in opposite directions: re-sending a write the service already refused as a
duplicate, versus abandoning one it never saw. So it is stated, never inferred. `app.py` sets
`x-relay-upstream` (named in `access-control-expose-headers`) only when it has an upstream
status to report, and its absence reads as "no word from upstream" — the assumption that
cannot place a second pixel. Before falling back, the room is asked whether the write landed
anyway, because the relay's own 504 says outright that it might have.

10 new tests, mutation-checked: falling back without asking the room fails 1, and falling back
on a faithfully reported refusal fails 3. **146 client tests pass**, up from 136.

*A body-field version of this was written first and thrown away.* `RoomError` truncates the
body to 200 characters before anyone parses it, so reading `upstream_status` out of the JSON
would have depended on the field surviving that cut — which it does today only because it
happens to be the first key. A header does not rot that way.

**Proven live at 16:28 UTC, and the proof came with a limit worth more than the proof.**

With the relay cut at the browser, a click wrote `px 11,35 5 zg5le7` straight to the room —
**seq 16**, and the archive holds it `witnessed: true`. A browser placed a pixel with nothing
of this project in the path, which is exactly the property T-15 exists to establish.

The interface nevertheless said *"not placed, and not certain"*, and it was right to. The
service was shedding ~35% of writes at the time, and:

> **A 503 from technocore.chat carries no CORS headers.** Measured over 20 reads while the
> service was recovering: **9 of 9 `200` responses carried `access-control-allow-origin`, 0 of
> 11 `503` responses did.** The shedder answers in front of whatever adds those headers.

So from a browser a 503 is not a 503 — it is an opaque `TypeError`, indistinguishable from the
network being down. The direct lane still retries, still asks the room, and still refuses to
claim either outcome; it simply cannot name the reason. That is the honest failure and it is
what the run produced.

**This sharpens FR-11 rather than weakening it.** The relay is not a convenience that saves a
round trip: it is the only way a browser can learn *which* refusal occurred while the service
is shedding, which is the requirement as written. Keeping the room as a fallback is still
right — a censorable single path is worse — but the two lanes are not equals, and the code and
`requirements.md` now say which is which.

One consequence to accept knowingly: on the fallback lane a pixel that really landed can be
reported as uncertain, so the optimistic paint is rolled back and the pixel reappears on the
next archive sync. Better than the alternatives, which are claiming a success we did not
observe, or a failure that is not true.

**T-11 · Agent path documented and proven** — serves FR-10 — ✅ **DONE 2026-09-01**

`agents/README.md` (the whole protocol), `agents/place.py` (place a pixel), `agents/verify.py`
(check the canvas from the room alone), `agents/test_conformance.py`.

The one-liner in the original task was the wrong shape. A pixel needs an Ed25519 signature, so
`curl` alone cannot place one and a document that implied otherwise would waste a reader's
afternoon. What ships instead is a script that does the whole thing in one command, plus the
format written out precisely enough to reimplement in any language — and an explicit statement
that a fetch-only agent **cannot** play here, which is a real limit of requiring signatures.

`verify.py` is the piece that did not exist before T-14. Reading the room and re-checking every
signature was impossible under 0.10.0; it is now the strongest thing this project can hand a
stranger, because running it involves nothing of ours.

**Held to the same fixture as the client.** `agents/place.py` is a *third* implementation of
one grammar — TypeScript in `src/crypto/`, Python in `server/canvas/verifier.py`, and this
one. Three hand-checked implementations are three chances to be quietly wrong in different
places, so all three now run against `test/vectors/technocore-318.json`: 20 sweep cases, 3
identities, 8 malformed DIDs, 5 signature cases and all 80 accepted signature spellings. 13
tests, mutation-checked — collapsing whitespace runs in the sweep fails 2 of them.

Cross-checked against our server verifier as well: a signature produced by `place.py` verifies
under `server/canvas/verifier.py`, and a payload with one byte appended does not.

**Proven live at 16:27 UTC**, once the service came back: `place.py` placed `px 20,20 5 7fh0p6`
at **seq 15**, and the archive holds it `witnessed: true` with its signature — a pixel written
by a script that uses nothing of ours, witnessed because the room now publishes the signature.
`verify.py` then re-checked the whole canvas from the room alone: 9 placements, 2 VERIFIED, 7
UNSIGNED (all pre-0.11.0), **0 bad**.

*And running it found a bug in it.* The first live attempt exited 1 on a 503 — while the
README's own table, three sections up, says a 503 means the write was not applied and should
be retried. The script did not do what its documentation promised. It now backs off over
1/3/7/15 s for 503 and 530 only; every other refusal is an answer about that request and
re-sending it just spends another. The successful run needed four attempts.

That is the whole reason a task says "done when it works copy-pasted" rather than "done when
it is written".

**T-16 · Deliver the 413 a caller earned** — ✅ **DONE 2026-09-01**

Found while verifying T-14, not looked for. `test_witness_refuses_an_oversized_body` failed
about one run in five; measured before the fix at **17 of 20 passing**, after it at 20 of 20.

It was not a flaky test. `/witness` and `/relay` refused an over-length body by answering 413
without reading it — correct for a size guard, since draining whatever a caller sends is the
attack rather than the defence — and then closed the socket while the peer was still writing.
The peer's write failed first, so it saw a reset connection instead of the 413 that explains
what it did wrong. Now a bounded 64 KiB is drained before the refusal, which is enough for an
honest mistake to get a legible answer and far short of making an oversized body free work.
Verified against the live API: `HTTP 413 {"error":"body must be 1..4096 bytes"}`.

**T-17 · Make `npm run check` mean what it says** — ✅ **DONE 2026-09-01**

Wiring the new agent tests into a command exposed that the project's one verification command
was checking about half of what existed. Three separate faults, each found by fixing the one
before it.

**68 Python tests had no command that ran them.** `check` covered the client and stopped
there, while `server/canvas/` and `agents/` sat outside it. `scripts/test-python.mjs` now runs
both suites through stdlib `unittest` — not pytest, which is absent on the deployment box.

*Its first version picked the wrong interpreter.* It probed for "a Python 3" and this machine
answers that three ways: a real 3.13.5, the `py` launcher, and the Microsoft Store stub that
owns `python3` and has no site-packages. The stub won and failed on `import cryptography`,
several layers from the cause. It now probes for what the suites actually need — an Ed25519
library — which is both the correct question and a clearer failure when nothing satisfies it.

**The benchmark had been silently broken.** `bench/run-matrix.mjs` waits on `window.__canvas`,
and nothing had assigned it for some time; the last few full verifications simply did not list
`bench`, so nobody noticed. The handle is back, compiled in only by `build.mjs --bench` into
its own `dist-bench/`, so the shipped bundle is byte-for-byte the file it was rather than "the
same minus a line". Confirmed: 0 occurrences of `__canvas` in `dist/main.js`, 1 in the bench
build, and `dist/` still 33.1 KB.

**Then the benchmark failed WebKit, twice, for reasons that were not the renderer.**

1. *Dropped frames were gated against a flat 25 ms* — "1.5 vsyncs", correct only where a vsync
   is 16.7 ms. Measured directly: **headless WebKit on this machine runs its rAF loop at 30 ms
   p50 on a blank page doing nothing**, with 106 of 179 idle frames already past 25 ms. The
   canvas was beating that baseline (74 against 106) and the gate called it a regression. The
   threshold is now 1.5× the engine's own idle cadence, measured per engine in the same
   session. Not a loosening: at 16.7 ms it derives 25.05 ms, so Chromium and Firefox still
   gate at 25 ms and only WebKit moves, to 45 ms.

2. *A handled error was gated as an unhandled one.* Playwright's `pageerror` fires in WebKit
   for a CORS-blocked `fetch` **even when the rejection is fully caught** — verified with an
   isolated probe in all three engines, in both the `.catch()` and `try/await/catch` shapes:
   two caught fetches, two `pageerror` events in WebKit, none in Chromium or Firefox. So an
   upstream outage failed the benchmark on WebKit alone, for a request the client handles.
   The gate now reads `unhandledrejection` and window `error` events collected in the page,
   which do not fire for a caught rejection anywhere; the engine's own report is still printed,
   labelled as handled.

   Worth stating plainly, because it is the useful half: with the right instrument the client
   reports **zero** unhandled errors through a complete upstream outage.

`npm run check` now runs typecheck, 146 client tests, 68 Python tests, 162 crypto checks across
three engines, the build and its budget, and the benchmark including the pick invariant on all
4,096 cells. It passes.

**T-13 · The honest framing** — ✅ **DONE 2026-09-01**

One line under the title, in body type, above the fold: *"A demonstration of signed identity
on a public message service. No token, nothing for sale, and not affiliated with Flop Labs."*

Placed beside the claim rather than in a footer for a specific reason: a page that says "every
pixel is signed" next to a `did:key` reads like a token project to anyone skimming, and the
correction has to arrive before that impression does. Body type rather than the `micro` label
style, because it is the one line on the page a person actually has to read.

Contrast checked as composited rather than as tokens: `sagla.py` measures the ink/ground pair
and this line is the ink at 72% opacity, which is a different colour. **5.70:1**, over the
4.5:1 body-text floor.

**T-18 · Published** — ✅ **DONE 2026-09-02** — <https://signed-canvas.vercel.app>

Public repository at <https://github.com/eren-karakus0/signed-canvas>, deployed on Vercel with
a free stable hostname. No domain purchased and no paid service added; the only running cost
remains the server that was already there.

**The archive's address is no longer a published fact.** The client asks its own origin for
`/api/*` and `api/proxy.js` forwards it from the server side, reading `ARCHIVE_ORIGIN` from
the environment. Verified on the deployed site: the tunnel hostname appears **0 times** in the
page and **0 times** in the bundle. That matters because the archive sits behind a Cloudflare
*quick* tunnel whose name Cloudflare reassigns on every restart — compiled into a build, that
name is a broken site waiting for a restart; as an environment variable it is a one-line
change with no rebuild. Same-origin also removes CORS between the page and our own archive
entirely.

*The catch-all route was a guess, so it was measured.* `api/[...path].js` matched `/api/health`
and `/api/a` and 404'd on `/api/a/b` and `/api/cell/20/20` under `vercel dev` — a single-segment
match wearing catch-all syntax. Replaced with an explicit rewrite in `vercel.json`, which
states the mapping instead of relying on it.

*The header the fallback depends on was verified through the proxy before deploying, not
after.* A real signed write posted through `vercel dev` came back `x-relay-upstream: 200` and
landed at seq 17. Had the proxy dropped that header, every refusal would silently have read as
"no word from upstream" and a browser would re-send writes the service had already refused.

*Local now matches deployed.* `scripts/local-server.mjs` serves `dist/` and forwards `/api` the
same way, so screenshots, the benchmark and the end-to-end test all exercise the deployed
shape. Without it the benchmark would have measured paint work on a canvas that failed to load
and reported better numbers than the product achieves.

**Driven live, as a person:** the page loads, states what it is, blocks a first placement
behind the key warning, and placed a signed pixel at **seq 18** — zero unhandled errors.

*And the screenshot of that run found a bug no test had.* The readout said `step empty` beside
the owner of a pixel plainly on screen: placing refreshed the ownership half of the row and
not the other half, because the pointer had not moved. Every assertion about that path checked
the owner line, which was correct.

**Two things left, both needing a browser and neither mine to click:**

- The Vercel GitHub App is not installed on the account, so `vercel git connect` is refused and
  pushes do not deploy themselves yet. Deploys are `vercel --prod` until it is.
- `ARCHIVE_ORIGIN` is set for Production and Development but not Preview; this CLI version
  refuses the non-interactive form. It only matters once the GitHub connection exists.

**And one risk this created:** the public site now depends on a tunnel that nothing watches.
`flop-watchdog` checks the Technocore identity only, and `canvas-tunnel.service` is
deliberately `Restart=no` — so a tunnel that dies stays dead, silently, and the site shows
"the archive could not be read" until someone looks. Monitoring it is the next thing worth
doing.

**T-12 · Reduced motion, contrast, mobile legibility** — serves NFR-8, NFR-9
*Done when:* `sagla.py` is clean and screenshots at 390 px wide are legible.
*Depends on:* T-7.
*Estimate:* 3–4 h.

**T-13 · The honest framing** — serves the "out of scope" section
Copy stating plainly that this is a toy demonstrating signed identity, carries no token, and
is not affiliated with Flop Labs.
*Done when:* present on the landing page above the fold, not in a footer.
*Depends on:* T-7.
*Estimate:* 1 h.

---

## Sequencing note

T-1 and T-2 come first because both can invalidate work built on them: T-1 decides whether
FR-2 is a 4-hour job or a WASM dependency, and T-2 decides whether NFR-1 survives contact with
a real canvas. Neither is a big task; both are cheap answers to expensive questions.

**Total, phases 0–3: roughly 8–13 working days**, assuming the T-1 and T-2 answers are the
expected ones. If Safari lacks Ed25519 or NFR-1 fails at 500 pixels, add 2–4 days and revisit
`requirements.md` before continuing — the spec changes, not just the schedule.
