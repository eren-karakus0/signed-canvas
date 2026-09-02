"""Place a whole picture, one signed pixel at a time.

`place.py` writes one pixel and is the reference for the protocol. This writes a plan of
several hundred, which is a different problem: pacing, resuming, and not spending writes on
cells that already hold the right colour.

    python agents/draw.py plans/flop.json --key identity/seed.hex
    python agents/draw.py plans/flop.json --dry-run

The ten second wait between placements in the browser is the interface being polite to other
players; it is not in the protocol. What the protocol enforces is technocore.chat's limit of
300 writes a minute per client IP, so this paces itself under that and no faster. Going
faster does not paint sooner — it earns a 429 and then waits anyway.

Every pixel is a separate signature over `px <x>,<y> <step> <token>`. There is no batch write
and there should not be: a batch would be one signature standing for many cells, and then
"every pixel is signed" would stop being true in the way the canvas claims it.

Resuming is the normal case, not the recovery case. The plan is compared against the archive
before anything is written, and only the cells that differ are placed. Interrupt it and run it
again; it picks up where it stopped, minus whatever someone else has painted over meanwhile.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from place import (  # noqa: E402 — the path insert above has to come first
    BACKOFF_SECONDS,
    COLS,
    ROOM,
    ROWS,
    SHED_STATUSES,
    Refused,
    Uncertain,
    _get,
    _public,
    did_of,
    load_seed,
    new_token,
    next_nonce,
    place,
    placement_text,
)

ARCHIVE_URL = os.environ.get("FPLACE_ARCHIVE", "https://signed-canvas.vercel.app/api")

# Under technocore.chat's 300 writes a minute per IP, with room for the reads this also makes
# and for anything else the same address is doing.
WRITES_PER_MINUTE = 240
SECONDS_PER_WRITE = 60.0 / WRITES_PER_MINUTE

# How often to say something while a long plan runs. Silence for four minutes looks like a
# hang, and the honest fix is to report progress rather than to print every pixel.
REPORT_EVERY = 25

TIMEOUT_SECONDS = 30


class PlanError(Exception):
    """The plan file cannot be drawn."""


def load_plan(path: str) -> list[tuple[int, int, int]]:
    """The cells in a plan file, validated against the canvas.

    :raises PlanError: the file is not a plan, or a cell falls outside the canvas.
    """
    try:
        with open(path, encoding="utf-8") as handle:
            document = json.load(handle)
    except OSError as exc:
        raise PlanError(f"cannot read {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise PlanError(f"{path} is not JSON: {exc}") from exc

    cells = document.get("cells")
    if not isinstance(cells, list) or not cells:
        raise PlanError(f"{path} has no cells")

    out: list[tuple[int, int, int]] = []
    for index, cell in enumerate(cells):
        if not isinstance(cell, list) or len(cell) != 3:
            raise PlanError(f"{path} cell {index} is not [x, y, step]")
        x, y, step = cell
        if not all(isinstance(v, int) for v in (x, y, step)):
            raise PlanError(f"{path} cell {index} has a non-integer field")
        if not (0 <= x < COLS and 0 <= y < ROWS):
            raise PlanError(
                f"{path} cell {index} is at {x},{y}, off a {COLS}x{ROWS} canvas"
            )
        out.append((x, y, step))
    return out


def current_canvas() -> dict[tuple[int, int], int]:
    """What the archive says is on the canvas now, as {(x, y): step}.

    Read from the archive rather than the room because the room returns at most 200 messages
    and cannot page backwards, so it cannot answer what a cell holds.

    :raises PlanError: the archive cannot be read or does not answer with a placement list.
    """
    url = f"{ARCHIVE_URL.rstrip('/')}/since/0"
    request = urllib.request.Request(url, headers={"accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            document = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
        raise PlanError(f"cannot read the archive at {url}: {exc}") from exc

    placements = document.get("placements")
    if not isinstance(placements, list):
        raise PlanError(f"{url} did not answer with a placement list")

    canvas: dict[tuple[int, int], int] = {}
    for placement in placements:
        try:
            canvas[(int(placement["cx"]), int(placement["cy"]))] = int(
                placement["step"]
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise PlanError(
                f"{url} returned a placement that is not one: {exc}"
            ) from exc
    return canvas


def remaining(
    plan: list[tuple[int, int, int]], canvas: dict[tuple[int, int], int]
) -> list[tuple[int, int, int]]:
    """The cells of `plan` that the canvas does not already hold.

    A cell that is already the right colour is skipped rather than repainted: repainting it
    spends a write, and it also counts as a contest against its own owner, which would make
    the readout say the cell was fought over when it was not.
    """
    return [(x, y, step) for x, y, step in plan if canvas.get((x, y)) != step]


class Keykit:
    """Signs through technocore-keykit, which holds the key encrypted on disk.

    The alternative is a raw 32-byte seed in a file, which `place.py` accepts and which is
    fine for a key that exists only to paint. It is the wrong thing for an identity that is
    registered and means something: this way the seed is decrypted inside keykit for one
    signature at a time and never written anywhere.

    The cost is a process per pixel, about 0.8 seconds. That is slower than the pacing this
    would otherwise use and still finishes a few hundred cells in a few minutes, so it buys
    the safer key handling for time nobody is waiting on.
    """

    def __init__(self, script: str, directory: str) -> None:
        if not os.path.exists(script):
            raise PlanError(f"no keykit at {script}")
        if not os.path.exists(os.path.join(directory, "identity.json")):
            raise PlanError(f"no identity.json in {directory}")
        if not os.environ.get("KEYKIT_PASSPHRASE"):
            raise PlanError(
                "KEYKIT_PASSPHRASE is not set; keykit would prompt, and this does not have a "
                "terminal to prompt on"
            )
        self._script = script
        self._directory = directory

    def url_for(self, room: str, text: str) -> str:
        """The signed URL for one placement.

        :raises PlanError: keykit failed or printed something that is not a URL.
        """
        try:
            done = subprocess.run(
                ["node", self._script, "say", room, text, "--dir", self._directory],
                capture_output=True,
                text=True,
                timeout=TIMEOUT_SECONDS,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise PlanError(f"could not run keykit: {exc}") from exc
        if done.returncode != 0:
            raise PlanError(
                f"keykit refused to sign: {done.stderr.strip() or done.returncode}"
            )
        url = done.stdout.strip().splitlines()[-1] if done.stdout.strip() else ""
        if not url.startswith("https://"):
            raise PlanError(f"keykit did not print a URL: {url[:80]!r}")
        return url


def place_signed_url(url: str) -> None:
    """Perform one signed write that keykit has already built.

    Mirrors `place.place`'s failure handling: only the shedding statuses are retried, because
    a 400 or 403 is an answer about this exact request and sending it again spends a write to
    be told the same thing. An unanswered write is not retried at all — it may have landed,
    and a second one is a pixel that could bury someone else's.

    :raises Refused: the service answered no.
    :raises Uncertain: no answer arrived.
    """
    for pause in (*BACKOFF_SECONDS, None):
        try:
            _get(url)
            return
        except Refused as exc:
            if exc.status not in SHED_STATUSES or pause is None:
                raise
            print(f"  {exc} - retrying in {pause}s", file=sys.stderr)
            time.sleep(pause)
    raise Uncertain("the write was neither answered nor refused")


def draw_with_keykit(
    cells: list[tuple[int, int, int]],
    keykit: Keykit,
    room: str,
    pace: float,
) -> tuple[int, int]:
    """Place every cell, signing each one through keykit."""
    placed = 0
    failed = 0
    started = time.monotonic()

    for index, (x, y, step) in enumerate(cells):
        text = placement_text(x, y, step, new_token())
        try:
            place_signed_url(keykit.url_for(room, text))
            placed += 1
        except (Refused, Uncertain, PlanError) as exc:
            print(f"  {x},{y} step {step}: {exc}", file=sys.stderr)
            failed += 1
        _report(index + 1, len(cells), started)
        if index + 1 < len(cells):
            time.sleep(pace)

    return placed, failed


def _report(done: int, total: int, started: float) -> None:
    """Progress, often enough that a long plan does not look like a hang."""
    if done % REPORT_EVERY and done != total:
        return
    elapsed = time.monotonic() - started
    rate = done / elapsed if elapsed > 0 else 0.0
    left = (total - done) / rate if rate > 0 else 0.0
    print(
        f"  {done}/{total} - {rate * 60:.0f}/min - about {left / 60:.1f} min left",
        flush=True,
    )


def draw(
    cells: list[tuple[int, int, int]],
    seed: bytes,
    room: str,
    pace: float,
) -> tuple[int, int]:
    """Place every cell. Returns (placed, failed).

    The nonce is held locally and incremented, rather than re-read from the room before each
    write: asking costs a read per pixel, and at a few hundred pixels that is most of a read
    budget spent learning a number this already knows. It is re-read once after any refusal,
    because a refusal is the one case where the local count may have drifted from the room's.
    """
    did = did_of(_public(seed))
    nonce = next_nonce(room, did)
    placed = 0
    failed = 0
    started = time.monotonic()

    for index, (x, y, step) in enumerate(cells):
        text = placement_text(x, y, step, new_token())
        try:
            place(room, seed, text, nonce)
            nonce += 1
            placed += 1
        except Refused as exc:
            print(f"  {x},{y} step {step}: {exc}", file=sys.stderr)
            failed += 1
            nonce = next_nonce(room, did)
        except Uncertain as exc:
            # `place` already asked the room whether it landed; reaching here means it had
            # not yet. It may still arrive, so the cell is left for the next run rather than
            # written again — a second write of the same cell is a pixel someone else's
            # placement could end up under.
            print(
                f"  {x},{y} step {step}: {exc} — left for the next run", file=sys.stderr
            )
            failed += 1
            nonce = next_nonce(room, did)

        _report(index + 1, len(cells), started)
        if index + 1 < len(cells):
            time.sleep(pace)

    return placed, failed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("plan", help="a plan file from scripts/pixelise.mjs")
    parser.add_argument(
        "--key", default="identity/seed.hex", help="32-byte seed, as hex"
    )
    parser.add_argument(
        "--keykit",
        metavar="DIR",
        help="sign through technocore-keykit with the encrypted identity in DIR, instead of "
        "a raw seed. Needs KEYKIT_PASSPHRASE in the environment.",
    )
    parser.add_argument(
        "--keykit-script",
        default="../technocore-keykit/keykit.js",
        help="path to keykit.js (default ../technocore-keykit/keykit.js)",
    )
    parser.add_argument("--room", default=ROOM)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="say what would be placed and write nothing",
    )
    parser.add_argument(
        "--pace",
        type=float,
        default=SECONDS_PER_WRITE,
        help=f"seconds between writes (default {SECONDS_PER_WRITE:.2f}, "
        f"which is {WRITES_PER_MINUTE}/min under the service's 300)",
    )
    args = parser.parse_args()

    if args.pace < SECONDS_PER_WRITE:
        print(
            f"--pace {args.pace} is faster than {WRITES_PER_MINUTE}/min; "
            "the service sheds at 300 and you will wait anyway",
            file=sys.stderr,
        )
        return 2

    try:
        plan = load_plan(args.plan)
        canvas = current_canvas()
    except PlanError as exc:
        print(exc, file=sys.stderr)
        return 1

    todo = remaining(plan, canvas)
    already = len(plan) - len(todo)
    minutes = len(todo) * args.pace / 60
    print(
        f"{args.plan}: {len(plan)} cells, {already} already right, {len(todo)} to place"
    )
    print(f"about {minutes:.1f} minutes at {60 / args.pace:.0f}/min")

    if args.dry_run:
        overwrites = sum(1 for x, y, _ in todo if (x, y) in canvas)
        print(
            f"dry run - nothing written. {overwrites} of those cells hold someone's pixel."
        )
        return 0
    if not todo:
        print("nothing to do")
        return 0

    if args.keykit:
        try:
            signer = Keykit(args.keykit_script, args.keykit)
        except PlanError as exc:
            print(exc, file=sys.stderr)
            return 1
        placed, failed = draw_with_keykit(todo, signer, args.room, args.pace)
    else:
        try:
            seed = load_seed(args.key)
        except (OSError, ValueError) as exc:
            print(f"cannot load the key at {args.key}: {exc}", file=sys.stderr)
            return 1
        placed, failed = draw(todo, seed, args.room, args.pace)
    print(f"\nplaced {placed}, failed {failed}")
    if failed:
        print("run it again to finish; placed cells are skipped", file=sys.stderr)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
