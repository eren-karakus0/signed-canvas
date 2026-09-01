"""Follow the canvas room and archive what appears in it.

One loop, one job. It reads forward from the archive's cursor, hands each batch to the
archive in a single transaction, and reports how far behind the room it is.

ON LAG, and a correction to ADR 0001 (2026-08-29):

    That ADR called the lag threshold 200 and described falling 200 behind as data loss. That
    was wrong. ``?since=<seq>`` pages *forward*, so a reader 1,000 behind catches up in five
    requests. The 200 cap limits a batch, not reachability.

    The real loss condition is the room trimming a message before we read it. Retention is
    not exposed — ``/config`` publishes no ring or trim knob — so the honest position is that
    the safe lag is unknown and the alert threshold is a conservative guess, not a derived
    number. ``LAG_ALERT`` below is that guess, and it is labelled as one.
"""

from __future__ import annotations

import argparse
import json
import logging
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from archive import Archive, ArchiveError

BASE_URL = "https://technocore.chat"
READ_LIMIT = 200  # the server's cap; asking for more returns 200 anyway
LONG_POLL_SECONDS = 10  # `/config` clamps ?wait= to max_wait, currently 10
REQUEST_TIMEOUT = 40  # must exceed LONG_POLL_SECONDS or every poll looks like a timeout
BACKOFF_START = 2.0
BACKOFF_MAX = 60.0

# A guess, not a derived bound. See the note at the top of this file: the room's retention is
# not published, so this is set well below any plausible ring and exists to make a stalled
# loop visible long before it could cost history.
LAG_ALERT = 500

# A backfill is a maintenance run a person is watching, not the service loop, so it gives up
# rather than retrying forever against a dependency that is shedding load.
BACKFILL_ATTEMPTS = 6

log = logging.getLogger("canvas.ingest")


class IngestError(Exception):
    """The room could not be read."""


