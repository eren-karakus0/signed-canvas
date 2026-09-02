"""Parsing a room line into a canvas placement.

The wire format is the whole contract with agents (FR-10): an agent needs nothing from us
but this string. So parsing is strict — a line that is nearly a placement is not one, and
guessing would let a typo paint a pixel nobody meant.

    px <x>,<y> <step> <nonce>        e.g.  px 12,47 3 k8f2a1
"""

from __future__ import annotations

import re
from typing import NamedTuple

N = 64
MIN_STEP = 1
MAX_STEP = 35

# Anchored at both ends, with single spaces: the server has already swept the text, so any
# other spacing is a different string and was signed as one.
PLACEMENT_PATTERN = re.compile(r"^px (\d{1,2}),(\d{1,2}) ([0-9a-z]) ([0-9a-z]{6})$")

SIGNED_SENDER_PREFIX = "did:key:"


class Placement(NamedTuple):
    """One pixel, as parsed from a room line. Says nothing about whether it was verified."""

    cx: int
    cy: int
    step: int
    token: str


def parse(text: str) -> Placement | None:
    """The placement in ``text``, or None if the line is not one.

    Returns None rather than raising: a room is world-writable and most lines in it will not
    be placements. That is ordinary traffic, not an error condition.
    """
    match = PLACEMENT_PATTERN.match(text)
    if match is None:
        return None
    cx, cy = int(match.group(1)), int(match.group(2))
    # Base36, not hex: hex is four bits and the palette outgrew it. 1-f are unchanged.
    step = int(match.group(3), 36)
    if not (0 <= cx < N and 0 <= cy < N):
        return None
    if not (MIN_STEP <= step <= MAX_STEP):
        return None
    return Placement(cx=cx, cy=cy, step=step, token=match.group(4))


def is_signed_sender(sender: str) -> bool:
    """Whether the room attributes this line to a ``did:key`` rather than to a nickname.

    Room nicknames match ``^[a-z0-9][a-z0-9_-]{0,47}$``, which cannot contain a colon or an
    uppercase letter, so no nickname can be spelled to look like a DID.

    This is the server's attestation that it verified a signature at write time. It is not
    proof: the read API never returns the signature, so nothing here can re-check it. See
    ``archive.py`` for what that distinction costs and how it is recorded.
    """
    return sender.startswith(SIGNED_SENDER_PREFIX)
