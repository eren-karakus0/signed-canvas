"""Building and reading `tclk1` frames.

A frame is the six characters ``tclk1 `` followed by one canonically serialized JSON object:
keys sorted, ``,``/``:`` separators only, keys with no value dropped, every non-ASCII
character ``\\uXXXX``-escaped. That is exactly what ``json.dumps`` produces with
``sort_keys=True``, ``separators=(",", ":")`` and ``ensure_ascii=True``, which is why this
module does not hand-roll a serializer.

The contract id is where two conforming implementations most easily disagree, and the spec
says so in as many words: it is sha256 over the **escaped** bytes — the same bytes that go on
the wire — not over the pre-escape string. For an ASCII-only frame the two are identical,
which is precisely what makes the mistake survive testing.

Decoding is fail-closed. An unknown key, a missing field or a malformed value is refused and
never coerced, because a frame is text a stranger wrote and the next thing that happens is a
state machine acting on it.

One trap worth naming: a frame's ``nonce`` is **not** technocore's signing nonce. Here it is
8-64 lowercase hex characters of randomness that makes the contract id unique; there it is an
increasing decimal the room uses to reject replays. They are different fields in different
layers and swapping them produces a frame the schema rejects.

Nothing here talks to the network. Signing and posting belong to the caller.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
from typing import Any

#: The version prefix. An incompatible revision changes this, never the field semantics.
PREFIX = "tclk1 "

#: Domain separators for the two ids, from SPEC.md §3.1 and §3.2. They are different ids:
#: an offer has one from the moment it is built, and the *contract* comes into existence
#: only when somebody accepts, binding the offer and that acceptance together.
OFFER_DOMAIN = "FLOP::tclk::v1|offer|"
CONTRACT_DOMAIN = "FLOP::tclk::v1|contract|"

#: The acceptance fields the contract id binds. `paymentKey` only appears for point locks.
ACCEPT_CORE = ("ref", "from", "statement", "paymentKey", "nonce")

FRAME_TYPES = frozenset(
    {"offer", "accept", "lock", "reveal", "refund", "cancel", "receipt", "heartbeat"}
)

_DID = re.compile(r"^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$")
_HEX32 = re.compile(r"^0x[0-9a-f]{64}$")
_FRAME_NONCE = re.compile(r"^[0-9a-f]{8,64}$")
_AMOUNT = re.compile(r"^[1-9][0-9]*$")
_RAIL = re.compile(r"^(?:[a-z0-9][a-z0-9._-]{0,63}|PaperRail)$")
_PROTO = re.compile(r"^[a-z0-9][a-z0-9._-]{0,31}$")

#: Bytes of randomness behind a frame nonce and a hash-lock secret. 32 is what the spec's
#: `hex32` shape requires of a secret; the nonce only has to be unique, and reusing the size
#: keeps one constant instead of two.
SECRET_BYTES = 32


class FrameError(ValueError):
    """A frame could not be built, or could not be trusted enough to decode."""


def canonical(frame: dict[str, Any]) -> str:
    """The canonical JSON for a frame body, without the ``tclk1 `` prefix.

    :raises FrameError: if the object holds a value JSON cannot represent.
    """
    try:
        return json.dumps(
            frame, sort_keys=True, separators=(",", ":"), ensure_ascii=True
        )
    except (TypeError, ValueError) as exc:
        raise FrameError(f"frame is not serializable: {exc}") from exc


def encode(frame: dict[str, Any]) -> str:
    """A frame as it goes on the wire.

    The sweep technocore.chat applies before storage replaces control and format characters
    with spaces, so a frame carrying one would be signed as one thing and stored as another.
    Canonical JSON with ``ensure_ascii`` escapes all of them — measured across 0x00-0x1F,
    0x7F, 0x85, U+200B, U+2028 and U+2029: none survives raw. The body is therefore printable
    ASCII and the sweep has nothing to change.

    What is checked is that property itself, not its consequence. If someone ever relaxes
    ``ensure_ascii`` for prettier output this fires, instead of the room quietly storing text
    that no longer matches the signature.

    :raises FrameError: if the encoded body is not printable ASCII.
    """
    body = canonical(strip_unset(frame))
    if not all(0x20 <= ord(char) < 0x7F for char in body):
        raise FrameError(
            "encoded frame is not printable ASCII; the room's sweep would alter it"
        )
    return PREFIX + body


def strip_unset(frame: dict[str, Any]) -> dict[str, Any]:
    """The frame without keys that carry no value.

    The spec drops `undefined`-valued keys before serializing. Python has no `undefined`, so
    `None` stands in for it — and because no tclk field is legitimately null, dropping is
    always the right reading.
    """
    return {key: value for key, value in frame.items() if value is not None}


def new_nonce() -> str:
    """A fresh frame nonce: lowercase hex, unique, not an increasing counter."""
    return secrets.token_hex(SECRET_BYTES // 4)


def new_secret() -> tuple[str, str]:
    """A hash-lock preimage and its statement, both ``0x`` + 64 lowercase hex.

    The payee mints this. It proves nothing about work delivered — revealing it is how funds
    are claimed, and a payee who did nothing can still reveal. That is a property of the lock,
    stated here so nobody reading this function believes otherwise.
    """
    preimage = secrets.token_bytes(SECRET_BYTES)
    return "0x" + preimage.hex(), "0x" + hashlib.sha256(preimage).hexdigest()


def statement_for(secret: str) -> str:
    """The hash statement a secret satisfies.

    :raises FrameError: if `secret` is not 0x-prefixed 32-byte hex.
    """
    if not _HEX32.match(secret):
        raise FrameError(f"a secret must be 0x + 64 lowercase hex, got {secret[:12]!r}")
    return "0x" + hashlib.sha256(bytes.fromhex(secret[2:])).hexdigest()


def contract_id(offer: dict[str, Any]) -> str:
    """The contract id for an offer: sha256 over the canonical JSON without ``id``.

    Hashed over the ASCII-escaped bytes — the ones `encode` puts on the wire. Hashing the
    pre-escape string instead makes two conforming implementations disagree on the id of any
    frame carrying a non-ASCII character, and every later frame names the contract by it.
    """
    without_id = {key: value for key, value in offer.items() if key != "id"}
    payload = OFFER_DOMAIN + canonical(strip_unset(without_id))
    return "0x" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def contract_id_from_accept(offer: dict[str, Any], accept: dict[str, Any]) -> str:
    """The contract id an accept creates, binding the full offer to that acceptance.

    Not the offer id. An offer has an id from the moment it is built; a *contract* exists only
    once somebody accepts, and every frame after the accept names it by this. Getting the two
    confused produces `lock`, `reveal` and `receipt` frames that name something the
    counterparty has never heard of — which is what this project did until a live counterparty
    proved otherwise.

    The spec describes the payload as ``canonical {offer, accept-core}``; the key on the wire
    is ``accept``, not ``accept-core``. Verified by recomputing the ids of conforming accepts
    taken from the live room — prose settles nothing that bytes can settle.

    :raises FrameError: if the offer or the acceptance is missing what the id binds.
    """
    core = {key: accept[key] for key in ACCEPT_CORE if key in accept and accept[key] is not None}
    for required in ("ref", "from", "statement", "nonce"):
        if required not in core:
            raise FrameError(f"an acceptance binds {required}, and this one has none")
    payload = CONTRACT_DOMAIN + canonical({"accept": core, "offer": strip_unset(offer)})
    return "0x" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def build_offer(
    *,
    sender: str,
    role: str,
    amount: str,
    asset: str,
    rails: list[str],
    claim_by_ms: int,
    refund_after_ms: int,
    expires_ms: int,
    job: dict[str, str] | None = None,
    lock: str = "hash",
) -> dict[str, Any]:
    """An `offer` frame, with its id computed last.

    Deadlines are checked here rather than left to the counterparty: ``claimByMs`` must be
    strictly before ``refundAfterMs``, and the gap between them is the payee's safe window to
    claim in. An offer that inverts them is one no careful payee should accept, so it is not
    one this project should be able to send by accident.

    :raises FrameError: if any field is malformed or the deadlines do not order.
    """
    if role not in ("payer", "payee"):
        raise FrameError(f"role must be payer or payee, got {role!r}")
    if lock != "hash":
        raise FrameError(
            "only hash locks are built here: tclk calls its point-lock crypto unaudited "
            "reference crypto, full-Schnorr with random nonces"
        )
    if not _AMOUNT.match(amount):
        raise FrameError(
            f"amount must be a positive decimal integer string, got {amount!r}"
        )
    if not rails or not all(isinstance(r, str) and _RAIL.match(r) for r in rails):
        raise FrameError(f"rails must be a non-empty list of rail ids, got {rails!r}")
    if not (isinstance(claim_by_ms, int) and isinstance(refund_after_ms, int)):
        raise FrameError("deadlines must be integer milliseconds")
    if not claim_by_ms < refund_after_ms:
        raise FrameError(
            f"claimByMs ({claim_by_ms}) must be strictly before refundAfterMs "
            f"({refund_after_ms}); the gap is the payee's claim window"
        )
    if job is not None:
        if not isinstance(job, dict) or set(job) - {"proto", "id", "context"}:
            raise FrameError(
                f"job may only carry proto, id and context, got {sorted(job)}"
            )
        if not _PROTO.match(str(job.get("proto", ""))) or not str(job.get("id", "")):
            raise FrameError(f"job needs a proto and a non-empty id, got {job!r}")

    offer: dict[str, Any] = {
        "type": "offer",
        "from": _valid_did(sender),
        "role": role,
        "amount": amount,
        "asset": asset,
        "lock": lock,
        # Lexical order with duplicates removed, before the id is computed: the array's order
        # is not meaningful but it is part of the bytes the id hashes.
        "rails": sorted(set(rails)),
        "claimByMs": claim_by_ms,
        "refundAfterMs": refund_after_ms,
        "expiresMs": expires_ms,
        "nonce": new_nonce(),
        "job": job,
    }
    offer["id"] = contract_id(offer)
    return offer


def build_accept(
    *, sender: str, ref: str, statement: str, contract: str
) -> dict[str, Any]:
    """An `accept` frame. The payee supplies the statement and closes the terms.

    ``ref`` here is a **hex32**, not the free string it is everywhere else. The schema is the
    authority on that and the prose is not: in `lock`, `reveal`, `refund` and `receipt` the
    same field name carries a rail-side transaction reference of any shape, and only here does
    it name the offer. Built from the prose alone, this frame is one the decoder rejects.
    """
    return {
        "type": "accept",
        "from": _valid_did(sender),
        "ref": _checked(ref, _HEX32, "ref", "0x + 64 lowercase hex (the offer it answers)"),
        "statement": _checked(statement, _HEX32, "statement", "0x + 64 lowercase hex"),
        "contract": _checked(contract, _HEX32, "contract", "0x + 64 lowercase hex"),
        "nonce": new_nonce(),
    }


def accept_offer(*, sender: str, offer: dict[str, Any], statement: str) -> dict[str, Any]:
    """An `accept` with its contract id derived rather than guessed.

    The two-step version above lets a caller pass any contract; this one computes it from the
    offer being accepted, which is what the protocol requires and what a counterparty will
    recompute on the other side.
    """
    core = {
        "type": "accept",
        "from": _valid_did(sender),
        "ref": _checked(offer["id"], _HEX32, "ref", "the offer id"),
        "statement": _checked(statement, _HEX32, "statement", "0x + 64 lowercase hex"),
        "nonce": new_nonce(),
    }
    core["contract"] = contract_id_from_accept(offer, core)
    return core


def build_lock(*, sender: str, contract: str, rail: str, ref: str) -> dict[str, Any]:
    """A `lock` frame: the payer says funds are escrowed on the named rail."""
    return {
        "type": "lock",
        "from": _valid_did(sender),
        "contract": _checked(contract, _HEX32, "contract", "0x + 64 lowercase hex"),
        "rail": _checked(rail, _RAIL, "rail", "a registered rail id"),
        # Free-form here: the rail's own reference for the escrow, in whatever shape it uses.
        "ref": _nonempty(ref, "ref"),
    }


def build_reveal(*, sender: str, contract: str, secret: str) -> dict[str, Any]:
    """A `reveal` frame: the payee publishes the preimage and claims."""
    return {
        "type": "reveal",
        "from": _valid_did(sender),
        "contract": _checked(contract, _HEX32, "contract", "0x + 64 lowercase hex"),
        "secret": _checked(secret, _HEX32, "secret", "0x + 64 lowercase hex"),
    }


def build_refund(
    *, sender: str, contract: str, reason: str | None = None, ref: str | None = None
) -> dict[str, Any]:
    """A `refund` frame: the payer takes its escrow back after the deadline passed."""
    return {
        "type": "refund",
        "from": _valid_did(sender),
        "contract": _checked(contract, _HEX32, "contract", "0x + 64 lowercase hex"),
        "reason": _nonempty(reason, "reason") if reason is not None else None,
        "ref": _nonempty(ref, "ref") if ref is not None else None,
    }


def build_receipt(
    *,
    sender: str,
    contract: str,
    outcome: str,
    rail: str | None = None,
    ref: str | None = None,
) -> dict[str, Any]:
    """A `receipt` frame: what actually happened, after a terminal state."""
    if outcome not in ("claimed", "refunded", "cancelled"):
        raise FrameError(
            f"outcome must be claimed, refunded or cancelled, got {outcome!r}"
        )
    return {
        "type": "receipt",
        "from": _valid_did(sender),
        "contract": _checked(contract, _HEX32, "contract", "0x + 64 lowercase hex"),
        "outcome": outcome,
        "rail": rail,
        "ref": ref,
    }


def decode(text: str) -> dict[str, Any]:
    """Read one frame from room text.

    :raises FrameError: if the text is not a tclk/1 frame, is not one object, or names a
        frame type this version does not know.
    """
    if not text.startswith(PREFIX):
        raise FrameError("not a tclk1 frame")
    try:
        frame = json.loads(text[len(PREFIX) :])
    except json.JSONDecodeError as exc:
        raise FrameError(f"frame body is not JSON: {exc}") from exc
    if not isinstance(frame, dict):
        raise FrameError(f"frame body must be one object, got {type(frame).__name__}")

    kind = frame.get("type")
    if kind not in FRAME_TYPES:
        raise FrameError(f"unknown frame type {kind!r}")
    _valid_did(frame.get("from"))
    return frame


def _nonempty(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise FrameError(f"{field} must be a non-empty string, got {value!r}")
    return value


def _valid_did(value: Any) -> str:
    if not isinstance(value, str) or not _DID.match(value):
        raise FrameError(f"from must be a did:key Ed25519 identifier, got {value!r}")
    return value


def _checked(value: Any, pattern: re.Pattern[str], field: str, label: str) -> str:
    if not isinstance(value, str) or not pattern.match(value):
        raise FrameError(f"{field} must be {label}, got {value!r}")
    return value
