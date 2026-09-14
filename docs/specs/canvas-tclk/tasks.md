# Signed Canvas × tclk — tasks

**Traces:** [`design.md`](design.md). **Status:** C-1 to C-5 and C-7 done; C-6 open with a
counterparty, awaiting their reveal. Updated 2026-09-13.

Ordered by risk, not by dependency: the two things most likely to invalidate the plan are
whether our frames are accepted as valid tclk at all, and whether any counterparty will
complete a canvas job. Both are answered before anything is built on top of them.

---

## C-1 · Vendor the tclk schema and prove our frames validate — serves NFR-1

Copy `schema/tclk1-frames.schema.json` from the tclk repository into
`agents/tclk/vendor/` with the commit it came from recorded beside it, and write the canonical
encoder (`frames.py`) against §3: sorted keys, `,`/`:` separators, dropped `undefined`, every
non-ASCII character `\uXXXX`-escaped, and the offer id hashed over the **escaped** bytes.

*Done when:* every frame type the project can emit validates against the vendored schema in a
test, and a test builds the spec's own worked example from §3.1 and reproduces its `id` byte
for byte.
*Depends on:* nothing.
*Estimate:* 3–5 h · basis: the encoder is small; the id rule is the part that usually takes
two attempts, and the spec warns about exactly that.

---

## C-2 · A shortest-possible live deal with ourselves, then delete it — serves FR-4, A-5

Run `offer → accept → lock → reveal → receipt` end to end against the real room using **two
identities we control**, purely to find out what the room and any referee accept. Payment
symbolic, deliverable trivial, deal room `p-` so it is unlisted.

This is explicitly **not** the deal that counts. Self-dealing is not commerce and the
requirements say so. It is a rehearsal, and its output is knowledge: whether our frames are
accepted, whether `tclk-offers` rate-limits us (A-5), and what a real accept looks like on the
wire.

*Done when:* five frames land and decode, and the transcript is saved. The deal is then
abandoned deliberately and the record marked `rehearsal: true` so it can never be presented as
commerce.
*Depends on:* C-1.
*Estimate:* 2–4 h · basis: the signing lane exists; the unknown is what the room rejects.

---

## C-3 · The deal record and the state machine — serves FR-4, FR-5, FR-10, NFR-6

`record.py` (append-only, fsync before each emit) and `deal.py` (guards, deadline checks,
next-frame-owed). The next action is computed **from the file only** — A-3 means re-reading
the room cannot be part of resume, because at four messages a second our frames leave the
readable window in minutes.

*Done when:* a deal driven to each of the five frame positions, killed, and resumed emits the
correct next frame and never re-emits an accepted one — verified for all five positions.
*Depends on:* C-1.
*Estimate:* 5–8 h · basis: five states with guards; the resume tests are most of it.

---

## C-4 · `GET /region` — serves FR-6, FR-7, FR-8, NFR-4

A bounded rectangle query over the existing `placement` table, answering step, `did`, seq and
witnessed per occupied cell, plus the archive's own seq and the `at` it answered for. Refuses
`w * h > 2304` with a 400. Carries `derivable_from` naming `/cell/<x>/<y>`.

*Done when:* the answer for a seeded region matches what `/cell` reports for every cell in it —
asserted cell by cell, not spot-checked — an out-of-range region is refused, and p95 over 100
requests against the deployed archive is under 200 ms.
*Depends on:* nothing.
*Estimate:* 3–4 h · basis: `/leaders` and `/activity` are the same shape of work.

---

## C-5 · The job note and its settlement sentence — serves FR-3, FR-9, NFR-7

Write `/kv/fplace-jobs/<job-id>` before any offer: region, expected step per cell, deadline,
the sentence that settles it, and the statement that no rail here holds value.

*Done when:* the note resolves at the moment the offer is posted, and a reader following only
the note can decide delivered-or-not without asking us anything.
*Depends on:* C-4 — the sentence names the endpoint, so the endpoint must exist first.
*Estimate:* 1–2 h.

---

## C-6 · One real deal with a real counterparty — serves the whole point

Post the offer. Accept the first valid accept from a DID that is not ours. Lock, wait, settle
against `/region` at the deadline sequence, emit the receipt.

**This is the task that can fail for reasons no code fixes.** A-1: one lock per twenty offers
was observed, so the likeliest outcome is an accept followed by silence. The deadline is the
design's whole answer to that, and a stalled deal is a real result to report — not a bug.

*Done when:* either five frames complete with a counterparty DID that is not ours, or the deal
expires and the refund path runs and both are recorded. Both are acceptable completions of the
task; only one is commerce.
*Depends on:* C-2, C-3, C-5.
*Estimate:* 1–3 days wall-clock, of which maybe 2 h is work · basis: the rest is waiting on
somebody else, and A-1 says the wait may not end.

---

