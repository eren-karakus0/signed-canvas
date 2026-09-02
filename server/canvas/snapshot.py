"""Packing the canvas into the bytes a client loads first.

Three planes, all indexed by ``cy * N + cx``:

    cells      1 byte per cell                            4,096 bytes
    witnessed  1 bit per cell                               512 bytes
    stack      1 byte × MAX_STACK levels per cell         32,768 bytes

``cells`` and ``stack`` held a palette index in four bits until the palette outgrew them.
Fifteen colours is what half a byte can say, and that was the real reason the canvas had
fifteen — not a design decision anyone would defend once it was written down. A whole byte
holds the 35 the wire format now allows, with room left, and costs 20 KB on a response that
gzips to a fraction of it. Six-bit packing would have saved half of that and added bit
arithmetic to two languages for the privilege.

``witnessed`` exists because of the proof problem recorded in ``archive.py``: a client that
received only colours would have to render every pixel as though it were equally proven, and
it is not. Whether a pixel is witnessed or merely attested has to survive the packing, or the
interface cannot tell the truth about what it is showing.

``stack`` exists because the canvas is not flat. A cell that has been overwritten is drawn as
a column, one level per overwrite, and each level keeps the colour that was there — the tower
is the cell's history standing up. Without this plane a client could only learn that history
by watching it happen: **every tower collapsed to a flat square on reload**, and every level
took the newest colour, because the top colour was the only thing the snapshot carried.

It holds the levels *below* the top, oldest first, and 0 terminates. The top itself stays in
``cells``, so the two planes never disagree about the same fact and a client that ignores
``stack`` renders exactly what it rendered before.

18,944 bytes together. That is 7× the old snapshot and still one small gzipped response — the
alternative is a client replaying the room's whole history to draw a shape the server already
knows.
"""

from __future__ import annotations

import base64
from typing import Iterable, Sequence

# The canvas grew rightwards on 2026-09-02 — a square of pixels in a wide stage left the
# screen half empty. Rightwards only: a placement is a signature over `px <x>,<y> …`, so a
# cell that moved would not move a pixel, it would orphan one. 96 is the ceiling the wire
# format allows (`\d{1,2}`), and the height stayed at 64 because the room already holds
# `px 58,54`.
COLS = 96
ROWS = 64
CELLS = COLS * ROWS
CELL_BYTES = CELLS
WITNESS_BYTES = CELLS // 8

# Levels a tower can show beneath its top. The client caps elevation at the same number
# (`MAX_CONTEST` in projection.ts): past it the column would leave the viewport, so a cell
# contested more often keeps its most recent levels and forgets the older ones. The two
# constants have to agree, and the round-trip test is what says they do.
MAX_STACK = 8
STACK_BYTES = CELLS * MAX_STACK
MAX_STEP = 35


class SnapshotError(Exception):
    """The canvas could not be packed or unpacked."""


def pack_stack(rows: Iterable) -> bytes:
    """Pack each cell's tower — the levels below its top, oldest first.

    Args:
        rows: every placement worth drawing, in sequence order, with ``cx``, ``cy`` and
            ``step``. The newest per cell becomes the top and is *not* in this plane; the
            ``MAX_STACK`` before it become the tower, bottom first.

    Raises:
        SnapshotError: if a row falls outside the canvas or carries an unpaintable step.
    """
    history: dict[int, list[int]] = {}
    for row in rows:
        if not (0 <= row.cx < COLS and 0 <= row.cy < ROWS):
            raise SnapshotError(f"cell out of bounds: {row.cx},{row.cy}")
        if not (1 <= row.step <= MAX_STEP):
            raise SnapshotError(f"step {row.step} is not paintable")
        index = row.cy * COLS + row.cx
        # Keep one more than the tower needs: the newest is the top, which lives in `cells`.
        levels = history.setdefault(index, [])
        levels.append(row.step)
        if len(levels) > MAX_STACK + 1:
            del levels[0]

    stack = bytearray(STACK_BYTES)
    for index, levels in history.items():
        for level, step in enumerate(levels[:-1]):
            set_level(stack, index, level, step)
    return bytes(stack)


def set_level(stack: bytearray, index: int, level: int, step: int) -> None:
    """Write one tower level in place. ``level`` 0 is the bottom.

    Raises:
        SnapshotError: if the level is outside the tower or the step is unpaintable.
    """
    if not (0 <= level < MAX_STACK):
        raise SnapshotError(f"level {level} is outside the tower (0..{MAX_STACK - 1})")
    if not (0 <= step <= MAX_STEP):
        raise SnapshotError(f"step {step} is not a palette index")
    stack[index * MAX_STACK + level] = step


