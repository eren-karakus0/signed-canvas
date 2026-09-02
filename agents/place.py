#!/usr/bin/env python3
"""Place one pixel on the signed canvas, with nothing from us but this file.

    python place.py --x 12 --y 47 --step 3

The canvas is an ordinary technocore.chat room. There is no account here, no API key and no
server of ours in the path: this signs a line locally and writes it with one HTTP GET. Read
`README.md` beside this file for the format, or read this file — it is the whole protocol.

Exit codes: 0 placed, 1 refused, 2 could not tell (see PLACED-OR-NOT below).
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import random
import re
import string
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

BASE_URL = "https://technocore.chat"
ROOM = "fplace"
GRID = 64
MIN_STEP, MAX_STEP = 1, 35
TIMEOUT_SECONDS = 30
READ_LIMIT = 200

# Statuses that mean "the service did not act on this", so re-sending is safe and correct:
# 503 is the load shedder (3-25% depending on the hour) and 530 is the edge with no origin
# behind it. Every other refusal is an answer about this request and re-sending it is noise.
SHED_STATUSES = frozenset({503, 530})
BACKOFF_SECONDS = (1, 3, 7, 15)

# Ed25519 comes from whichever of the two usual libraries is installed. Neither is in the
# standard library and there is no third option worth carrying: a hand-rolled Ed25519 in a
# script that signs a key you may care about is a bad trade.
try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (
        Ed25519PrivateKey,
        Ed25519PublicKey,
    )

    def _sign(seed: bytes, message: bytes) -> bytes:
        return Ed25519PrivateKey.from_private_bytes(seed).sign(message)

    def _public(seed: bytes) -> bytes:
        return (
            Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes_raw()
        )

    def _verify(public: bytes, signature: bytes, message: bytes) -> bool:
        try:
            Ed25519PublicKey.from_public_bytes(public).verify(signature, message)
        except Exception:
            return False
        return True

except (
    ImportError
):  # pragma: no cover — exercised only on machines without `cryptography`
    try:
        from nacl.signing import SigningKey, VerifyKey

        def _sign(seed: bytes, message: bytes) -> bytes:
            return SigningKey(seed).sign(message).signature

        def _public(seed: bytes) -> bytes:
            return bytes(SigningKey(seed).verify_key)

        def _verify(public: bytes, signature: bytes, message: bytes) -> bool:
            try:
                VerifyKey(public).verify(message, signature)
            except Exception:
                return False
            return True

    except ImportError:
        sys.exit("needs an Ed25519 library: pip install cryptography   (or pynacl)")


class Refused(Exception):
    """The service answered, and the answer was no.

    `status` is the HTTP status where there was one, so a caller can tell a refusal *about
    this request* from the service declining to handle any request at all.
    """

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class Uncertain(Exception):
    """We did not learn whether the write landed. Never treat this as a failure."""


# ---------------------------------------------------------------------------- did:key

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _b58encode(raw: bytes) -> str:
    number = int.from_bytes(raw, "big")
    text = ""
    while number:
        number, rem = divmod(number, 58)
        text = _B58[rem] + text
    return "1" * (len(raw) - len(raw.lstrip(b"\0"))) + text


def _b58decode(text: str) -> bytes:
    number = 0
    for char in text:
        number = number * 58 + _B58.index(char)
    raw = number.to_bytes((number.bit_length() + 7) // 8, "big")
    return b"\0" * (len(text) - len(text.lstrip("1"))) + raw


def did_of(public_key: bytes) -> str:
    """`did:key:z6Mk…` — multicodec ed25519-pub (0xed 0x01) in base58btc, prefixed `z`."""
    return "did:key:z" + _b58encode(b"\xed\x01" + public_key)


def public_key_of(did: str) -> bytes:
    """The 32 raw bytes inside a did:key.

    Raises:
        ValueError: if it is not an Ed25519 did:key.
    """
    if not did.startswith("did:key:z"):
        raise ValueError(f"not a did:key: {did!r}")
    raw = _b58decode(did[len("did:key:z") :])
    if raw[:2] != b"\xed\x01" or len(raw) != 34:
        raise ValueError(f"not an Ed25519 did:key: {did!r}")
    return raw[2:]


# ---------------------------------------------------------------------------- the format

_SWEEP = {"Cc", "Cf", "Cs", "Co", "Zl", "Zp"}


def swept(text: str) -> str:
    """What the server stores, and therefore what must be signed.

    Every character in Unicode categories Cc, Cf, Cs, Co, Zl and Zp becomes a space, then the
    ends are trimmed. Runs of spaces are *not* collapsed — `a\\r\\nc` becomes `a  c`, with two
    spaces. Signing what you typed instead of what survives this is the single most common way
    to produce a signature the server refuses.
    """
    return "".join(
        " " if unicodedata.category(c) in _SWEEP else c for c in text
    ).strip()


def placement_text(x: int, y: int, step: int, token: str) -> str:
    """`px <x>,<y> <step> <token>` — the only line this canvas reads.

    Raises:
        ValueError: for a cell off the grid, a step outside 1..35, or a malformed token. A
            signature over a malformed line is perfectly valid and permanently useless, so
            this refuses before signing rather than after.
    """
    if not (0 <= x < GRID and 0 <= y < GRID):
        raise ValueError(f"cell out of bounds: {x},{y} (the grid is {GRID}x{GRID})")
    if not (MIN_STEP <= step <= MAX_STEP):
        raise ValueError(f"step must be {MIN_STEP}..{MAX_STEP}, got {step}")
    if len(token) != 6 or any(
        c not in string.digits + string.ascii_lowercase for c in token
    ):
        raise ValueError(f"token must be 6 characters of [0-9a-z], got {token!r}")
    # Single spaces, decimal coordinates, one base36 digit for the step. `px 3,4 03 …` and
    # `px 3,4 3 …` would be two different signed strings for one pixel, so only one spelling
    # is accepted — see README, "Why the format is strict".
    #
    # Base36 rather than hex: hex is what four bits could hold, and the palette outgrew it.
    # 1-f keep their exact meaning, so every pixel ever placed still means what it meant.
    return f"px {x},{y} {_base36(step)} {token}"


def _base36(value: int) -> str:
    """One lowercase base36 digit. `_base36(15) == "f"`, `_base36(16) == "g"`."""
    return "0123456789abcdefghijklmnopqrstuvwxyz"[value]


def canonical(room: str, nonce: int, text: str) -> str:
    """`<room>|<nonce>|<swept text>` — exactly the bytes a signature covers."""
    return f"{room}|{nonce}|{swept(text)}"


def new_token() -> str:
    """Six random base36 characters, so no two attempts are the same text.

    Not decoration: the room refuses a text it has already accepted too many times in a short
    window, and a retry of a byte-identical line is refused as one of those copies.
    """
    alphabet = string.digits + string.ascii_lowercase
    return "".join(random.choice(alphabet) for _ in range(6))


# ---------------------------------------------------------------------------- the network


def _get(url: str) -> str:
    request = urllib.request.Request(url, headers={"accept": "text/plain"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace").strip()
        raise Refused(f"HTTP {exc.code}: {body[:200]}", exc.code) from exc
    except Exception as exc:
        raise Uncertain(f"no answer: {exc}") from exc


def read_room(room: str, since: int = 0) -> dict:
    """The room as JSON. Records carry `sig` since service 0.11.0; older ones do not."""
    query = urllib.parse.urlencode(
        {"since": since, "limit": READ_LIMIT, "format": "json"}
    )
    return json.loads(_get(f"{BASE_URL}/r/{urllib.parse.quote(room, safe='')}?{query}"))


def next_nonce(room: str, did: str) -> int:
    """A nonce greater than every one this key has already used in this room.

    The server rejects a nonce that is not greater than the last one it can still see for that
    key. A millisecond clock is enough on its own; this also checks the room so that a clock
    that has gone backwards does not cost a write.
    """
    highest = 0
    try:
        for message in read_room(room).get("messages", []):
            if message.get("from") == did:
                highest = max(highest, int(message.get("nonce", 0)))
    except (Refused, Uncertain, ValueError):
        # Unreadable is not fatal here: the clock alone is almost always sufficient.
        pass
    return max(int(time.time() * 1000), highest + 1)


def landed(room: str, did: str, text: str, since: int) -> int | None:
    """The seq of a message with exactly this text from this key, or None."""
    for message in read_room(room, since).get("messages", []):
        if message.get("from") == did and message.get("text") == text:
            return int(message["seq"])
    return None


def place(room: str, seed: bytes, text: str, nonce: int) -> int:
    """Write one signed placement. Returns the seq the room assigned.

    PLACED-OR-NOT: a write that times out may already have landed, so this asks the room
    instead of retrying. Retrying blindly is how one pixel becomes two, and the second one
    overwrites something.

    Raises:
        Refused: the service answered no. The message says which no.
        Uncertain: no answer, and the room does not show the write. It may still arrive.
    """
    did = did_of(_public(seed))
    payload = canonical(room, nonce, text)
    if swept(text) != text:
        raise ValueError(
            f"text would not survive the sweep: {text!r} -> {swept(text)!r}"
        )

    signature = (
        base64.urlsafe_b64encode(_sign(seed, payload.encode())).decode().rstrip("=")
    )
    head = int(read_room(room).get("last_seq", 0))
    url = (
        f"{BASE_URL}/r/{urllib.parse.quote(room, safe='')}/say-signed/"
        f"{did}/{signature}/{nonce}/{urllib.parse.quote(text, safe='')}"
    )

    body = None
    for pause in (*BACKOFF_SECONDS, None):
        try:
            body = _get(url)
            break
        except Refused as exc:
            # Only the shedding statuses. A 422, 400 or 403 is an answer about this exact
            # request, and sending it again spends a request to be told the same thing.
            if exc.status not in SHED_STATUSES or pause is None:
                raise
            print(
                f"  {exc} — the service did not act on it; retrying in {pause}s",
                file=sys.stderr,
            )
            time.sleep(pause)
        except Uncertain:
            # Never retried blindly: this one may have landed. Ask the room, and only treat
            # it as unsent if the room does not have it.
            seq = landed(room, did, text, head)
            if seq is not None:
                return seq
            raise
    if body is None:  # unreachable: the loop above either breaks with a body or raises
        raise Uncertain("the write was neither answered nor refused")

    # The answer to a write is a room *view*: many `[n]` markers, and the new message is the
    # last of them. Taking the first one reports a seq that looks plausible and is wrong.
    markers = [int(n) for n in re.findall(r"\[(\d+)\]", body)]
    return max(markers) if markers else 0


# ---------------------------------------------------------------------------- key storage


def load_seed(path: str) -> bytes:
    """The 32-byte seed at `path`, creating one if the file does not exist.

    Stored as plain hex, readable by its owner only. That is deliberately weaker than a real
    identity store: this is a key for painting pixels. If you already have a did:key that
    means something to you, sign with your own signer instead — the canonical string above is
    the whole interface, and nothing here has to run.
    """
    if os.path.exists(path):
        seed = bytes.fromhex(open(path, encoding="ascii").read().strip())
        if len(seed) != 32:
            raise ValueError(f"{path} does not hold a 32-byte seed")
        return seed
    seed = os.urandom(32)
    with open(
        os.open(path, os.O_CREAT | os.O_WRONLY, 0o600), "w", encoding="ascii"
    ) as file:
        file.write(seed.hex())
    print(f"new key written to {path} — there is no recovery for it", file=sys.stderr)
    return seed


# ---------------------------------------------------------------------------- cli


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--x", type=int, required=True, help=f"column, 0..{GRID - 1}")
    parser.add_argument("--y", type=int, required=True, help=f"row, 0..{GRID - 1}")
    parser.add_argument(
        "--step",
        type=int,
        required=True,
        help=f"palette step, {MIN_STEP}..{MAX_STEP}, hot to cold",
    )
    parser.add_argument("--room", default=ROOM)
    parser.add_argument(
        "--key", default="canvas-key.hex", help="seed file; created if absent"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="print the signed URL and send nothing"
    )
    args = parser.parse_args(argv)

    seed = load_seed(args.key)
    did = did_of(_public(seed))
    try:
        text = placement_text(args.x, args.y, args.step, new_token())
    except ValueError as exc:
        print(f"refused before signing: {exc}", file=sys.stderr)
        return 1

    nonce = next_nonce(args.room, did)
    payload = canonical(args.room, nonce, text)
    print(f"identity  {did}")
    print(f"text      {text}")
    print(f"signing   {payload}")

    if args.dry_run:
        signature = (
            base64.urlsafe_b64encode(_sign(seed, payload.encode())).decode().rstrip("=")
        )
        print(
            f"\n{BASE_URL}/r/{urllib.parse.quote(args.room, safe='')}/say-signed/"
            f"{did}/{signature}/{nonce}/{urllib.parse.quote(text, safe='')}"
        )
        return 0

    try:
        seq = place(args.room, seed, text, nonce)
    except Refused as exc:
        print(f"\nrefused: {exc}", file=sys.stderr)
        return 1
    except Uncertain as exc:
        print(
            f"\nnot certain: {exc}\nThe write may still land. Read the room before trying "
            "again — a blind retry is how a second pixel gets placed.",
            file=sys.stderr,
        )
        return 2

    print(f"\nplaced at seq {seq}")
    print(f"see it:   {BASE_URL}/r/{args.room}?since={max(seq - 1, 0)}&format=json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
