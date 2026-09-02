"""T-6's acceptance: snapshot plus delta must equal a full replay, byte for byte.

The interesting failures here are not crashes. They are the ones where the canvas is *nearly*
right — a cell that keeps an older colour because two placements landed in it, a witness bit
that survives a repaint it should not have, an off-by-one at the delta boundary that drops
exactly one pixel. So the assertions compare packed bytes rather than pixel counts: a
comparison that can only say "about the same" is not worth making.
"""

from __future__ import annotations

import json
import random
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from app import serve
from archive import Archive
from snapshot import (
    CELL_BYTES,
    COLS,
    ROWS,
    WITNESS_BYTES,
    apply_delta,
    decode,
    pack,
    unpack,
)

DID_A = "did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX"
DID_B = "did:key:z6MkeXCT2bbYPVr8zoLJxVTfcdZPeBGnx8Fw23Mrk88FqGKa"
ROOM = "p-canvas-test"


def _message(seq: int, cx: int, cy: int, step: int, did: str = DID_A) -> dict:
    return {
        "seq": seq,
        "ts": f"2026-08-29T00:00:{seq % 60:02d}.000000Z",
        "from": did,
        "text": f"px {cx},{cy} {step:x} {seq:06x}",
        "nonce": 1000 + seq,
    }


def _random_history(count: int, seed: int = 11, start: int = 1) -> list[dict]:
    """Placements with deliberate collisions: without repeats in one cell, ordering bugs hide.

    ``start`` matters more than it looks. Sequences are the primary key, so a second batch
    reusing 1..N is silently ignored and any test built on it compares a snapshot to itself.
    That happened here once; the assertions below now check the delta is non-empty so it
    cannot happen quietly again.
    """
    rand = random.Random(seed)
    return [
        _message(
            seq,
            rand.randrange(COLS),
            rand.randrange(ROWS),
            rand.randrange(1, 16),
            DID_A if seq % 3 else DID_B,
        )
        for seq in range(start, start + count)
    ]


class Packing(unittest.TestCase):
    def test_round_trips_every_step_in_every_nibble(self) -> None:
        class Row:
            def __init__(self, cx: int, cy: int, step: int, witnessed: bool) -> None:
                self.cx, self.cy, self.step, self.witnessed = cx, cy, step, witnessed

        # Both nibble positions, first and last cell, and every paintable step.
        rows = [Row(step - 1, 0, step, step % 2 == 0) for step in range(1, 16)]
        rows.append(Row(63, 63, 15, True))
        cells, witnessed = pack(rows)
        self.assertEqual((len(cells), len(witnessed)), (CELL_BYTES, WITNESS_BYTES))
        got = {
            (cx, cy): (step, proven)
            for cx, cy, step, proven in unpack(cells, witnessed)
        }
        for row in rows:
            self.assertEqual(got[(row.cx, row.cy)], (row.step, row.witnessed))

    def test_an_empty_canvas_packs_to_zero_bytes(self) -> None:
        cells, witnessed = pack([])
        self.assertEqual(cells, bytes(CELL_BYTES))
        self.assertEqual(witnessed, bytes(WITNESS_BYTES))
        self.assertEqual(unpack(cells, witnessed), [])

    def test_a_later_row_overwrites_an_earlier_one_in_the_same_cell(self) -> None:
        class Row:
            def __init__(self, step: int, witnessed: bool) -> None:
                self.cx, self.cy, self.step, self.witnessed = 5, 5, step, witnessed

        cells, witnessed = pack([Row(3, True), Row(9, False)])
        self.assertEqual(unpack(cells, witnessed), [(5, 5, 9, False)])


class SnapshotPlusDelta(unittest.TestCase):
    """The acceptance property, exercised directly against the archive."""

    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "canvas.db"

    def tearDown(self) -> None:
        self.dir.cleanup()

    def test_snapshot_then_delta_equals_a_full_replay(self) -> None:
        history = _random_history(600)
        with Archive(self.path) as archive:
            archive.room = ROOM
            # Snapshot after the first two thirds, delta for the rest — the split a client
            # actually experiences.
            cut = 400
            archive.apply_batch(history[:cut])
            snap_cells, snap_witness = pack(archive.cells())
            snapshot_seq = archive.last_seq

            archive.apply_batch(history[cut:])
            replay_cells, replay_witness = pack(archive.cells())

            delta = [
                {"cx": r.cx, "cy": r.cy, "step": r.step, "witnessed": r.witnessed}
                for r in archive.since(snapshot_seq)
            ]
        self.assertEqual(len(delta), 200, "the delta must cover exactly the second batch")

        cells = bytearray(snap_cells)
        witnessed = bytearray(snap_witness)
        apply_delta(cells, witnessed, delta)

        self.assertEqual(
            bytes(cells), replay_cells, "cells plane diverged from a full replay"
        )
        self.assertEqual(bytes(witnessed), replay_witness, "witness plane diverged")

    def test_a_delta_from_zero_equals_the_whole_canvas(self) -> None:
        history = _random_history(200, seed=5)
        with Archive(self.path) as archive:
            archive.room = ROOM
            archive.apply_batch(history)
            replay_cells, replay_witness = pack(archive.cells())
            delta = [
                {"cx": r.cx, "cy": r.cy, "step": r.step, "witnessed": r.witnessed}
                for r in archive.since(0)
            ]

        cells = bytearray(CELL_BYTES)
        witnessed = bytearray(WITNESS_BYTES)
        apply_delta(cells, witnessed, delta)
        self.assertEqual(bytes(cells), replay_cells)
        self.assertEqual(bytes(witnessed), replay_witness)

    def test_an_empty_delta_leaves_the_snapshot_untouched(self) -> None:
        with Archive(self.path) as archive:
            archive.room = ROOM
            archive.apply_batch(_random_history(50, seed=3))
            snap_cells, snap_witness = pack(archive.cells())
            delta = archive.since(archive.last_seq)
        self.assertEqual(delta, [])
        cells, witnessed = bytearray(snap_cells), bytearray(snap_witness)
        apply_delta(cells, witnessed, [])
        self.assertEqual(bytes(cells), snap_cells)


