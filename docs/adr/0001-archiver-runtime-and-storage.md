# 0001. Archiver runtime and storage

- Status: accepted
- Date: 2026-08-28
- Serves: the first open decision in `docs/specs/signed-canvas/design.md`

## Context and problem

The `archiver` reads the canvas room continuously, discards anything whose signature does not
verify, stores the rest with its signature, and serves `GET /snapshot` and `GET /since/<seq>`.
It must run beside the existing `flop-agent` without disturbing it, and it must lose no
accepted write (RPO = 0).

### Workload profile

| | |
|---|---|
| Ingest | poll one room. Read cap **200 messages**, 37.7 KiB JSON, median 717 ms (measured, T-2). One connection, I/O-bound. |
| Verify | Ed25519 per new message; at most 200 per poll. Verification is tens of microseconds. Not a bottleneck at any plausible rate. |
| Store | append-only. A placement is ~250 bytes with its signature; 1M placements ≈ 250 MB against **27 GB free**. |
| Serve | `/snapshot` is **2,048 bytes**; `/since/<seq>` is smaller. Read-heavy, tiny payloads, and highly cacheable at the Cloudflare edge that now sits in front of it. |
| Concurrency | tens of concurrent readers at most. I/O-bound throughout. |
| Durability | **RPO = 0** for accepted writes. |
| Deployment | Cloudflare Tunnel, **no open ports** (decided 2026-08-28). systemd on a 2 vCPU / 3.8 GB box already running `flop-agent`, `alertbot` and `kartel-ca-watcher` (~280 MB resident between them). |
| Team | one person, working in Python. `flop-agent` is Python 3.12 and works. |
| Lifetime | through testnet Q4 2026 into mainnet Q1 2027 — months, not a weekend. |

### Measured facts about the host

Ubuntu 24.04.3 · Python **3.12.3** and `cryptography` **41.0.7** installed and already used by
`flop-agent` · SQLite **3.45.1** · **no Node, no npm, no nginx, no Docker** · only port 22
reachable · 27 GB free of 38 GB.

## Decision drivers

Weights were fixed before any candidate was scored.

| Criterion | Weight | Why it carries that weight |
|---|---|---|
| Safe coexistence on the same box | 5 | 2 vCPU and three live projects. Breaking `flop-agent` costs the airdrop record, which is the reason this server is involved at all. |
| Durability (RPO = 0) | 5 | The design's promise. An accepted signed write that vanishes makes the archive worthless as memory. |
| Maintenance load and team fit | 4 | One person, six-plus months, alongside other work. |
| Verifier consistency | 4 | The sweep and canonical string must agree byte-for-byte with the server. Every extra implementation is another place to diverge. |
| Install and operating cost | 3 | A new runtime is a new update and CVE surface on a box that carries unrelated work. |
| Performance fit | 2 | The load is low and I/O-bound. No candidate is stressed; this criterion barely discriminates and its weight says so. |

## Options considered

- **A · Python 3.12 + stdlib `ThreadingHTTPServer` + SQLite (WAL)** — the runtime, the crypto
  library and the database are already on the box. No new packages.
- **B · Node 22 + Hono + `better-sqlite3` + `@noble/ed25519`** — one verifier implementation
  shared with the browser client.
- **C · Go, single static binary + `modernc.org/sqlite`** — no runtime to install, smallest
  resident footprint.

## Scoring

| Criterion | W | A · Python | B · Node | C · Go |
|---|---|---|---|---|
| Coexistence | 5 | **5** | 3 | **5** |
| Durability | 5 | **5** | **5** | **5** |
| Maintenance / team fit | 4 | **5** | 3 | 2 |
| Verifier consistency | 4 | 4 | **5** | 2 |
| Install / operating cost | 3 | **5** | 2 | 4 |
| Performance fit | 2 | 3 | 4 | **5** |
| **Total** | | **107** | 86 | 88 |

**A · Coexistence 5** — nothing is installed. Same interpreter, same library versions as
`flop-agent`, ~40 MB resident.
**A · Maintenance 5** — one language for the whole server side, one deployment shape
(systemd unit + timer), already proven on this box twice.
**A · Verifier consistency 4, not 3** — the two-implementation cost is *already paid and
already tested*: `technocore-keykit` is the JS verifier and passes the `#318` fixture (48
checks), and `agent.py` is the Python one, cross-checked against `sign.py` in
`test/cross-check.sh` (8 vectors). This is a port of tested code, not a new risk.
**A · Performance 3** — `ThreadingHTTPServer` is modest and the GIL is real, but the work is
I/O-bound, the payload is 2 KB, and Cloudflare caches in front. Sufficient, not elegant.

