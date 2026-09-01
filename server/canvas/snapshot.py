"""Packing the canvas into the bytes a client loads first.

Two planes, both indexed by ``cy * N + cx``:

    cells      4 bits per cell, two cells per byte      2,048 bytes
    witnessed  1 bit per cell                             512 bytes

The second plane exists because of the proof problem recorded in ``archive.py``: a client
that received only colours would have to render every pixel as though it were equally
proven, and it is not. Whether a pixel is witnessed or merely attested has to survive the
packing, or the interface cannot tell the truth about what it is showing.

2,560 bytes together — 3,414 base64url characters, still one small response, and 386× smaller
than replaying the equivalent room JSON.
"""

from __future__ import annotations

import base64
from typing import Iterable, Sequence

N = 64
CELLS = N * N
CELL_BYTES = CELLS // 2
WITNESS_BYTES = CELLS // 8


class SnapshotError(Exception):
    """The canvas could not be packed or unpacked."""


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
        if not (0 <= row.cx < N and 0 <= row.cy < N):
            raise SnapshotError(f"cell out of bounds: {row.cx},{row.cy}")
        if not (1 <= row.step <= 15):
            raise SnapshotError(f"step {row.step} is not paintable")
        index = row.cy * N + row.cx
        byte, high = divmod(index, 2)
        if high == 0:
            cells[byte] = (cells[byte] & 0x0F) | (row.step << 4)
        else:
            cells[byte] = (cells[byte] & 0xF0) | row.step
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
        byte, high = divmod(index, 2)
        step = (cells[byte] >> 4) if high == 0 else (cells[byte] & 0x0F)
        if step == 0:
            continue
        proven = bool(witnessed[index // 8] & (1 << (index % 8)))
        out.append((index % N, index // N, step, proven))
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
    if not (0 <= cx < N and 0 <= cy < N):
        raise SnapshotError(f"cell out of bounds: {cx},{cy}")
    if not (1 <= step <= 15):
        raise SnapshotError(f"step {step} is not paintable")

    index = cy * N + cx
    byte, high = divmod(index, 2)
    if high == 0:
        cells[byte] = (cells[byte] & 0x0F) | (step << 4)
    else:
        cells[byte] = (cells[byte] & 0xF0) | step

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