def get_level(stack: bytes, index: int, level: int) -> int:
    """Read one tower level. 0 means the tower does not reach this high."""
    return stack[index * MAX_STACK + level]


def pack(rows: Iterable) -> tuple[bytes, bytes]:
    """Pack the newest placement per cell into (cells, witnessed).

    Args:
        rows: objects with ``cx``, ``cy``, ``step`` and ``witnessed``. Later rows for the same
            cell overwrite earlier ones, so pass them in sequence order.

    Raises:
        SnapshotError: if a row falls outside the canvas or carries an unpaintable step.
    """
    cells = bytearray(CELL_BYTES)
    witnessed = bytearray(WITNESS_BYTES)

    for row in rows:
        if not (0 <= row.cx < COLS and 0 <= row.cy < ROWS):
            raise SnapshotError(f"cell out of bounds: {row.cx},{row.cy}")
        if not (1 <= row.step <= MAX_STEP):
            raise SnapshotError(f"step {row.step} is not paintable")
        index = row.cy * COLS + row.cx
        cells[index] = row.step
        if row.witnessed:
            witnessed[index // 8] |= 1 << (index % 8)
        else:
            witnessed[index // 8] &= ~(1 << (index % 8)) & 0xFF

    return bytes(cells), bytes(witnessed)


def unpack(cells: bytes, witnessed: bytes) -> list[tuple[int, int, int, bool]]:
    """The inverse of :func:`pack`, as ``(cx, cy, step, witnessed)`` for painted cells only.

    Used by the round-trip test rather than by the server, which never needs to read its own
    snapshot back — but a packer without an unpacker is a packer nobody has checked.

    Raises:
        SnapshotError: if either plane is the wrong length.
    """
    if len(cells) != CELL_BYTES:
        raise SnapshotError(f"cells plane is {len(cells)} bytes, expected {CELL_BYTES}")
    if len(witnessed) != WITNESS_BYTES:
        raise SnapshotError(
            f"witness plane is {len(witnessed)} bytes, expected {WITNESS_BYTES}"
        )

    out: list[tuple[int, int, int, bool]] = []
    for index in range(CELLS):
        step = cells[index]
        if step == 0:
            continue
        proven = bool(witnessed[index // 8] & (1 << (index % 8)))
        out.append((index % COLS, index // COLS, step, proven))
    return out


def encode(raw: bytes) -> str:
    """base64url without padding — the spelling the rest of this project uses."""
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode(text: str, expected: int) -> bytes:
    """Reverse :func:`encode`.

    Raises:
        SnapshotError: if the text is not base64url or does not decode to ``expected`` bytes.
    """
    try:
        raw = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except Exception as exc:
        raise SnapshotError(f"not base64url: {text[:24]!r}") from exc
    if len(raw) != expected:
        raise SnapshotError(f"decodes to {len(raw)} bytes, expected {expected}")
    return raw


def set_cell(
    cells: bytearray, witnessed: bytearray, cx: int, cy: int, step: int, proven: bool
) -> None:
    """Write one cell into unpacked planes, in place.

    Raises:
        SnapshotError: if the cell is outside the canvas or the step is unpaintable.
    """
    if not (0 <= cx < COLS and 0 <= cy < ROWS):
        raise SnapshotError(f"cell out of bounds: {cx},{cy}")
    if not (1 <= step <= MAX_STEP):
        raise SnapshotError(f"step {step} is not paintable")

    index = cy * COLS + cx
    cells[index] = step

    bit = 1 << (index % 8)
    if proven:
        witnessed[index // 8] |= bit
    else:
        witnessed[index // 8] &= ~bit & 0xFF


def apply_delta(
    cells: bytearray, witnessed: bytearray, placements: Sequence[dict]
) -> None:
    """Apply ``/since`` placements onto unpacked planes, in place, in order.

    This is what a client does on every poll, and the round-trip test asserts it reaches the
    same bytes as a full replay. Order matters: two placements in one cell must leave the
    later one, which is why this walks the list rather than packing it.

    Raises:
        SnapshotError: if a placement is outside the canvas or unpaintable.
    """
    for placement in placements:
        set_cell(
            cells,
            witnessed,
            int(placement["cx"]),
            int(placement["cy"]),
            int(placement["step"]),
            bool(placement.get("witnessed")),
        )
