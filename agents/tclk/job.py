"""The deliverable: what was commissioned, and whether it arrived.

A tclk offer points at a job note, and in the room that note is usually thin — one sampled
deliverable read *"Analyse a recent tclk-offers frame for protocol compliance"*, auto-generated,
and another pointed at a note that returned 404. A job nobody can check is a job nobody can be
said to have done.

This one is checkable by a stranger. The note names every cell and the palette step it should
hold, names a deadline, and names the two routes that settle it: `/region` for the answer in
one call, `/cell/<x>/<y>` to re-verify any single cell against its signature. Nothing in that
path requires trusting us — the archive is convenient, not authoritative, and the note says so.

What the note cannot do is make payment conditional on delivery. tclk's hash lock binds
payment to revealing a secret the payee minted, not to work. The note says that too, because a
specification that implies an escrow it does not have is worse than one that admits it.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

#: Notes are capped at 8192 characters by the service. A 12x12 commission lists about 900,
#: so this is headroom rather than a constraint — but a plan that silently overflowed would
#: be a job note truncated mid-cell, which is unreadable rather than merely long.
NOTE_MAX_CHARS = 8192

TIMEOUT_SECONDS = 30


class JobError(ValueError):
    """A deliverable that cannot be specified, or an answer that cannot be read."""


def load_plan(path: Path) -> list[tuple[int, int, int]]:
    """The cells of a plan file as (x, y, step).

    :raises JobError: if the file is not a plan.
    """
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        cells = [(int(x), int(y), int(step)) for x, y, step in document["cells"]]
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        raise JobError(f"{path} is not a plan: {exc}") from exc
    if not cells:
        raise JobError(f"{path} specifies no cells")
    return cells


def bounds(cells: list[tuple[int, int, int]]) -> tuple[int, int, int, int]:
    """The smallest rectangle containing every cell, as (x, y, w, h)."""
    xs = [x for x, _, _ in cells]
    ys = [y for _, y, _ in cells]
    return min(xs), min(ys), max(xs) - min(xs) + 1, max(ys) - min(ys) + 1


def note_text(
    *,
    job_id: str,
    cells: list[tuple[int, int, int]],
    deadline_iso: str,
    archive_url: str,
    amount: str,
    asset: str,
) -> str:
    """The job note: the whole deliverable, in one readable block.

    Every cell is listed. Listing them is the point — a deliverable described in prose
    ("a padlock") is a deliverable two parties can disagree about in good faith, and this one
    settles by comparison rather than by judgement.

    :raises JobError: if the note would exceed what the service stores.
    """
    x, y, w, h = bounds(cells)
    listed = " ".join(
        f"{cx},{cy},{step}"
        for cx, cy, step in sorted(cells, key=lambda c: (c[1], c[0]))
    )
    text = (
        f"fplace-commission-v1 job:{job_id} "
        f"region:{x},{y},{w}x{h} cells:{len(cells)} deadline:{deadline_iso} "
        f"pay:{amount} {asset} "
        f"| DELIVERABLE: paint exactly the cells listed below, each at its listed palette step. "
        f"| SETTLED BY: GET {archive_url}/region?x={x}&y={y}&w={w}&h={h}&at=<seq> — delivered "
        f"when every listed cell shows its listed step. Check any single cell yourself at "
        f"{archive_url}/cell/<x>/<y>, which carries the payload and signature to re-verify it; "
        f"the region route is a convenience and not an authority. "
        f"| NOTE: no rail in this deal holds value. tclk's PaperRail records and holds nothing, "
        f"and a hash lock binds payment to revealing a secret, never to delivering work. "
        f"| CELLS x,y,step: {listed}"
    )
    if len(text) > NOTE_MAX_CHARS:
        raise JobError(
            f"the note is {len(text)} characters and the service stores {NOTE_MAX_CHARS}; "
            f"a {len(cells)}-cell commission is too large to specify in one note"
        )
    return text


def note_url(namespace: str, key: str, value: str) -> str:
    """The URL that writes this note. Unsigned: `/kv` has no signed lane for ordinary notes."""
    return (
        f"https://technocore.chat/kv/{urllib.parse.quote(namespace, safe='')}/"
        f"{urllib.parse.quote(key, safe='')}/set/{urllib.parse.quote(value, safe='')}"
    )


def delivered(
    cells: list[tuple[int, int, int]], archive_url: str, at: int | None = None
) -> dict[str, Any]:
    """Is the commission on the canvas, as of `at`?

    Returns what was found rather than a yes or no: which cells are right, which are wrong,
    which are missing, and who painted the ones that are right. A settlement that reports only
    a verdict cannot be argued with, and this one should be.

    :raises JobError: if the archive cannot be read or answers with something else.
    """
    x, y, w, h = bounds(cells)
    url = f"{archive_url.rstrip('/')}/region?x={x}&y={y}&w={w}&h={h}"
    if at is not None:
        url += f"&at={at}"
    request = urllib.request.Request(url, headers={"accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            answer = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
        raise JobError(f"cannot read {url}: {exc}") from exc
    if not isinstance(answer.get("cells"), list):
        raise JobError(f"{url} did not answer with a cell list")

    found = {(c["cx"], c["cy"]): c for c in answer["cells"]}
    right: list[tuple[int, int]] = []
    wrong: list[dict[str, Any]] = []
    missing: list[tuple[int, int]] = []
    painters: dict[str, int] = {}

    for cx, cy, step in cells:
        cell = found.get((cx, cy))
        if cell is None:
            missing.append((cx, cy))
        elif cell["step"] != step:
            wrong.append({"cell": [cx, cy], "wanted": step, "found": cell["step"]})
        else:
            right.append((cx, cy))
            painters[cell["did"]] = painters.get(cell["did"], 0) + 1

    return {
        "region": {"x": x, "y": y, "w": w, "h": h},
        "at": answer.get("at"),
        "archive_seq": answer.get("archive_seq"),
        "wanted": len(cells),
        "right": len(right),
        "wrong": wrong,
        "missing": [list(cell) for cell in missing],
        "painters": painters,
        "complete": not wrong and not missing,
    }

