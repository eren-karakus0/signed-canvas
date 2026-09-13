"""Crash safety, and an honest statement of how far it is actually proven.

The task's acceptance is "a killed and restarted archiver loses no accepted write".
``KillMidStream`` does that literally: it SIGKILLs a writer mid-stream — uncatchable, no
shutdown hook, no flush on the way out — and asks the reopened archive what survived.

WHAT THIS PROVES
    Batch atomicity, and no loss to a *process* crash. A kill cannot leave the cursor past a
    placement that was never stored, or a placement stored with the cursor unmoved.

WHAT IT DOES NOT PROVE, checked rather than assumed
    It does not test ``PRAGMA synchronous``. The test was re-run with ``synchronous=OFF`` and
    still passed, because the OS page cache outlives the process — only losing the *machine*
    exercises the difference between OFF, NORMAL and FULL.

    So FULL is set for the machine-loss case and is not verified here. Verifying it needs a
    hard power cut or a VM stopped without flushing, and neither is available from a test
    process. ``SynchronousSetting`` below is the weaker guard that remains available: it
    fails if someone quietly lowers the pragma, which is the realistic way the property would
    be lost.

    Claiming RPO = 0 on the strength of the kill test alone would have been overclaiming, and
    the archive is the only durable copy of a placement — the room itself reports
    ``fsync: false``.
"""

from __future__ import annotations

import json
import os
import random
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

from archive import Archive, ArchiveError
from placement import COLS, parse
from verifier import message_payload

HERE = Path(__file__).resolve().parent
ROOM = "p-canvas-test"


def _message(seq: int, did: str, cx: int, cy: int, step: int, nonce: int) -> dict:
    return {
        "seq": seq,
        "ts": f"2026-08-29T00:00:{seq % 60:02d}.000000Z",
        "from": did,
        "text": f"px {cx},{cy} {step:x} {seq:06x}",
        "nonce": nonce,
    }


DID_A = "did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX"
DID_B = "did:key:z6MkeXCT2bbYPVr8zoLJxVTfcdZPeBGnx8Fw23Mrk88FqGKa"


