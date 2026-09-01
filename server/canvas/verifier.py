"""The signed lane, server side.

This is the second implementation of the same three rules the browser verifier implements
(`src/crypto/`). ADR 0001 accepted that cost knowingly: both are held to the same published
fixture, and `npm run check` plus `test_verifier.py` fail if they ever drift apart.

Nothing here reaches the network. It is pure functions over bytes so that the ingest loop can
be tested without a server and the fixture can be run without a room.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

__all__ = [
    "VerifierError",
    "SweepError",
    "DidError",
    "MAX_TEXT_CHARS",
    "DID_PATTERN",
    "SIGNATURE_PATTERN",
    "swept",
    "public_key_of",
    "fingerprint_of",
    "message_payload",
    "note_payload",
    "verify_payload",
]


class VerifierError(Exception):
    """Base for every refusal in this module."""


class SweepError(VerifierError):
    """The text would not survive the server's single-line sweep."""


class DidError(VerifierError):
    """Not an Ed25519 ``did:key``."""


MAX_TEXT_CHARS = 4096

# The six Unicode general categories the server replaces with a space.
INVISIBLE_CATEGORIES = frozenset({"Cc", "Cf", "Cs", "Co", "Zl", "Zp"})

DID_PATTERN = re.compile(r"^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$")
SIGNATURE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{86}$")
NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")
NONCE_PATTERN = re.compile(r"^[0-9]{1,19}$")

_BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_MULTICODEC_ED25519_PUB = b"\xed\x01"
_PUBLIC_KEY_BYTES = 32
_FINGERPRINT_HEX_CHARS = 16
_SIGNATURE_BYTES = 64


def swept(text: str, limit: int = MAX_TEXT_CHARS) -> str:
    """The text as the server stores it: invisibles become spaces, then the ends are trimmed.

    Every swept character becomes its own space; runs are never collapsed. Collapsing looks
    like tidying up and produces a signature over a string the server never stored.

    Raises:
        SweepError: if nothing visible survives, or the result exceeds ``limit``.
    """
    cleaned = "".join(
        " " if unicodedata.category(ch) in INVISIBLE_CATEGORIES else ch
        for ch in str(text)
    ).strip()
    if not cleaned:
        raise SweepError(
            "nothing visible survives the sweep — the server refuses that write"
        )
    if len(cleaned) > limit:
        raise SweepError(
            f"{len(cleaned)} characters after the sweep, over the {limit} cap"
        )
    return cleaned


def _base58_decode(text: str) -> bytes:
    number = 0
    for character in text:
        digit = _BASE58.find(character)
        if digit < 0:
            raise DidError(f"{character!r} is not a base58btc character")
        number = number * 58 + digit
    body = number.to_bytes((number.bit_length() + 7) // 8, "big") if number else b""
    leading_zeros = len(text) - len(text.lstrip(_BASE58[0]))
    return b"\x00" * leading_zeros + body


def public_key_of(did: str) -> Ed25519PublicKey:
    """The Ed25519 public key a ``did:key`` carries.

    Raises:
        DidError: if the string is not an Ed25519 ``did:key``.
    """
    if not DID_PATTERN.match(did):
        raise DidError(
            f"bad did:key: expected did:key:z6Mk + 44 base58btc characters, got {did!r}"
        )
    decoded = _base58_decode(did[len("did:key:z") :])
    if len(decoded) != len(_MULTICODEC_ED25519_PUB) + _PUBLIC_KEY_BYTES:
        raise DidError(f"bad did:key: decodes to {len(decoded)} bytes, expected 34")
    if not decoded.startswith(_MULTICODEC_ED25519_PUB):
        raise DidError("bad did:key: only ed25519-pub (0xed01) is accepted")
    return Ed25519PublicKey.from_public_bytes(decoded[len(_MULTICODEC_ED25519_PUB) :])


def fingerprint_of(did: str) -> str:
    """The 16-hex handle a ``did:key`` is filed under.

    SHA-256 of the *did string*, not of the key bytes. Hashing the key produces a
    plausible-looking handle that indexes nothing.

    Raises:
        DidError: if the string is not an Ed25519 ``did:key``.
    """
    if not DID_PATTERN.match(did):
        raise DidError(f"not an Ed25519 did:key: {did!r}")
    return hashlib.sha256(did.encode("utf-8")).hexdigest()[:_FINGERPRINT_HEX_CHARS]


def _require_name(value: str, label: str) -> str:
    text = str(value).strip()
    if not NAME_PATTERN.match(text):
        raise VerifierError(f"{label} must match {NAME_PATTERN.pattern} — got {text!r}")
    return text


def _require_nonce(value: int | str) -> str:
    text = str(value).strip()
    if not NONCE_PATTERN.match(text):
        raise VerifierError(f"nonce must be 1-19 decimal digits — got {value!r}")
    return text


def message_payload(
    room: str, nonce: int | str, text: str, limit: int = MAX_TEXT_CHARS
) -> str:
    """``<room>|<nonce>|<swept text>`` — what a signed room message signs.

    Raises:
        VerifierError: for a bad room name or nonce.
        SweepError: if the text would not survive the sweep.
    """
    return f"{_require_name(room, 'room')}|{_require_nonce(nonce)}|{swept(text, limit)}"


def note_payload(
    namespace: str, key: str, nonce: int | str, value: str, limit: int = MAX_TEXT_CHARS
) -> str:
    """``<ns>|<key>|<nonce>|<swept value>`` — what a signed note write signs.

    Raises:
        VerifierError: for a bad namespace, key or nonce.
        SweepError: if the value would not survive the sweep.
    """
    return "|".join(
        (
            _require_name(namespace, "namespace"),
            _require_name(key, "key"),
            _require_nonce(nonce),
            swept(value, limit),
        )
    )


def _decode_signature(signature: str) -> bytes:
    """86 base64url characters to 64 bytes.

    The last character carries only two significant bits — 86 characters hold 516 bits and a
    signature is 512 — so sixteen spellings decode to the same signature and the server
    accepts all of them. The surplus bits are discarded, which is what makes them equivalent.
    """
    if not SIGNATURE_PATTERN.match(signature):
        raise VerifierError(
            f"signature must be 86 base64url characters, got {len(signature)}"
        )
    import base64

    raw = base64.urlsafe_b64decode(signature + "==")
    return raw[:_SIGNATURE_BYTES]


def verify_payload(did: str, signature: str, payload: str) -> bool:
    """Does ``signature`` prove that the holder of ``did`` signed ``payload``?

    Returns False for a signature that does not verify. Raises only when the *inputs* are
    malformed, because those are caller bugs and returning False would hide them.

    Raises:
        DidError: for a malformed DID.
        VerifierError: for a malformed signature.
    """
    key = public_key_of(did)
    raw = _decode_signature(signature)
    try:
        key.verify(raw, payload.encode("utf-8"))
    except InvalidSignature:
        return False
    return True
