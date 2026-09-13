# Signed Canvas × tclk — requirements

**Status:** draft, awaiting approval. Nothing here is implemented.
**Date:** 2026-09-13

## Why this exists

Flop Labs shipped [`tclk/1`](https://github.com/flop-labs/tclk), a protocol for two agents who
meet in a technocore.chat room to strike a deal neither can afford to go first on. Arthur
Hayes then said, publicly: *"We will reward true agentic commerce using this feature with
airdrop FLOP tokens."*

The word doing the work in that sentence is **true**, and the measurements below say why.

### What the market actually looks like, measured 2026-09-13

`/r/tclk-offers` is a firehose: `last_seq` **3,901,402**, and the 200 messages one read
returns span **49 seconds** — roughly four messages a second. In that 49-second window:

| frame | count |
|---|---|
| `accept` | 166 |
| `offer` | 20 |
| `receipt` | 3 |
| `reveal` | 3 |
| `lock` | 1 |

Two things follow. First, **about eight agents race each offer**, so winning an accept is a
latency contest a hand-paced participant loses. Second, the funnel past `lock` is almost
empty: one lock and three reveals against twenty offers.

And the jobs themselves are thin. A sampled job note reads:

```
deliverable: Analyse a recent tclk-offers frame for protocol compliance
acceptance: machine-verifiable where possible
source: flop_auto_offer_v11_2
```

An auto-generated offer whose deliverable is analysing the very frames it is made of. A second
sampled offer pointed at a job note that returned **404** — contracted work with no
specification behind it.

So the room is mostly machines transacting with machines over nothing. That is not a criticism
of the protocol and it is not against the rules — the AMA said plainly that farming and real
use will not be separated. It is an observation about **where the empty space is**: a deal
whose deliverable is real, specified, and checkable by a stranger is rare here.

Signed Canvas can produce exactly that deliverable. Every pixel is an Ed25519 signature over
`px <x>,<y> <step> <token>`, timestamped by the room, kept durably in the archive, and
readable by anyone at `/cell/<x>/<y>`. "Cells (20,10) to (39,29) hold this picture, placed by
this key, before this deadline" is a claim a third party can settle without asking us.

### What this cannot be, stated up front

**HTLC does not bind payment to delivery.** It binds payment to revealing a secret. In tclk
the *payee* mints the preimage, so a dishonest payee can reveal and claim without doing the
work. Constructions that hide the preimage in the deliverable were considered and rejected:
the wire format's token field is six base36 characters (~31 bits), brute-forceable as a hash
preimage, and spreading a 256-bit secret across nine pixels changes nothing because the payee
already holds it.

What tclk gives a work-for-pay deal is **a deadline-bounded escrow and a public transcript**.
That is worth having and it is not delivery insurance. Any wording that implies otherwise is a
defect in this document.

**No rail holds value.** tclk's own README says *"Alpha. No rail holds value yet"*; the
reference `PaperRail` records and holds nothing. Every amount in this work is symbolic.

---

## Functional requirements

### The deal

**FR-1** — The project can publish a `tclk1 offer` frame to `/r/tclk-offers`, signed by its
registered `did:key`, taking the `payer` role.

**FR-2** — An offer published by the project names its deliverable as a canvas region: an
origin cell, a width and a height, and the exact palette step expected in each cell of that
region.

**FR-3** — An offer published by the project carries a `job.context` URL that resolves to a
readable specification of the deliverable at the moment the offer is posted.

**FR-4** — The project can process the full frame sequence for one deal it opened:
`offer → accept → lock → reveal → receipt`, emitting each frame it is responsible for and
recording each frame it receives.

**FR-5** — The project refuses to advance a deal when a received frame fails schema validation,
signature verification, or a deadline check, and records the reason.

### The proof

**FR-6** — The archive answers, for a named rectangular region and a sequence number, which
cells hold which palette step, which `did:key` placed each one, and whether each rests on a
signature verified by the archive.

**FR-7** — The region answer states the archive's own sequence at the time of answering, so a
reader can tell whether the archive had caught up with the room.

**FR-8** — The region answer is derivable by a third party from `/cell/<x>/<y>` alone, without
trusting the region endpoint — the endpoint is a convenience, never a new authority.

**FR-9** — A deliverable specification published under FR-3 states the region, the expected
steps, and the deadline in a form a reader can check against FR-6 without further instruction.

### The record

**FR-10** — Every frame the project emits or receives for a deal is written to a local file
before the next frame is emitted.

**FR-11** — The project can produce, for a completed deal, a single document containing every
frame in order, the region answer at the deadline, and the archive sequence it was taken at.

---

## Non-functional requirements

**NFR-1 · Frame correctness.** 100% of frames emitted by the project decode without error
under `schema/tclk1-frames.schema.json` from the tclk repository, verified by a test that runs
the schema against every frame the project can emit. Target: 0 failures.

**NFR-2 · Signature verification.** 100% of received frames have their Ed25519 signature
verified against `<room>|<nonce>|<swept text>` before the frame changes any state. Target: 0
frames acted on unverified.

**NFR-3 · Write budget.** One complete deal costs at most **12 room writes** by the project.
Basis: five frames the payer emits, plus one job-note write, plus headroom for one retry each.
technocore.chat's limit is 300 writes/minute per client IP, so one deal must never be able to
consume a meaningful share of it.

**NFR-4 · Region answer latency.** `/region` responds in under **200 ms at p95** for a region
of up to 2,304 cells (a quarter of the canvas), measured on the deployed archive over 100
requests. Basis: `/leaders` and `/activity` already run comparable aggregate queries against
the same 515-row table well inside this.

**NFR-5 · No new client weight.** The browser bundle grows by **0 bytes** for this work. Basis:
this is agent-side and archive-side; any interface for it is a later, separately budgeted
task, and the current budget is 60 KB against 56.0 KB used.

**NFR-6 · Deal recoverability.** After a process kill at any point in a deal, the project can
resume from its local record and emit the next correct frame without re-emitting a frame
already accepted. Target: verified for all five frame positions.

**NFR-7 · Honesty of claims.** Every public artefact produced by this work that mentions
payment states that no rail holds value. Target: checked in review of each artefact; 0
artefacts implying settled value.

---

## Out of scope

- **A commission board in the browser.** No UI work. The interface that would let a visitor
  post a job is a separate piece with its own budget; this work is the agent and archive
  machinery underneath it.
- **Winning accept races.** The project does not compete to accept other agents' offers. At
  roughly eight accepts per offer, that is a latency contest, and losing it repeatedly would
  produce noise rather than commerce.
- **Implementing a settlement rail that holds value.** Out of the question while the reference
  rail holds none and the point-lock crypto is unaudited.
- **Point locks.** `lock: "point"` uses what tclk calls *"unaudited reference crypto:
  full-Schnorr with random nonces, not BIP-340 x-only"*. Hash locks only.
- **Depending on the `@flop-labs/tclk` npm package at runtime.** Its schema is used as a test
  fixture; the frames are built and checked by this project's own code, which already owns an
  Ed25519 signing lane.
- **Transferring canvas cells as an asset.** A cell belongs to whoever painted it last and
  cannot be handed over; modelling it as transferable property would be a fiction.
- **Automated deal-making at market pace.** One deal, driven deliberately, with a real
  counterparty.

---

## Assumptions and dependencies

Each of these is unverified unless marked, and each would change the design if wrong.

**A-1 · A real counterparty will accept.** *Unverified.* The measurement shows eager accepters,
but not that any of them will complete a canvas job rather than abandon it after `accept`.
Given 1 lock per 20 offers observed, **the most likely failure of this whole plan is a deal
that stalls after accept**. Mitigation belongs in the design: the deadline must make a stall
cheap.

**A-2 · Offers with an unusual `job` shape are not filtered out.** *Unverified.* Observed jobs
use `proto: "a2a"` and `proto: "kibble"`. The spec permits other values. If accepters filter on
`proto`, a canvas job may be ignored, and the offer would need to present as one of the
recognised protocols.

**A-3 · The room keeps our frames long enough to matter.** *Partly verified.* The room is a
ring and reaps after 7 idle days; at four messages a second, frames leave the readable window
in minutes. This is why FR-10 exists — **the local record is the record**, and the room is
coordination. The tclk spec says the same thing.

**A-4 · `paper` is an acceptable rail to name.** *Verified by observation:* every sampled offer
named `rails: ["paper"]`, some adding `flop-htlc`.

**A-5 · Our identity is not rate-limited or blocked in that room.** *Unverified.* We have never
written to `tclk-offers`.

**A-6 · The archive stays ahead of the deadline.** *Verified today:* ingest lag was 0 and a
placement reached the archive within 25 seconds of landing in the room. A region answer taken
at a deadline is only as good as the archive's cursor, which is why FR-7 exists.

**A-7 · The canvas region is not overwritten between delivery and settlement.** *Unverified and
unpreventable.* The canvas is world-writable by design. A third party can paint over a
delivered region before the payer checks it. The design must settle on a sequence number, not
on "now".

---

## Validation checklist

- [x] **Validity** — every FR is a behaviour, not an implementation. FR-6 says what the answer
      contains, not how it is computed; FR-8 deliberately constrains it to add no authority.
- [x] **Consistency** — checked. NFR-5 (no bundle growth) and the out-of-scope UI agree.
      FR-8 and FR-6 are in tension by design: the endpoint must be useful and must not become
      a source of truth, which FR-8 resolves by requiring derivability from `/cell`.
- [x] **Completeness** — covers the deal, the proof and the record. It does **not** cover
      attracting counterparties, which A-1 flags as the main risk and which no requirement
      here can fix.
- [x] **Realism** — the signing lane, the batch painter and the archive API all exist. The new
      work is frame handling, one endpoint and a record file.
- [x] **Verifiability** — each FR has a test shape: FR-1 to FR-5 against a local stub
      counterparty, FR-6 to FR-8 against a seeded archive, FR-10 and FR-11 by killing the
      process mid-deal.

**One tension worth naming rather than resolving quietly:** NFR-6 (resume without re-emitting)
and A-3 (frames leave the readable window in minutes) pull against each other. Resuming by
re-reading the room will not work at this room's pace; resume must be driven by the local
record alone. The design must say so.

---

## Open questions for the user

1. **Payer or payee?** This document assumes payer — we post the job, the swarm competes to
   take it. The alternative is to be the payee and win an accept race, which "Out of scope"
   rejects on latency grounds. Confirm.
2. **What should the first deliverable be?** A small drawing at a named region is the obvious
   candidate. Its content is a choice, not a requirement.
3. **Symbolic amount.** Observed offers ranged from 1 to 200 FLOP and 20 PAPER on a rail that
   holds nothing. Any number is as real as any other; naming one that looks considered rather
   than arbitrary is the only consideration.
