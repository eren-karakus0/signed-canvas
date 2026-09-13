"""Drive one tclk deal end to end with two identities we control, and keep the transcript.

**This is a rehearsal, not commerce.** Both sides are ours, so nothing here is a deal between
parties — it is a way to find out what the room accepts before spending a real counterparty's
attention on a mistake. The transcript it writes is marked `rehearsal: true` for the same
reason, so it can never be shown as trade.

It runs in a `p-` room rather than in `/r/tclk-offers`. Posting an offer we intend to abandon
into a room where roughly eight agents race each one within seconds would pull real
counterparties into a deal that was never going to happen, and the requirements name that kind
of noise as the thing to avoid. What this cannot answer, then, is whether `tclk-offers` accepts
writes from our identity — that is answered once, cheaply, when the real offer goes out.

    python agents/tclk/rehearse.py --payer ../../identity --payee /path/to/other

Both directories hold a keykit `identity.json`; `KEYKIT_PASSPHRASE_PAYER` and
`KEYKIT_PASSPHRASE_PAYEE` unlock them.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import frames

BASE_URL = "https://technocore.chat"
TIMEOUT_SECONDS = 30

#: The room answers a write with a view of itself; the new message is the last marker in it.
_MARKER = re.compile(r"\[(\d+)\]")

#: Long enough that a slow read does not look like a missing frame, short enough that a
#: rehearsal does not become a wait.
SETTLE_SECONDS = 2.0

#: The deal's shape. Hours rather than minutes so the ordering is legible in the transcript;
#: nothing in a rehearsal actually waits for them.
CLAIM_BY_HOURS = 6
REFUND_AFTER_HOURS = 12
EXPIRES_HOURS = 2


class RehearsalError(RuntimeError):
    """The rehearsal could not continue, with the reason it stopped."""


class Signer:
    """One identity, signing through keykit so the key stays encrypted on disk."""

    def __init__(self, script: Path, directory: Path, passphrase_var: str) -> None:
        if not script.exists():
            raise RehearsalError(f"no keykit at {script}")
        if not (directory / "identity.json").exists():
            raise RehearsalError(f"no identity.json in {directory}")
        if not os.environ.get(passphrase_var):
            raise RehearsalError(f"{passphrase_var} is not set")
        self._script = script
        self._directory = directory
        self._passphrase_var = passphrase_var
        self.did = self._run(["did"]).splitlines()[0].strip()

    def _run(self, args: list[str]) -> str:
        environment = dict(os.environ)
        environment["KEYKIT_PASSPHRASE"] = os.environ[self._passphrase_var]
        done = subprocess.run(
            ["node", str(self._script), *args, "--dir", str(self._directory)],
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
            check=False,
            env=environment,
        )
        if done.returncode != 0:
            raise RehearsalError(
                f"keykit failed: {done.stderr.strip() or done.returncode}"
            )
        return done.stdout

    def post(self, room: str, text: str) -> int:
        """Sign `text` into `room` and return the sequence the room assigned.

        :raises RehearsalError: if keykit will not sign it or the room will not take it.
        """
        url = self._run(["say", room, text]).strip().splitlines()[-1]
        if not url.startswith("https://"):
            raise RehearsalError(f"keykit did not print a URL: {url[:80]!r}")
        body = _get(url)
        seqs = [int(n) for n in _MARKER.findall(body)]
        if not seqs:
            raise RehearsalError(
                f"the room answered without a sequence: {body[:160]!r}"
            )
        return max(seqs)



def _get(url: str) -> str:
    request = urllib.request.Request(url, headers={"accept": "text/plain"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:200]
        raise RehearsalError(f"{exc.code} from the room: {detail}") from exc
    except (urllib.error.URLError, OSError) as exc:
        raise RehearsalError(f"could not reach the room: {exc}") from exc


def read_room(room: str) -> list[dict]:
    """Every message currently in `room`, oldest first."""
    url = f"{BASE_URL}/r/{urllib.parse.quote(room, safe='')}?format=json&limit=200"
    try:
        return json.loads(_get(url)).get("messages", [])
    except json.JSONDecodeError as exc:
        raise RehearsalError(f"the room did not answer with JSON: {exc}") from exc


def run(payer: Signer, payee: Signer, room: str) -> dict:
    """The five frames, in order, each read back from the room before the next is sent."""
    now_ms = int(time.time() * 1000)
    hour = 3_600_000
    transcript: dict = {
        "rehearsal": True,
        "why": "both identities are ours; this is not a deal between parties",
        "room": room,
        "payer": payer.did,
        "payee": payee.did,
        "frames": [],
    }

    def send(signer: Signer, frame: dict, label: str) -> None:
        text = frames.encode(frame)
        seq = signer.post(room, text)
        print(f"  {label:8} seq {seq}  {len(text)} chars")
        transcript["frames"].append(
            {"label": label, "seq": seq, "from": signer.did, "frame": frame}
        )
        time.sleep(SETTLE_SECONDS)

    offer = frames.build_offer(
        sender=payer.did,
        role="payer",
        amount="144",
        asset="PAPER",
        rails=["paper"],
        claim_by_ms=now_ms + CLAIM_BY_HOURS * hour,
        refund_after_ms=now_ms + REFUND_AFTER_HOURS * hour,
        expires_ms=now_ms + EXPIRES_HOURS * hour,
        job={"proto": "a2a", "id": f"rehearsal-{now_ms:x}"},
    )
    send(payer, offer, "offer")

    secret, statement = frames.new_secret()
    contract = offer["id"]
    send(
        payee,
        frames.build_accept(
            sender=payee.did, ref=contract, statement=statement, contract=contract
        ),
        "accept",
    )
    send(
        payer,
        frames.build_lock(
            sender=payer.did, contract=contract, rail="paper", ref="rehearsal-escrow"
        ),
        "lock",
    )
    send(
        payee,
        frames.build_reveal(sender=payee.did, contract=contract, secret=secret),
        "reveal",
    )
    send(
        payer,
        frames.build_receipt(
            sender=payer.did, contract=contract, outcome="claimed", rail="paper"
        ),
        "receipt",
    )

    transcript["contract"] = contract
    transcript["secret_matches_statement"] = frames.statement_for(secret) == statement
    return transcript


def verify(transcript: dict) -> list[str]:
    """Read the room back and check every frame we sent is there, decodes, and is ours.

    Returns the problems found; an empty list means the room holds what we believe it holds.
    """
    problems: list[str] = []
    stored = {m.get("seq"): m for m in read_room(transcript["room"])}
    for record in transcript["frames"]:
        message = stored.get(record["seq"])
        if message is None:
            problems.append(
                f"{record['label']}: seq {record['seq']} is not in the room"
            )
            continue
        if message.get("from") != record["from"]:
            problems.append(f"{record['label']}: stored from {message.get('from')}")
        if not message.get("sig"):
            problems.append(f"{record['label']}: the room served no signature")
        try:
            decoded = frames.decode(message.get("text", ""))
        except frames.FrameError as exc:
            problems.append(f"{record['label']}: does not decode — {exc}")
            continue
        if decoded != frames.strip_unset(record["frame"]):
            problems.append(
                f"{record['label']}: the stored frame differs from the one sent"
            )
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--payer", required=True, type=Path)
    parser.add_argument("--payee", required=True, type=Path)
    parser.add_argument(
        "--keykit", type=Path, default=Path("../technocore-keykit/keykit.js")
    )
    parser.add_argument("--room", default=None, help="default: a fresh p- room")
    parser.add_argument("--out", type=Path, default=Path("deals"))
    args = parser.parse_args()

    room = args.room or f"p-tclk-rehearsal-{int(time.time()):x}"
    try:
        payer = Signer(args.keykit, args.payer, "KEYKIT_PASSPHRASE_PAYER")
        payee = Signer(args.keykit, args.payee, "KEYKIT_PASSPHRASE_PAYEE")
        if payer.did == payee.did:
            raise RehearsalError(
                "both sides are the same key; that is not even a rehearsal"
            )
        print(f"room  : {room}")
        print(f"payer : {payer.did}")
        print(f"payee : {payee.did}\n")
        transcript = run(payer, payee, room)
        print("\nreading the room back…")
        problems = verify(transcript)
    except RehearsalError as exc:
        print(f"stopped: {exc}", file=sys.stderr)
        return 1

    transcript["problems"] = problems
    args.out.mkdir(parents=True, exist_ok=True)
    path = args.out / f"rehearsal-{transcript['contract'][2:14]}.json"
    path.write_text(json.dumps(transcript, indent=2), encoding="utf-8")

    print(f"\ncontract : {transcript['contract'][:20]}…")
    print(
        f"secret   : {'matches its statement' if transcript['secret_matches_statement'] else 'DOES NOT MATCH'}"
    )
    for problem in problems:
        print(f"  problem: {problem}")
    print(
        f"{'all five frames are in the room and decode' if not problems else f'{len(problems)} problem(s)'}"
    )
    print(f"transcript: {path}")
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