class Api(unittest.TestCase):
    """The routes, over a real socket."""

    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "canvas.db"
        with Archive(self.path) as archive:
            archive.room = ROOM
            archive.apply_batch(_random_history(120, seed=7))
        self.server = serve(self.path, "127.0.0.1", 0)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.dir.cleanup()

    def get(self, path: str) -> dict:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{self.port}{path}", timeout=10
        ) as r:
            return json.loads(r.read())

    def post(self, path: str, payload: dict) -> tuple[int, dict]:
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=json.dumps(payload).encode(),
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def test_snapshot_decodes_to_the_documented_sizes(self) -> None:
        body = self.get("/snapshot")
        self.assertEqual(len(decode(body["cells"], CELL_BYTES)), CELL_BYTES)
        self.assertEqual(len(decode(body["witnessed"], WITNESS_BYTES)), WITNESS_BYTES)
        self.assertEqual(body["seq"], 120)
        self.assertGreater(body["painted"], 0)

    def test_snapshot_over_http_plus_delta_equals_replay(self) -> None:
        snapshot = self.get("/snapshot")
        with Archive(self.path) as archive:
            # Continue the sequence: reusing 1..N would be ignored as already-archived and
            # the delta would come back empty, making this assertion vacuous.
            archive.apply_batch(_random_history(40, seed=99, start=snapshot["seq"] + 1))
            replay_cells, replay_witness = pack(archive.cells())
        delta = self.get(f"/since/{snapshot['seq']}")

        self.assertEqual(len(delta["placements"]), 40, "the delta must actually carry the batch")
        self.assertFalse(delta["truncated"])

        cells = bytearray(decode(snapshot["cells"], CELL_BYTES))
        witnessed = bytearray(decode(snapshot["witnessed"], WITNESS_BYTES))
        apply_delta(cells, witnessed, delta["placements"])
        self.assertEqual(bytes(cells), replay_cells)
        self.assertEqual(bytes(witnessed), replay_witness)

    def test_cell_history_carries_the_payload_and_a_null_signature(self) -> None:
        history = self.get("/snapshot")
        self.assertGreater(history["painted"], 0)
        with Archive(self.path) as archive:
            row = next(iter(archive.cells()))
        body = self.get(f"/cell/{row.cx}/{row.cy}")
        self.assertGreaterEqual(len(body["placements"]), 1)
        first = body["placements"][0]
        self.assertTrue(first["payload"].startswith(f"{ROOM}|"))
        self.assertIsNone(
            first["sig"], "an attested pixel must not present a signature"
        )
        self.assertFalse(first["witnessed"])

    def test_health_reports_lag(self) -> None:
        body = self.get("/health")
        self.assertEqual(body["room"], ROOM)
        self.assertIn("lag", body)
        self.assertEqual(body["placements"], 120)

    def test_unknown_routes_and_bad_cells_are_refused(self) -> None:
        # 96 wide, 64 tall: each axis gets its own case, and the far corner is checked
        # as valid below so a bound that is wrong in both directions cannot pass.
        for path in ("/nope", "/since/abc", "/cell/96/0", "/cell/0/64"):
            with self.subTest(path):
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    self.get(path)
                self.assertIn(caught.exception.code, (400, 404))

    def test_witness_refuses_a_malformed_or_wrong_signature(self) -> None:
        status, body = self.post("/witness", {"seq": 1, "sig": "short"})
        self.assertEqual(status, 400)

        status, body = self.post("/witness", {"seq": 1, "sig": "A" * 86})
        self.assertEqual(
            status, 422, "a well-formed but wrong signature is 422, not 403"
        )

        status, body = self.post("/witness", {"seq": 999999, "sig": "A" * 86})
        self.assertEqual(status, 404, "witnessing a placement we never archived is 404")

    def test_witness_refuses_an_oversized_body(self) -> None:
        status, _ = self.post(
            "/witness", {"seq": 1, "sig": "A" * 86, "pad": "x" * 5000}
        )
        self.assertEqual(status, 413)


if __name__ == "__main__":
    unittest.main(verbosity=2)
