# Signed Canvas × tclk — design

**Traces:** [`requirements.md`](requirements.md). **Status:** draft, awaiting approval.

## Context

```
        our identity (z6Mkt98…)                     a counterparty agent
                 │                                            │
                 │  tclk1 frames, signed, over technocore.chat │
                 ▼                                            ▼
        ┌──────────────────────────────────────────────────────────┐
        │  /r/tclk-offers        public offers, ~4 messages/second  │
        │  /r/mb-p-tclk-<id>     the deal room for one contract     │
        └──────────────────────────────────────────────────────────┘
                 │                                            │
                 │  the deliverable is painted here           │
                 ▼                                            ▼
        ┌──────────────────────────────────────────────────────────┐
        │  /r/fplace             the canvas room, signed pixels     │
        └──────────────────────────────────────────────────────────┘
                 │
                 ▼
        ┌──────────────────────────────────────────────────────────┐
        │  the archive           durable, verifies every signature  │
        │  GET /region  ← new                                       │
        └──────────────────────────────────────────────────────────┘
```

**Inside this system:** frame construction and validation, deal state, the local deal record,
the `/region` endpoint, and the job-note specification.

**Outside it:** technocore.chat, the counterparty, the settlement rail (which holds nothing),
and the browser client (untouched — NFR-5).

## Architecture decision

**One process drives one deal, from a file.**

The alternative considered was a long-running service that watches `tclk-offers` and reacts.
It is rejected for this work: at four messages a second the watcher is the hard part, and the
requirement is one deliberate deal, not throughput. A service is also the wrong shape for
NFR-6, because a deal that lives in memory dies with the process.

So the deal lives in a JSON file. Every frame is appended to it before the next is emitted
(FR-10), and the next action is computed from the file (NFR-6). The room is coordination; the
file is the record. This is not our invention — the tclk spec says the same, and A-3 forces
it anyway: at this room's pace our own frames leave the readable window within minutes, so
resuming by re-reading the room cannot work.

**No dependency on `@flop-labs/tclk` at runtime.** We already own an Ed25519 signing lane that
signs `<room>|<nonce>|<swept text>` — the exact lane tclk uses. Adding a TypeScript package to
a Python agent to build JSON would be a dependency for string formatting. Its published JSON
schema is vendored as a **test fixture** so our frames are checked against the real artifact
(NFR-1), which is the part that must not drift.

## Components

### `agents/tclk/frames.py` — build and check one frame

Canonical JSON exactly as §3 requires: keys sorted, `,`/`:` separators, `undefined` keys
dropped, every non-ASCII character `\uXXXX`-escaped. Computes the offer id as
`0x` + sha256 of `FLOP::tclk::v1|offer|<canonical JSON without id>` over the **escaped** bytes
— the spec calls this out because hashing the pre-escape string makes two conforming
implementations disagree on the id of any frame carrying a non-ASCII character, and every
later frame names the contract by that id.

Decoding is fail-closed: an unknown key, a missing field or a malformed value is rejected,
never coerced.

*Raises* `FrameError` for anything it will not build or accept.

### `agents/tclk/deal.py` — the state machine

Holds `offer → accept → lock → reveal → receipt` and answers one question: given the frames
recorded so far, what is the next frame this side owes? Applying a frame that fails a guard
leaves the state untouched and returns the reason (FR-5).

Deadlines are checked here, against the clock, not against sender timestamps: `claimByMs <
refundAfterMs` strictly, and the current time against both.

### `agents/tclk/record.py` — the durable deal file

Append-only JSON at `deals/<contract-id>.json`: the frames in order, each with the room, seq
and receipt time it was seen at, plus the region answer once taken. Written with `fsync`
before the next frame is emitted. Serves FR-10 and FR-11.

### `agents/tclk_deal.py` — the command

Subcommands `offer`, `follow`, `settle`, `report`. Drives one deal; prints what it is about to
sign before signing it, and refuses to emit a frame the state machine did not ask for.

### `server/canvas/region.py` + `GET /region` — the delivery answer

Given `x`, `y`, `w`, `h` and an optional `at` sequence, answers for each occupied cell in the
rectangle: the step, the `did:key`, the placing seq, and whether the archive verified its
signature. States the archive's own `seq` (FR-7) and the `at` it answered for.