**B · Coexistence 3** — installs a runtime and an npm tree; `better-sqlite3` is a native
module, so a compiler toolchain comes with it. It does not touch `flop-agent`, but it adds
weight to a small box.
**B · Verifier consistency 5** — the genuine and only win: the same `@noble/ed25519` and the
same sweep code as the browser, one implementation. Given that both implementations already
exist and pass the fixtures, this buys less than it would on a greenfield project.
**B · Install 2** — Node plus a native build chain, on a host that has neither.

**C · Coexistence 5** — one static file, ~15 MB resident, no runtime.
**C · Maintenance 2** — a third language nobody here maintains; every change needs a build
environment that does not exist yet.
**C · Verifier consistency 2** — a third verifier implementation, untested against the
fixtures, for no gain.
**C · Performance 5** — the best of the three, against the criterion that matters least.

A wins by 22% over its nearest rival, so the tie-break rule does not apply.

## Storage sub-decision

| Criterion | W | SQLite (WAL) | Append-only JSONL | PostgreSQL |
|---|---|---|---|---|
| RPO = 0 | 5 | **5** — `synchronous=FULL`, atomic commit | 4 — needs explicit `fsync` per line | **5** |
| Range query for `/since/<seq>` | 4 | **5** — indexed | 2 — linear scan | **5** |
| Start-up cost | 3 | **5** — O(1) | 2 — O(n) replay of the whole log | **5** |
| Operating cost on this box | 4 | **5** — a file, already present | **5** | 1 — another daemon and its memory |
| Backup | 3 | **5** — `VACUUM INTO` while running | **5** — copy the file | 3 — `pg_dump` and a schedule |
| **Total** | | **95** | 71 | 80 |

**SQLite with WAL and `synchronous=FULL`.** The archive is one writer and a few readers, which
is the shape SQLite is best at. RPO = 0 comes from the commit, not from discipline.

## Decision

**A, with SQLite.** Python 3.12 + `cryptography` + stdlib `ThreadingHTTPServer` + SQLite in
WAL mode, as a systemd service behind Cloudflare Tunnel, in `/root/flop/canvas/` — a
directory of its own, sharing no code and no state with `flop-agent`.

Rationale: every criterion that carries weight 4 or 5 either favours Python outright or is a
tie, and the one criterion Node wins — a single verifier implementation — is worth less here
than anywhere else, because both implementations already exist and are already cross-checked
against the published conformance fixtures. Choosing Node would install a runtime, an npm
tree and a native compiler chain onto a 2-vCPU box that carries three unrelated projects, in
exchange for deleting a risk that has already been retired by tests. Go would buy performance
that the measured load does not need, at the cost of a third language and a third verifier.

### Consequences

**Good**
- Nothing new is installed except `cloudflared`, which the deployment decision requires anyway.
- The archiver deploys and is debugged exactly like `flop-agent`: one file, one systemd unit,
  `journalctl -u`.
- Backup is a file copy; restore is a file copy.
- If it dies, the room is still the record. The archiver is memory, not truth.

**Bad, and accepted**
- Two verifier implementations stay in the codebase forever. Mitigated, not removed: both run
  the same `#318` fixture, and that fixture runs in CI. If they ever disagree, CI says so
  before a user does.
- `ThreadingHTTPServer` will not survive real load. Accepted because Cloudflare caches
  `/snapshot` at the edge and the payload is 2 KB. If it ever becomes the bottleneck, moving
  to an ASGI server is a contained change behind the same routes.
- One more process on a small box. ~40 MB against 3.1 GB available.

### Over-engineering checks

- **Message queue** — not added. The ingest loop is a function call; there is no fan-out, no
  back-pressure requirement and no second consumer.
- **Cache** — not added by us. Cloudflare is already in the request path as a consequence of
  the tunnel; adding a second cache layer would buy a consistency problem we have not measured.
- **Service split** — not made. Ingest and serve share one process and one SQLite file. There
  is no independent scaling need and no team boundary.

### Validation

This decision is wrong if any of these is observed, and each has a threshold:

- **Resident memory** of the archiver exceeds **300 MB**, or the box's available memory drops
  below **1 GB** → the runtime choice was too heavy for the host.
- **`/snapshot` p95 at origin** exceeds **250 ms** with the edge cache bypassed → the stdlib
  server was the wrong call and an ASGI server is due.
- **Any disagreement** between the Python and JS verifiers on the `#318` fixture → the
  two-implementation risk materialised; collapse to one implementation.
