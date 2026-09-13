"""Watch a room for frames that belong to one deal, and record them.

`/r/tclk-offers` carries about four messages a second, so the interesting frame arrives among
thousands that are somebody else's. Everything here is therefore a filter: decode, check it
names our contract, check the sender is who the state machine expects, and only then record.

Frames that fail are counted, not stored. A room that is mostly other people's traffic would
otherwise fill the record with it, and the record is what the deal resumes from.

    python agents/tclk/follow.py <contract> --room tclk-offers --minutes 10
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import deal as deal_module
import frames
from record import DealRecord, RecordError

BASE_URL = "https://technocore.chat"
TIMEOUT_SECONDS = 30

#: The service holds a long poll for at most this many seconds, and prefers it to tight
#: polling. On a room this busy it returns almost immediately anyway.
WAIT_SECONDS = 10

#: A read returns at most 200 messages. On a four-a-second room that is fifty seconds of
#: traffic, so falling behind is possible and worth reporting rather than hiding.
READ_LIMIT = 200


class FollowError(RuntimeError):
    """The room could not be followed."""


def read_since(room: str, since: int) -> dict:
    """Messages after `since`, waiting briefly for one if the room is quiet."""
    url = (
        f"{BASE_URL}/r/{urllib.parse.quote(room, safe='')}"
        f"?format=json&since={since}&limit={READ_LIMIT}&wait={WAIT_SECONDS}"
    )
    request = urllib.request.Request(url, headers={"accept": "application/json"})
    try:
        with urllib.request.urlopen(
            request, timeout=TIMEOUT_SECONDS + WAIT_SECONDS
        ) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
        raise FollowError(f"cannot read /r/{room}: {exc}") from exc


def follow(record: DealRecord, room: str, since: int, until: float) -> dict[str, int]:
    """Record every frame belonging to this deal until `until`, and report what was seen.

    The state machine decides what counts. A frame naming our contract but arriving out of
    turn, or from the wrong side, is refused by `apply` and counted rather than recorded —
    the record is the deal's history, not the room's.
    """
    counts = {"read": 0, "ours": 0, "recorded": 0, "refused": 0}
    cursor = since

    while time.time() < until:
        answer = read_since(room, cursor)
        messages = answer.get("messages", [])
        counts["read"] += len(messages)
        for message in messages:
            cursor = max(cursor, int(message.get("seq", cursor)))
            try:
                frame = frames.decode(message.get("text", ""))
            except frames.FrameError:
                continue

            current = deal_module.rebuild(record.frames, int(time.time() * 1000))
            # Both names, because a deal has two: an `accept` answers the *offer* id, and
            # everything after it names the *contract* id derived from that acceptance.
            # Filtering on one of them silently drops half the conversation — which is how a
            # reveal we were waiting for would have gone past unseen.
            names = {current.contract, current.offer.get("id")}
            if frame.get("contract") not in names and frame.get("ref") not in names:
                continue
            counts["ours"] += 1

            sender = message.get("from", "")
            result = deal_module.apply(current, frame, sender, int(time.time() * 1000))
            if not result.ok:
                counts["refused"] += 1
                print(
                    f"  refused {frame.get('type')} from {sender[8:20]}: {result.reason}"
                )
                continue
            record.append(
                label=str(frame.get("type")),
                room=room,
                seq=int(message["seq"]),
                sender=sender,
                frame=frame,
            )
            counts["recorded"] += 1
            print(
                f"  recorded {frame.get('type')} from {sender[8:20]} at seq {message['seq']}"
            )

        if not messages:
            # The long poll already waited; sleeping again would only add latency.
            continue
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("contract")
    parser.add_argument("--room", default="tclk-offers")
    parser.add_argument("--minutes", type=float, default=10.0)
    parser.add_argument("--deals", type=Path, default=Path("deals"))
    args = parser.parse_args()

    try:
        record = DealRecord.find(args.deals, args.contract)
    except RecordError as exc:
        print(exc, file=sys.stderr)
        return 1
    since = max(
        (entry["seq"] for entry in record.frames if entry["room"] == args.room),
        default=0,
    )

    print(f"following /r/{args.room} from seq {since} for {args.minutes:g} minutes")
    print(f"contract {record.contract[:20]}…\n")
    try:
        counts = follow(record, args.room, since, time.time() + args.minutes * 60)
    except FollowError as exc:
        print(f"stopped: {exc}", file=sys.stderr)
        return 1

    final = deal_module.rebuild(record.frames, int(time.time() * 1000))
    print(f"\nread {counts['read']} messages · {counts['ours']} named this contract")
    print(f"recorded {counts['recorded']} · refused {counts['refused']}")
    print(f"state: {final.state.value}")
    owed = final.owes(record.get("payer", ""))
    print(f"we owe: {owed or 'nothing'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
