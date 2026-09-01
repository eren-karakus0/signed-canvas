"""Signatures that arrive before their placement does.

This is the case that made witnessing unreachable in practice: the relay holds a signature
milliseconds after the write, the ingest loop has not read that message back yet, so there
was no row to attach it to and it was dropped. Every unit test passed and no browser
placement was ever witnessed.

The tests below assert the order that actually happens in production — signature first,
placement second — which is the order the original code could not handle.
"""

from __future__ import annotations

import base64
import tempfile
import unittest
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from archive import Archive
from verifier import message_payload

ROOM = "p-canvas-test"


def _did_of(key: Ed25519PrivateKey) -> str:
    raw = b"\xed\x01" + key.public_key().public_bytes_raw()
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    number = int.from_bytes(raw, "big")
    text = ""
    while number:
        number, rem = divmod(number, 58)
        text = alphabet[rem] + text
    return "did:key:z" + text


class PendingSignatures(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "canvas.db"
        self.key = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
        self.did = _did_of(self.key)

    def tearDown(self) -> None:
        self.dir.cleanup()

    def _message(self, seq: int, cx: int, cy: int, step: int, nonce: int) -> dict:
        return {
            "seq": seq,
            "ts": "2026-08-29T00:00:00.000000Z",
            "from": self.did,
            "text": f"px {cx},{cy} {step:x} {seq:06x}",
            "nonce": nonce,
        }

    def _sign(self, message: dict) -> str:
        payload = message_payload(ROOM, message["nonce"], message["text"])
        return (
            base64.urlsafe_b64encode(self.key.sign(payload.encode()))
            .decode()
            .rstrip("=")
        )

    def test_a_signature_parked_before_ingest_is_applied_when_the_row_lands(
        self,
    ) -> None:
        message = self._message(1, 3, 4, 7, 500)
        with Archive(self.path) as archive:
            archive.room = ROOM
            archive.remember_signature(1, self._sign(message))
            self.assertEqual(archive.pending_signatures, 1)
            self.assertEqual(archive.stats().witnessed, 0)

            archive.apply_batch([message])

            self.assertEqual(
                archive.stats().witnessed, 1, "ingest must attach the parked signature"
            )
            self.assertEqual(
                archive.pending_signatures, 0, "an applied signature is not kept"
            )
            self.assertTrue(archive.since(0)[0].witnessed)

    def test_a_parked_signature_for_the_wrong_message_is_discarded_not_attached(
        self,
    ) -> None:
        real = self._message(1, 3, 4, 7, 500)
        other = self._message(2, 9, 9, 2, 999)
        with Archive(self.path) as archive:
            archive.room = ROOM
            archive.remember_signature(
                1, self._sign(other)
            )  # valid, but for another message
            archive.apply_batch([real])
            self.assertEqual(archive.stats().witnessed, 0)
            self.assertEqual(
                archive.pending_signatures,
                0,
                "a failed signature must not be retried forever",
            )

    def test_parking_twice_keeps_the_later_signature(self) -> None:
        message = self._message(1, 3, 4, 7, 500)
        with Archive(self.path) as archive:
            archive.room = ROOM
            archive.remember_signature(1, "A" * 86)
            archive.remember_signature(1, self._sign(message))
            self.assertEqual(archive.pending_signatures, 1)
            archive.apply_batch([message])
            self.assertEqual(archive.stats().witnessed, 1)

    def test_parked_signatures_survive_a_restart(self) -> None:
        message = self._message(1, 3, 4, 7, 500)
        with Archive(self.path) as archive:
            archive.room = ROOM
            archive.remember_signature(1, self._sign(message))
        # A new process, as after a deploy or a crash between the write and the ingest.
        with Archive(self.path) as archive:
            self.assertEqual(archive.pending_signatures, 1)
            archive.apply_batch([message])
            self.assertEqual(archive.stats().witnessed, 1)

    def test_an_unrelated_batch_leaves_the_parked_signature_alone(self) -> None:
        mine = self._message(5, 1, 1, 3, 700)
        with Archive(self.path) as archive:
            archive.room = ROOM
            archive.remember_signature(5, self._sign(mine))
            archive.apply_batch([self._message(1, 8, 8, 4, 100)])
            self.assertEqual(
                archive.pending_signatures, 1, "another message must not consume it"
            )
            archive.apply_batch([mine])
            self.assertEqual(archive.stats().witnessed, 1)

    def test_health_reports_the_queue(self) -> None:
        with Archive(self.path) as archive:
            archive.room = ROOM
            archive.remember_signature(1, "A" * 86)
            self.assertEqual(archive.stats().pending, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