def read_room(room: str, since: int, wait: int = 0) -> dict:
    """Messages newer than ``since``, oldest first.

    Raises:
        IngestError: on any HTTP or transport failure, with the server's own words when it
            gave any. 503 is the common one and is not exceptional — it is the dependency
            shedding load, measured at 3-25% depending on the hour.
    """
    query = urllib.parse.urlencode(
        {
            "since": since,
            "limit": READ_LIMIT,
            "format": "json",
            **({"wait": wait} if wait else {}),
        }
    )
    url = f"{BASE_URL}/r/{urllib.parse.quote(room, safe='')}?{query}"
    request = urllib.request.Request(url, headers={"accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
            body = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace").strip()[:120]
        raise IngestError(f"{exc.code} reading {room}: {detail}") from exc
    except Exception as exc:
        raise IngestError(f"cannot read {room}: {exc}") from exc

    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        # The service answers 503 as plain text with a 200-shaped body often enough that this
        # is a normal path, not a corruption.
        raise IngestError(f"non-JSON body from {room}: {body[:120]!r}") from exc
    if not isinstance(payload, dict) or "messages" not in payload:
        raise IngestError(f"unexpected room payload shape: {sorted(payload)[:8]}")
    return payload


def poll_once(archive: Archive, room: str, wait: int = 0) -> tuple[int, int]:
    """One read-verify-persist cycle.

    Returns:
        (placements stored, messages seen)

    Raises:
        IngestError: if the room could not be read.
        ArchiveError: if a message did not carry the documented fields.
    """
    payload = read_room(room, archive.last_seq, wait=wait)
    messages = payload.get("messages") or []
    room_head = int(payload.get("last_seq") or archive.last_seq)
    stored, _ = archive.apply_batch(messages, room_last_seq=room_head)
    return stored, len(messages)


def backfill(archive: Archive, room: str) -> tuple[int, int]:
    """Re-read the room from its start so stored rows can pick up their signatures.

    The normal loop cannot do this. ``?since=`` pages strictly forward and the cursor is
    already past every row that predates the service serving ``sig``, so those rows would stay
    attested forever even though the proof is now sitting in the room, one read away.

    Safe to run at any time, and safe to interrupt. ``apply_batch`` only ever fills a missing
    signature, and it advances the cursor with ``max``, so replaying old pages cannot rewind
    it, duplicate a placement or move one.

    Returns:
        (messages re-read, rows that became witnessed)

    Raises:
        IngestError: if a page could not be read after the retries.
    """
    before = archive.stats().witnessed
    cursor = 0
    seen = 0
    while True:
        backoff = BACKOFF_START
        for attempt in range(BACKFILL_ATTEMPTS):
            try:
                payload = read_room(room, cursor)
                break
            except IngestError as exc:
                if attempt == BACKFILL_ATTEMPTS - 1:
                    raise
                log.warning("%s — retrying in %.0fs", exc, backoff)
                time.sleep(backoff)
                backoff = min(BACKOFF_MAX, backoff * 2)

        messages = payload.get("messages") or []
        if not messages:
            break
        archive.apply_batch(messages)
        seen += len(messages)

        highest = max(int(message["seq"]) for message in messages)
        if highest <= cursor:
            # The page did not advance. Continuing would re-request the same window forever.
            log.warning("backfill stalled at seq %d — stopping", cursor)
            break
        cursor = highest

    return seen, archive.stats().witnessed - before


def run(archive_path: Path, room: str, once: bool = False) -> int:
    """The service loop. Returns a process exit code."""
    stopping = False

    def stop(signum: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True
        log.info("signal %s — finishing the current batch, then stopping", signum)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    backoff = BACKOFF_START
    with Archive(archive_path) as archive:
        archive.room = room
        log.info(
            "archive %s · room %s · from seq %d", archive_path, room, archive.last_seq
        )
        while not stopping:
            try:
                # Long-poll only when caught up. While behind, ask immediately: waiting for a
                # *new* message while a backlog exists is how a loop stays behind forever.
                caught_up = archive.stats().lag == 0
                stored, seen = poll_once(
                    archive, room, wait=LONG_POLL_SECONDS if caught_up else 0
                )
                backoff = BACKOFF_START
            except IngestError as exc:
                log.warning("%s — retrying in %.0fs", exc, backoff)
                time.sleep(backoff)
                backoff = min(BACKOFF_MAX, backoff * 2)
                continue
            except ArchiveError as exc:
                log.error("refusing a malformed batch: %s", exc)
                time.sleep(backoff)
                continue

            stats = archive.stats()
            if stored or seen:
                log.info(
                    "seq %d · +%d placements of %d messages · %d stored, %d witnessed, %d signers · lag %d",
                    stats.last_seq,
                    stored,
                    seen,
                    stats.placements,
                    stats.witnessed,
                    stats.signers,
                    stats.lag,
                )
            if stats.lag >= LAG_ALERT:
                log.error(
                    "ingest lag %d at or above the %d alert threshold — the room may trim "
                    "history before it is archived",
                    stats.lag,
                    LAG_ALERT,
                )
            if once:
                break
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--room", required=True, help="the canvas room to follow")
    parser.add_argument(
        "--archive",
        type=Path,
        default=Path("/root/flop/canvas/canvas.db"),
        help="SQLite file",
    )
    parser.add_argument("--once", action="store_true", help="one cycle, then exit")
    parser.add_argument(
        "--backfill",
        action="store_true",
        help="re-read the room from its start to pick up signatures for rows already "
        "archived, then exit. Does not move the cursor.",
    )
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    if args.backfill:
        with Archive(args.archive) as archive:
            archive.room = args.room
            seen, gained = backfill(archive, args.room)
            stats = archive.stats()
            log.info(
                "backfill re-read %d messages · %d rows became witnessed · "
                "%d of %d placements witnessed",
                seen,
                gained,
                stats.witnessed,
                stats.placements,
            )
        return 0
    return run(args.archive, args.room, once=args.once)


if __name__ == "__main__":
    sys.exit(main())
