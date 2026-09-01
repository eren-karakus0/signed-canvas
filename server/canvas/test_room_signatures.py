"""Signatures that arrive *with* the room read.

technocore.chat 0.11.0 (2026-08-31) began serving ``sig`` on every signed record, on the same
``?since=`` path the ingest loop already reads. That is the field these tests are about, and
the reason they exist is that believing it would be the easy mistake: the room is
world-writable, so ``sig`` is anonymous input like everything else beside it. The archive
verifies it here or records nothing.

The adversarial case is the third test. A signature that is real, canonical, and made by the
very key that sent the message — but over a *different* message — is the one a length check,
a format check or a "did the server accept it" check all wave through. Only rebuilding this
message's payload and checking against that catches it.
"""

from __future__ import annotations

import base64
import tempfile
import unittest
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from archive import Archive, ArchiveError
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


class RoomServedSignatures(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "canvas.db"
        self.key = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
        self.did = _did_of(self.key)

    def tearDown(self) -> None:
        self.dir.cleanup()

    # ---------------------------------------------------------------- helpers

    def _message(self, seq: int, cx: int, cy: int, step: int, nonce: int) -> dict:
        return {
            "seq": seq,
            "ts": "2026-09-01T00:00:00.000000Z",
            "from": self.did,
            "text": f"px {cx},{cy} {step:x} {seq:06x}",
            "nonce": nonce,
        }

    def _sig_for(self, text: str, nonce: int, room: str = ROOM) -> str:
        payload = message_payload(room, nonce, text)
        return (
            base64.urlsafe_b64encode(self.key.sign(payload.encode()))
            .decode()
            .rstrip("=")
        )

    def _signed(self, message: dict) -> dict:
        return {**message, "sig": self._sig_for(message["text"], message["nonce"])}

    def _rows(self) -> list:
        with Archive(self.path) as archive:
            archive.room = ROOM
            return archive.since(0)

    def _apply(self, messages: list[dict]) -> None:
        with Archive(self.path) as archive:
            archive.room = ROOM
            archive.apply_batch(messages)

    # ---------------------------------------------------------------- the good case

    def test_a_signature_served_with_the_message_witnesses_it(self) -> None:
        self._apply([self._signed(self._message(1, 3, 4, 7, 500))])
        (row,) = self._rows()
        self.assertTrue(row.witnessed)
        self.assertEqual(row.sig, self._sig_for("px 3,4 7 000001", 500))

    def test_a_message_with_no_signature_is_still_stored_attested(self) -> None:
        # Every record written before 0.11.0 looks like this, permanently. Missing is
        # "not re-verifiable", never "invalid" — the placement is in the room regardless.
        self._apply([self._message(1, 3, 4, 7, 500)])
        (row,) = self._rows()
        self.assertFalse(row.witnessed)
        self.assertIsNone(row.sig)

    # ---------------------------------------------------------------- the adversarial cases

    def test_a_valid_signature_over_a_different_message_does_not_witness(self) -> None:
        """The one a format check cannot catch.

        This signature is genuine: canonical, 86 characters, made by the key that really sent
        the message. It just covers a different placement. Anything short of rebuilding *this*
        message's payload accepts it, and the pixel would then claim to be provable.
        """
        message = self._message(1, 3, 4, 7, 500)
        message["sig"] = self._sig_for("px 60,60 1 zzzzzz", 500)
        self._apply([message])
        (row,) = self._rows()
        self.assertFalse(row.witnessed)
        self.assertIsNone(row.sig)

    def test_a_signature_for_another_room_does_not_witness(self) -> None:
        # The room name is inside the signed payload, so a record lifted from a different
        # canvas must not verify here.
        message = self._message(1, 3, 4, 7, 500)
        message["sig"] = self._sig_for(message["text"], 500, room="p-somewhere-else")
        self._apply([message])
        (row,) = self._rows()
        self.assertFalse(row.witnessed)

    def test_a_signature_for_another_nonce_does_not_witness(self) -> None:
        message = self._message(1, 3, 4, 7, 500)
        message["sig"] = self._sig_for(message["text"], 501)
        self._apply([message])
        (row,) = self._rows()
        self.assertFalse(row.witnessed)

    def test_malformed_signatures_leave_the_row_attested_without_losing_it(
        self,
    ) -> None:
        # Wrong type, wrong length, not base64, empty. None of these may cost us the
        # placement: it is in the room whatever the field beside it says.
        for bad in (12345, "", "not-base64!!", "AAAA", ["a"], None):
            with self.subTest(sig=bad):
                self.dir.cleanup()
                self.dir = tempfile.TemporaryDirectory()
                self.path = Path(self.dir.name) / "canvas.db"
                message = self._message(1, 3, 4, 7, 500)
                message["sig"] = bad
                self._apply([message])
                (row,) = self._rows()
                self.assertFalse(row.witnessed)
                self.assertEqual((row.cx, row.cy, row.step), (3, 4, 7))

    def test_one_bad_signature_does_not_cost_the_rest_of_the_batch(self) -> None:
        good = self._signed(self._message(1, 3, 4, 7, 500))
        bad = self._message(2, 5, 6, 2, 501)
        bad["sig"] = "AAAA"
        also_good = self._signed(self._message(3, 7, 8, 4, 502))
        self._apply([good, bad, also_good])
        rows = {row.seq: row for row in self._rows()}
        self.assertEqual(len(rows), 3)
        self.assertTrue(rows[1].witnessed)
        self.assertFalse(rows[2].witnessed)
        self.assertTrue(rows[3].witnessed)

    # ---------------------------------------------------------------- backfill

    def test_a_row_archived_before_signatures_gains_one_when_read_again(self) -> None:
        """The upgrade path for everything already in the archive.

        Rows landed while the service served no signature. Re-reading the room must be able
        to fill that in — otherwise the only way to witness the existing canvas would be to
        rebuild the archive from scratch.
        """
        message = self._message(1, 3, 4, 7, 500)
        self._apply([message])
        self.assertFalse(self._rows()[0].witnessed)

        self._apply([self._signed(message)])
        (row,) = self._rows()
        self.assertTrue(row.witnessed)

    def test_backfill_never_downgrades_a_signature_we_already_verified(self) -> None:
        message = self._message(1, 3, 4, 7, 500)
        self._apply([self._signed(message)])
        self.assertTrue(self._rows()[0].witnessed)

        # The same message read again, this time with the field absent (a cache, an older
        # replica, a re-export). What we proved does not become unproven.
        self._apply([message])
        (row,) = self._rows()
        self.assertTrue(row.witnessed)

    def test_backfill_refuses_a_signature_that_does_not_verify(self) -> None:
        message = self._message(1, 3, 4, 7, 500)
        self._apply([message])
        message["sig"] = self._sig_for("px 60,60 1 zzzzzz", 500)
        self._apply([message])
        self.assertFalse(self._rows()[0].witnessed)

    def test_re_reading_does_not_duplicate_or_move_a_placement(self) -> None:
        message = self._signed(self._message(1, 3, 4, 7, 500))
        self._apply([message])
        self._apply([message])
        rows = self._rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0].cx, rows[0].cy, rows[0].step), (3, 4, 7))

    # ---------------------------------------------------------------- misconfiguration

    def test_a_signature_with_no_room_recorded_is_an_error_not_a_silent_demotion(
        self,
    ) -> None:
        """A wrong or missing room fails every signature identically to a forged one.

        Left quiet, that turns a configuration slip into "this canvas is unprovable", which
        looks exactly like the product working. It has to be loud.
        """
        with Archive(self.path) as archive:
            with self.assertRaises(ArchiveError):
                archive.apply_batch([self._signed(self._message(1, 3, 4, 7, 500))])

    def test_an_unsigned_batch_needs_no_room_at_all(self) -> None:
        # The corollary: an archive that never sees a signature never needs the room, which
        # is what keeps the older tests honest rather than incidentally passing.
        with Archive(self.path) as archive:
            stored, _ = archive.apply_batch([self._message(1, 3, 4, 7, 500)])
        self.assertEqual(stored, 1)


if __name__ == "__main__":
    unittest.main()