class BatchSemantics(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "canvas.db"

    def tearDown(self) -> None:
        self.dir.cleanup()

    def test_stores_signed_placements_and_advances_the_cursor(self) -> None:
        with Archive(self.path) as archive:
            stored, advanced = archive.apply_batch(
                [_message(1, DID_A, 3, 4, 7, 100), _message(2, DID_B, 5, 6, 9, 101)]
            )
            self.assertEqual((stored, advanced), (2, 2))
            self.assertEqual(archive.last_seq, 2)
            self.assertEqual(archive.stats().placements, 2)
            self.assertEqual(archive.stats().signers, 2)

    def test_skips_unsigned_senders_but_still_advances(self) -> None:
        # An unsigned line is ordinary room traffic, not an error. Leaving the cursor behind
        # would make the loop re-read it forever.
        with Archive(self.path) as archive:
            stored, _ = archive.apply_batch(
                [
                    {
                        "seq": 1,
                        "ts": "t",
                        "from": "alice",
                        "text": "px 1,1 2 aaaaaa",
                        "nonce": 1,
                    },
                    _message(2, DID_A, 1, 1, 2, 2),
                ]
            )
            self.assertEqual(stored, 1)
            self.assertEqual(archive.last_seq, 2)

    def test_skips_lines_that_are_not_placements(self) -> None:
        with Archive(self.path) as archive:
            stored, _ = archive.apply_batch(
                [
                    {"seq": 1, "ts": "t", "from": DID_A, "text": "hello", "nonce": 1},
                    {
                        "seq": 2,
                        "ts": "t",
                        "from": DID_A,
                        # Off the canvas — read from the module, because this bound has
                        # moved twice and a literal here silently stops testing it.
                        "text": f"px {COLS},1 2 aaaaaa",
                        "nonce": 2,
                    },
                    {
                        "seq": 3,
                        "ts": "t",
                        "from": DID_A,
                        "text": "px 1,1 0 aaaaaa",
                        "nonce": 3,
                    },
                    {
                        "seq": 4,
                        "ts": "t",
                        "from": DID_A,
                        "text": " px 1,1 2 aaaaaa",
                        "nonce": 4,
                    },
                ]
            )
            self.assertEqual(
                stored, 0, "out of range, step 0 and leading space are all refused"
            )
            self.assertEqual(archive.last_seq, 4)

    def test_replaying_a_batch_stores_nothing_twice(self) -> None:
        batch = [_message(1, DID_A, 3, 4, 7, 100)]
        with Archive(self.path) as archive:
            archive.apply_batch(batch)
            archive.apply_batch(batch)
            self.assertEqual(archive.stats().placements, 1)

    def test_refuses_a_message_missing_documented_fields(self) -> None:
        with Archive(self.path) as archive:
            with self.assertRaises(ArchiveError):
                archive.apply_batch([{"seq": 1, "from": DID_A}])
            self.assertEqual(
                archive.last_seq, 0, "a refused batch must not move the cursor"
            )

    def test_newest_placement_per_cell_wins(self) -> None:
        with Archive(self.path) as archive:
            archive.apply_batch(
                [_message(1, DID_A, 2, 2, 3, 1), _message(2, DID_B, 2, 2, 9, 2)]
            )
            cells = list(archive.cells())
            self.assertEqual(len(cells), 1)
            self.assertEqual(cells[0].step, 9)
            self.assertEqual(len(archive.history(2, 2)), 2)


class Witnessing(unittest.TestCase):
    """A signature is attached only if it verifies against the archived row."""

    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "canvas.db"
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

        self.key = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
        raw = b"\xed\x01" + self.key.public_key().public_bytes_raw()
        alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
        number = int.from_bytes(raw, "big")
        text = ""
        while number:
            number, rem = divmod(number, 58)
            text = alphabet[rem] + text
        self.did = "did:key:z" + text

    def tearDown(self) -> None:
        self.dir.cleanup()

    def _sign(self, payload: str) -> str:
        import base64

        return (
            base64.urlsafe_b64encode(self.key.sign(payload.encode()))
            .decode()
            .rstrip("=")
        )

    def test_the_same_message_re_read_still_backfills_its_signature(self) -> None:
        """The replay guard must not break the backfill it sits beside.

        Re-reading the room delivers the same message at the *same* seq, and that is how a row
        archived before the service published signatures gains one. A guard keyed on
        (did, nonce) alone would mistake that for a replay and the hole would never fill.
        """
        with Archive(self.path) as archive:
            archive.room = ROOM
            message = _message(1, self.did, 5, 5, 7, 901)
            archive.apply_batch([message])
            self.assertFalse(next(iter(archive.cells())).witnessed)

            signed = dict(message)
            signed["sig"] = self._sign(f"{ROOM}|901|{message['text']}")
            archive.apply_batch([signed])
            row = next(iter(archive.cells()))

        self.assertTrue(row.witnessed, "the same seq re-read must still fill in the signature")

    def test_a_replay_at_a_new_seq_is_refused_even_when_signed(self) -> None:
        """A valid signature is not a defence here: the replay carries the original's.

        The signature proves who wrote the words, which was never in doubt. What it cannot
        say is that the author meant to write them twice.
        """
        with Archive(self.path) as archive:
            archive.room = ROOM
            first = _message(1, self.did, 6, 6, 7, 902)
            first["sig"] = self._sign(f"{ROOM}|902|{first['text']}")
            archive.apply_batch([first])

            replay = dict(first)
            replay["seq"] = 2
            archive.apply_batch([replay])

            rows = [row for row in archive.cells() if (row.cx, row.cy) == (6, 6)]
            history = archive.history(6, 6)

        self.assertEqual(len(rows), 1)
        self.assertEqual(len(history), 1, "the replay was archived as a second placement")

    def test_a_correct_signature_is_attached(self) -> None:
        with Archive(self.path) as archive:
            archive.room = ROOM
            message = _message(1, self.did, 3, 4, 7, 555)
            archive.apply_batch([message])
            payload = message_payload(ROOM, message["nonce"], message["text"])
            self.assertTrue(archive.witness(1, self._sign(payload)))
            self.assertTrue(archive.since(0)[0].witnessed)
            self.assertEqual(archive.stats().witnessed, 1)

    def test_a_signature_for_another_message_is_refused(self) -> None:
        # The payload is rebuilt from the stored row, so a valid signature over a *different*
        # message cannot be parked on this one.
        with Archive(self.path) as archive:
            archive.room = ROOM
            archive.apply_batch([_message(1, self.did, 3, 4, 7, 555)])
            other = message_payload(ROOM, 999, "px 9,9 2 abcdef")
            self.assertFalse(archive.witness(1, self._sign(other)))
            self.assertFalse(archive.since(0)[0].witnessed)

    def test_witnessing_an_unarchived_seq_raises(self) -> None:
        with Archive(self.path) as archive:
            archive.room = ROOM
            with self.assertRaises(ArchiveError):
                archive.witness(42, "A" * 86)

    def test_a_malformed_signature_is_refused_not_crashed(self) -> None:
        with Archive(self.path) as archive:
            archive.room = ROOM
            archive.apply_batch([_message(1, self.did, 3, 4, 7, 555)])
            self.assertFalse(archive.witness(1, "not-a-signature"))


WRITER = textwrap.dedent(
    """
    import json, sys, time
    from pathlib import Path
    sys.path.insert(0, sys.argv[3])
    from archive import Archive

    path, total = sys.argv[1], int(sys.argv[2])
    did = "did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX"
    archive = Archive(path)
    seq = 0
    while seq < total:
        seq += 1
        archive.apply_batch([{
            "seq": seq, "ts": "2026-08-29T00:00:00.000000Z", "from": did,
            "text": "px {},{} {:x} {:06x}".format(seq % 64, (seq * 7) % 64, (seq % 15) + 1, seq),
            "nonce": 1000 + seq,
        }])
        # Announce only after the commit returned. Everything printed here is a write the
        # archive has claimed is durable, so it is exactly what must survive a kill.
        print(seq, flush=True)
        time.sleep(0.002)
    """
).strip()


class SynchronousSetting(unittest.TestCase):
    """The pragma the kill test cannot reach."""

    def test_commits_are_flushed_to_disk(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with Archive(Path(tmp) / "canvas.db") as archive:
                level = archive._db.execute("PRAGMA synchronous").fetchone()[0]
                self.assertEqual(level, 2, "synchronous must be FULL (2), not NORMAL or OFF")

    def test_journal_mode_is_wal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with Archive(Path(tmp) / "canvas.db") as archive:
                mode = archive._db.execute("PRAGMA journal_mode").fetchone()[0]
                self.assertEqual(mode.lower(), "wal")


class KillMidStream(unittest.TestCase):
    """The acceptance test for T-5: SIGKILL mid-stream, then count what survived."""

    def test_no_acknowledged_write_is_lost(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "canvas.db"
            script = Path(tmp) / "writer.py"
            script.write_text(WRITER, encoding="utf-8")

            process = subprocess.Popen(
                [sys.executable, str(script), str(db), "4000", str(HERE)],
                stdout=subprocess.PIPE,
                text=True,
                bufsize=1,
            )
            acknowledged = 0
            try:
                deadline = time.time() + 20
                while time.time() < deadline:
                    line = process.stdout.readline()
                    if not line:
                        break
                    acknowledged = int(line.strip())
                    if acknowledged >= 200:
                        break
                self.assertGreaterEqual(acknowledged, 200, "writer did not get going")
                # Uncatchable: no shutdown hook, no flush on the way out.
                process.kill()
                process.wait(timeout=10)
            finally:
                if process.poll() is None:
                    process.kill()
                if process.stdout:
                    process.stdout.close()

            with Archive(db) as archive:
                stats = archive.stats()
                self.assertGreaterEqual(
                    stats.placements,
                    acknowledged,
                    f"lost {acknowledged - stats.placements} of {acknowledged} acknowledged writes",
                )
                self.assertGreaterEqual(archive.last_seq, acknowledged)

                # And the archive is still usable, not merely intact: a torn WAL would show up
                # here rather than in the counts.
                archive.apply_batch([_message(acknowledged + 5000, DID_B, 1, 2, 3, 7)])
                self.assertEqual(archive.stats().placements, stats.placements + 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
