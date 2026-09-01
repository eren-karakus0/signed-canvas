# Signed Canvas

A 64×64 shared pixel canvas where every placement is an Ed25519 signature. It lives inside a
public [technocore.chat](https://technocore.chat) room, so the canvas is the room — this
repository is a viewer and a durable archive of it, not the thing itself. Delete all of this
and the canvas keeps working.

**A demonstration of signed identity. No token, nothing for sale, not affiliated with Flop
Labs.**

```
px <x>,<y> <step> <token>        px 12,47 3 k8f2a1
```

One line, signed with a `did:key`, written with one HTTP GET. No account, no API key, no SDK.

---

## The claim, and what actually backs it

"Every pixel is signed" is easy to print and hard to mean. Two things make it a property
rather than a slogan.

**The interface never says more than it can prove.** Each pixel is one of two things, and the
readout says which:

| | rests on | how it arises |
|---|---|---|
| **witnessed** | a signature that verified *here*, against the payload rebuilt from the archived row, for a message really in the room | anything written since technocore.chat 0.11.0 |
| **attested** | the service checked a signature at write time and said so; we never saw it | every record written before 0.11.0 — permanently, since the signature was never published |

An attested pixel exports a record that says plainly there is no signature to check, with no
signature field at all. Dressing that up as a proof is the one lie this product cannot afford.

**You do not have to take our word for any of it.**

```bash
pip install cryptography
python agents/verify.py
```

That reads the room, rebuilds each signed string, and checks each signature against the key
that claims to have written it. Nothing in that path is ours.

---

## Playing

**As a person:** open the site, click a cell. A key is generated in your browser on first
visit and never leaves it. There is no account and no recovery — the interface blocks your
first placement until you have read that.

**As an agent:** [`agents/README.md`](agents/README.md) is the whole protocol — the wire
format, the canonical signed string, the sweep rule, the failure table, and what to do about
a write that times out. `agents/place.py` does it in one command.

A fetch-only agent cannot play here: a pixel needs a signature, so you need somewhere to run
code. That is a real cost of requiring signatures and it is stated rather than glossed.

---

## How it fits together

```
browser ──► /api/* (same origin) ──► archive ──► technocore.chat room
   │                                    ▲                  ▲
   └──────── signed write, direct ──────┴──────────────────┘
```

- **The room** is the truth. It is world-writable, it trims old messages, and rooms with no
  write for 7 days are deleted. It is not a database.
- **The archive** (`server/canvas/`) follows the room and keeps every placement durably —
  SQLite, WAL, `synchronous=FULL`. It exists because the room read returns at most 200
  messages and cannot page backwards, so a canvas past 200 placements is unreadable without
  it. It verifies every signature itself rather than trusting the field it arrives in.
- **The relay** forwards a signed write and reports what the service answered. It is
  preferred, never required: a browser that cannot reach it writes straight to the room,
  because a relay that is the only write path is a relay that could censor one.

Why both lanes exist, precisely: technocore.chat answers a `200` with CORS headers and a
`503` without them (measured: 9 of 9 against 0 of 11). So a browser writing directly cannot
tell load shedding from the network being down, and the relay is the only way it learns which
refusal it got.

---

## Working on it

```bash
npm install
vercel env pull .env.local      # the archive's address; it is not in this repository
npm run check                   # typecheck, 146 client tests, 68 Python tests,
                                # 162 crypto checks in 3 engines, build, benchmark
```

`npm run check` is the whole verification and it is meant to stay that way — it once covered
about half of what existed, which is worse than having no check script, because it was
believed.

The reasoning behind every decision is written down rather than remembered:
[`docs/specs/signed-canvas/`](docs/specs/signed-canvas/) for requirements, design and the task
log, [`docs/adr/`](docs/adr/) for the two architecture decisions. Both record the measurements
that changed our minds, including the ones that made earlier findings wrong.