## C-7 · The transcript document — serves FR-11

One document per completed deal: every frame in order, the region answer, the sequence it was
taken at, and what each party did. Generated, not written by hand.

*Done when:* the document for the C-6 deal is produced and a reader with no context can follow
it from offer to settlement, and check any claim in it against the room and the archive.
*Depends on:* C-6.
*Estimate:* 2–3 h.

---

## Sequencing note

C-1 and C-4 are independent and both cheap; either can go first. C-2 comes early on purpose —
it is the only task that answers "will the room even take our frames", and finding that out
after building the state machine would be finding it out late.

**Total: roughly 3–5 working days of work**, plus the wall-clock wait in C-6 that is not work
and may not resolve. If C-2 reveals that `tclk-offers` filters on `job.proto` (A-2), add a day
and revisit FR-2 — the deliverable would then have to present as a recognised protocol rather
than as its own shape.


---

# What happened

**C-1 ✅** The canonical encoder and the contract id. The test that mattered was not ours:
twenty-one real offers captured from the live room reproduce their own ids under our code.
Vendoring the schema instead of working from the prose caught `ref` being two different fields
sharing a name — a hex32 naming the offer in `accept`, a free rail reference everywhere else —
and killed a guard in `encode` that could never fire.

**C-2 ✅** Five frames, two identities we control, a `p-` room. All five landed, decoded and
matched byte for byte. Marked `rehearsal: true` in its own first field. It answered what the
room accepts; it could not answer whether our model of the protocol was right, because both
sides held the same model.

**C-3 ✅** The state machine as a pure function over the record, so resume is the normal path
rather than a second one. Killed at each of the five positions, a fresh read emits the correct
next frame. Five guards mutation-tested. Two design bugs surfaced: an open offer has no
counterparty, so `owes` answered no to everyone and made the state unreachable; and the
record's directory fsync raised on Windows.

**C-4 ✅** `/region`, answering as of a sequence rather than as of now, because the canvas is
world-writable. Mutation testing found the gap that mattered — swapping `MAX(seq)` for
`MIN(seq)` left the suite green, because no cell in the sampled rectangle had ever been
overpainted. There is a contested cell in it now. NFR-4 was corrected rather than quietly
passed: its 200 ms end-to-end target was unreachable by any route here, `/health` included.

**C-5 ✅** The job note lists all one hundred cells and both settlement routes, and says no
rail holds value. 1,535 characters against an 8,192 limit.

**C-6 — open.** The offer went to `/r/tclk-offers` at seq 3,924,698. **Ten agents accepted
within twenty-four seconds**, the first one second after it landed, which makes A-1's
pessimism wrong on the accept side. One of the ten conformed to the published schema.

That accept exposed the real bug, and it is the one the rehearsal could not: **the contract id
is not the offer id.** It is derived at accept time from the offer and the acceptance
together, and every frame afterwards names it. Confirmed by recomputing 1,528 of 1,835
conforming accepts in the room. Our lock now names the right contract, and the deal stands at
`locked` — the counterparty has gone quiet, which is the outcome A-1 named as likeliest and
which the task defines as an acceptable completion. Refund time is 18 hours after the offer.

**C-6 closed 2026-09-14 as `settled`, by refund.** The claim window passed with no reveal, so
the payer took its escrow back and said so: `offer → accept → lock → refund → receipt`, five
frames, a real counterparty, `outcome: "refunded"`. That is the second of the two endings the
task allows, and the honest one for a deal nobody delivered.

*Finishing it exposed two more bugs.* The refund path was specified and never written — the
state machine recognised expiry and had no frame to close it with, so `EXPIRED` was terminal
and the deal would have sat there. And `rebuild` replayed history against **now**: an accept
that was perfectly valid when sent got refused hours later because the offer had since
expired, and every frame after it was then out of turn, so a deal that ran correctly rebuilt
as one that never started. Frames are now judged against their own `seen_at`.

*The silence is measured, not assumed.* Twenty-five minutes of following the room after the
lock read **8,274 messages, none of which named this contract**, and the commission region is
untouched at 0 of 100 cells. So the counterparty accepted within one second of the offer and
has done nothing since — which is the shape the funnel measurement predicted: accepting is
free and instant, revealing is neither.

**C-7 ✅** The transcript generator, run against the live deal.

## What the room measured like, 2026-09-13

| | |
|---|---|
| `tclk-offers` last seq | 3,901,402 → 3,931,000+ in one afternoon |
| accepts sampled | 8,467 |
| …validating against tclk's own schema | 1,854 (22%) |
| …omitting the required `contract` field | 6,589 (78%) |
| conforming accepts whose contract id reproduces | 1,528 of 1,835 (83%) |

Three quarters of the accept traffic does not satisfy the protocol's published schema. That is
the context for the word **true** in "true agentic commerce", and it is the gap this work was
built to sit in.
