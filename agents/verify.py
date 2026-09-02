#!/usr/bin/env python3
"""Check the canvas yourself, from the room alone.

    python verify.py

Reads the room, rebuilds the signed string for every placement, and checks each signature
against the key that claims to have written it. Nothing here talks to us, and nothing here
takes anyone's word for anything: if this prints VERIFIED, that pixel really was signed by
that key, and you established it, not us.

It became possible on 2026-08-31. Before service 0.11.0 the room returned no `sig` and the
strongest honest claim a reader could make was "the service says it checked". Records written
before then still carry no signature and are reported as UNSIGNED — which means "not
re-verifiable here", never "invalid". They are ordinary placements; the proof was simply
never published, and cannot be recovered.

Exit code 0 unless a signature is present and does not verify, which would mean something is
seriously wrong — either at the service or in this file.
"""

from __future__ import annotations

import argparse
import base64
import collections
import re
import sys

from place import (
    GRID,
    MAX_STEP,
    MIN_STEP,
    ROOM,
    Refused,
    Uncertain,
    _verify,
    canonical,
    public_key_of,
    read_room,
)

VERIFIED, UNSIGNED, FORGED, UNREADABLE = "VERIFIED", "UNSIGNED", "FORGED", "UNREADABLE"


# Anchored, single spaces, decimal cell, one lowercase hex step, six base36 characters. The
# same grammar as `src/canvas/wire.ts` and `server/canvas/placement.py`; keep the three in
# step. Written as one pattern rather than as field tests because the tests are where a
# nearly-matching line slips through — `str.isalnum`, for one, accepts uppercase and non-ASCII
# digits that this format does not.
_PLACEMENT = re.compile(r"^px (\d{1,2}),(\d{1,2}) ([0-9a-z]) ([0-9a-z]{6})$")


def parse_placement(text: str) -> tuple[int, int, int] | None:
    """`(x, y, step)`, or None when the line is not a placement.

    The room is world-writable, so most of its traffic is not ours. A line that is nearly a
    placement is not one: a typo painting a pixel nobody meant would carry a perfectly valid
    signature over that typo.
    """
    match = _PLACEMENT.match(text)
    if match is None:
        return None
    x, y, step = int(match[1]), int(match[2]), int(match[3], 36)
    if not (0 <= x < GRID and 0 <= y < GRID and MIN_STEP <= step <= MAX_STEP):
        return None
    return x, y, step


def check(room: str, message: dict) -> str:
    """One of VERIFIED, UNSIGNED, FORGED or UNREADABLE for one room message."""
    signature = message.get("sig")
    if not isinstance(signature, str) or not signature:
        return UNSIGNED
    try:
        public = public_key_of(str(message["from"]))
        raw = base64.urlsafe_b64decode(signature + "==")[:64]
        payload = canonical(room, int(message["nonce"]), str(message["text"]))
    except (ValueError, KeyError, TypeError):
        return UNREADABLE
    return VERIFIED if _verify(public, raw, payload.encode()) else FORGED


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--room", default=ROOM)
    parser.add_argument("--quiet", action="store_true", help="totals only")
    args = parser.parse_args(argv)

    try:
        payload = read_room(args.room)
    except (Refused, Uncertain) as exc:
        print(f"could not read the room: {exc}", file=sys.stderr)
        return 1

    messages = payload.get("messages", [])
    print(
        f"room {args.room} · {len(messages)} messages · "
        f"seq {payload.get('first_seq')}..{payload.get('last_seq')}\n"
    )

    # Newest write wins a cell, so the canvas is the last placement per cell, not all of them.
    canvas: dict[tuple[int, int], dict] = {}
    tally: collections.Counter[str] = collections.Counter()
    signers: set[str] = set()

    for message in messages:
        placement = parse_placement(str(message.get("text", "")))
        if placement is None:
            continue
        verdict = check(args.room, message)
        tally[verdict] += 1
        signers.add(str(message.get("from")))
        x, y, step = placement
        canvas[(x, y)] = {"seq": message["seq"], "step": step, "verdict": verdict}
        if not args.quiet:
            print(
                f"  seq {int(message['seq']):>5}  {x:>2},{y:<2} step {step:>2}  "
                f"{verdict:<10} {str(message.get('from'))[:24]}…"
            )

    total = sum(tally.values())
    print(
        f"\n{total} placements by {len(signers)} keys · "
        f"{tally[VERIFIED]} verified here · {tally[UNSIGNED]} unsigned "
        f"(written before the service published signatures) · "
        f"{tally[FORGED]} bad · {tally[UNREADABLE]} unreadable"
    )
    print(f"{len(canvas)} of {GRID * GRID} cells painted")

    if tally[FORGED]:
        print(
            f"\n{tally[FORGED]} signature(s) did not verify. That should not be possible: the "
            "service checks signatures on write. Re-run before believing it, then say so "
            "publicly — it is either a bug here or something much worse there.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