- **Ingest lag** — newest room `seq` minus archived `seq` — stays above **500** for more than
  five minutes → the loop is not keeping up, and history may be trimmed before it is archived.

### Correction to the lag threshold, 2026-08-29

This bullet originally set the threshold at 200 and called falling 200 behind *"not slow, it
is data loss"*. **That was wrong**, and wrong in the direction that matters: it would have
fired constantly and then been switched off.

`?since=<seq>` pages **forward**. A reader 1,000 messages behind catches up in five requests.
The 200 cap bounds a batch, not what is reachable. The T-2 finding it was derived from — "no
backward paging" — is about reaching messages *older* than the newest 200, a different
operation from following a room forward; conflating the two produced a wrong number.

The real loss condition is the room trimming a message before the archiver reads it, and
**the retention bound is not published**: `/config` exposes no ring, trim or history knob. So
500 is a conservative guess, chosen to make a stalled loop visible long before it could
plausibly cost history, and `ingest.py` labels it as a guess rather than a derived bound. If
retention is ever published, re-derive this number from it.

### A second correction, same day: the archive cannot hold signatures

This ADR assumed the archiver would store "every signed message with its signature". It
cannot. Measured against the live service: the room read returns `seq, ts, from, text, nonce`
and **never the signature** — in every format, with every parameter tried; there is no
single-message route; `/openapi.json` declares no schemas; `/config` has no knob for it.

That does not change the runtime or the storage engine — it changes what the schema holds,
which is recorded in `design.md` and in `server/canvas/archive.py`. If anything it reinforces
the storage choice: the service reports **`fsync: false`**, so a room append is not flushed
before its 200, and this archive is the only place a placement is durable at all.

### A third correction, 2026-09-01: the service now serves signatures

The correction above was true when it was made and is no longer true. technocore.chat
**0.11.0**, released 2026-08-31, began serving `sig` on room reads; the deployment now runs
0.11.2. This was not a mistake in the earlier measurement — it was the dependency changing
under it, which is the failure mode a dated finding exists to survive.

Re-measured here on 2026-09-01, against the live service:

| | then (0.10.0) | now (0.11.2) |
|---|---|---|
| `?format=json` record | `seq, ts, from, text` | `+ nonce, sig` |
| `?since=<seq>` — the path `ingest.py` reads | no signature | signature present |
| whole-room dump | none | `GET /r/<room>/export`, raw JSONL, byte-for-byte |
| retention | ~128 KiB floor per room | ~10 MiB ring, 64 KiB guaranteed floor |

Not taken on the manual's word. 200 consecutive `lobby` records were verified here against
`<room>|<nonce>|<swept text>`: **200 verified, 0 failed**, which also confirms this project's
sweep and canonical-string implementation against 200 messages nobody here wrote. One of our
own placements was then signed offline, written, and read back: the returned `sig` was
byte-identical to the one signed locally and re-verified from the room read alone.

**What changed in this ADR's decision: nothing.** The runtime, the storage engine and the
durability argument all stand, and `fsync: false` upstream still makes this archive the only
place a placement is durable.

**What changed in the schema: the ratio, not the meaning.** `apply_batch` now reads `sig` off
each message and verifies it here before storing it, so a placement written straight to the
room by a stranger is witnessed with nothing handed to us. The field is verified rather than
believed: the room is world-writable and `sig` arrives with the rest of it, so a signature
that does not check out against *this* message's rebuilt payload leaves the row attested.

Two consequences worth naming, because neither is cosmetic:

- **The two columns stay.** Every record written before 0.11.0 has no signature and can never
  gain one. Those rows are permanently attested, and the service's own manual now says the
  same thing this schema said first: treat a missing `sig` as "not re-verifiable", never as
  "invalid". On `fplace` that is 7 of 14 messages, including the one third-party placement.
- **`ingest.py --backfill` exists because `?since=` only pages forward.** The cursor was
  already past every pre-0.11.0 row, so those rows could never pick up a signature during
  normal operation even once one existed upstream. The backfill re-reads from the room's
  start; `apply_batch` fills a missing signature and never replaces one, so it is safe to
  run at any time and safe to interrupt.

**The retention floor moved the wrong way** (128 KiB → 64 KiB guaranteed) while the ceiling
moved up (~10 MiB). `LAG_ALERT = 500` was chosen when no bound was published at all; a ring
is now documented, so that number is re-derivable and should be revisited rather than left as
the guess it is currently labelled.

**A new operational bound this ADR did not have:** rooms with no write for 7 days are
deleted. The ingest loop only reads, so following a room does not keep it alive. `fplace` was
3 days into that window when this was found.