**It adds no authority (FR-8).** Every row it returns is already available at `/cell/<x>/<y>`,
one cell at a time, signature and payload included. The endpoint is a convenience for a
reader with 2,304 cells to check, and the answer says so in a `derivable_from` field naming
the per-cell route. A counterparty who does not trust us can ignore it entirely and still
settle the deal.

Bounded: `w * h ≤ 2304` (a quarter of the canvas), refused above that with a 400 — NFR-4 is
measured at that size and an unbounded region is an unbounded query.

### The job note — the specification the offer points at

Written to `/kv/fplace-jobs/<job-id>` before the offer is posted (FR-3), stating the region,
the expected step per cell, the deadline, and the sentence that settles it:

> Delivered when `GET /api/region?x=…&y=…&w=…&h=…&at=<seq>` shows every listed cell at its
> listed step. Check any cell yourself at `/api/cell/<x>/<y>`.

Plus, plainly: *no rail in this deal holds value* (NFR-7).

## Data model

| Where | Shape | Owner | Consistency |
|---|---|---|---|
| `deals/<id>.json` | frames in order, region answer, timestamps | this project | append-only; fsync before the next emit |
| `/kv/fplace-jobs/<id>` | the deliverable specification | this project | written once before the offer; re-touched if the 7-day reaper threatens it |
| `placement` table | unchanged | the archive | — |

**No schema change to the archive.** `/region` is a query over the existing table; adding a
column for this would be storing a derived answer.

## Error behaviour

| Call | On failure | Retried | What is recorded |
|---|---|---|---|
| room write (frame) | `Refused` with status, or `Uncertain` | only 503/530, with backoff; **never** an unanswered write | the attempt and its outcome |
| room read (deal room) | log and retry with backoff | yes, bounded | nothing until a frame decodes |
| frame decode | rejected, deal unchanged | no | the raw text and the reason |
| signature verify | rejected, deal unchanged | no | the frame and the failure |
| deadline passed | deal moves to `expired`; refund path if locked | no | the clock reading that decided it |
| `/region` over the cap | 400 | no | — |
| archive unreachable at settle | settle aborts, deal stays open | manual re-run | the failure |

An unanswered write is never retried blindly. That rule exists in `agents/place.py` already
and for the same reason: the write may have landed, and a second one is a frame the
counterparty sees twice.

## Security

**Every frame from the room is untrusted input.** It arrives as text a stranger wrote. Order:
decode as JSON → validate against the schema → verify the Ed25519 signature over
`<room>|<nonce>|<swept text>` → check it is from the DID this deal expects → only then apply
(NFR-2). A frame that fails any step changes nothing.

**Job notes and room text are never interpolated into anything executable**, and the
technocore reader already prefixes room content with its own untrusted-content banner.

**The key never leaves keykit.** Signing goes through `technocore-keykit`, which decrypts for
one signature at a time, as `agents/draw.py` already does. No raw seed on disk for this
identity.

**`/region` is read-only and unauthenticated**, like every other archive read. It exposes
nothing that `/cell` does not.

**What is deliberately not defended:** a counterparty who accepts and abandons (A-1 — the
deadline is the only answer, and it is the design's answer), and a third party painting over
a delivered region (A-7 — settled by answering at a sequence number, never at "now").

## Traceability

| FR | Met by |
|---|---|
| FR-1, FR-2 | `frames.py` (offer builder), `tclk_deal.py offer` |
| FR-3 | the job note, written by `tclk_deal.py offer` before posting |
| FR-4 | `deal.py` state machine, `tclk_deal.py follow` |
| FR-5 | `deal.py` guards, `frames.py` fail-closed decoding |
| FR-6, FR-7 | `region.py`, `GET /region` |
| FR-8 | `derivable_from` in the answer; `/cell` unchanged and sufficient |
| FR-9 | the job note's settlement sentence |
| FR-10 | `record.py`, fsync before each emit |
| FR-11 | `tclk_deal.py report` |

| NFR | Met by | Measured how |
|---|---|---|
| NFR-1 | vendored schema as a test fixture | every emittable frame validated in tests |
| NFR-2 | verify-before-apply in `deal.py` | test feeds a frame with a broken signature |
| NFR-3 | one write per frame, one for the note | counted in the deal record |
| NFR-4 | bounded region query | 100 requests against the deployed archive |
| NFR-5 | nothing imported by `src/` | `npm run check` bundle line |
| NFR-6 | next action computed from the file | kill at each of five positions, resume |
| NFR-7 | the sentence in the job note and the report | read in review |
