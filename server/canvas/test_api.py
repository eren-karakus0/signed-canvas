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

    def test_a_repainter_ranks_below_a_holder(self) -> None:
        """The distinction the board exists to make, with a case that can tell them apart.

        The random fixture cannot: nobody in it repaints, so ranking by placements and ranking
        by cells held produce the same order and a board sorted the wrong way passes. So this
        builds the disagreement on purpose — one key with forty placements in a single cell,
        another with five cells and five placements — and asserts the holder wins.
        """
        repainter = "did:key:z6MkrepaintERbGvXR7cAtGkWkHNzhoJ1AuqDVN3rYwGnDaaa"
        holder = "did:key:z6MkholderGvXR7cAtGkWkHNzhoJ1AuqDVN3rYwGnDbbbbbbb"
        # Well past the fixture's cells so neither key is overwritten by it or by the other.
        rows = [
            _message(1000 + n, COLS - 1, ROWS - 1, 1 + (n % 15), repainter) for n in range(40)
        ]
        rows += [_message(1100 + n, COLS - 2 - n, ROWS - 1, 3, holder) for n in range(5)]
        with Archive(self.path) as archive:
            archive.apply_batch(rows)

        leaders = {leader["did"]: leader for leader in self.get("/leaders")["leaders"]}
        self.assertIn(repainter, leaders)
        self.assertIn(holder, leaders)
        self.assertEqual((leaders[repainter]["held"], leaders[repainter]["placed"]), (1, 40))
        self.assertEqual((leaders[holder]["held"], leaders[holder]["placed"]), (5, 5))

        order = [leader["did"] for leader in self.get("/leaders")["leaders"]]
        self.assertLess(
            order.index(holder),
            order.index(repainter),
            "forty placements in one cell outranked five cells held",
        )

    def test_leaders_report_held_placed_and_witnessed_consistently(self) -> None:
        body = self.get("/leaders")
        leaders = body["leaders"]
        self.assertGreater(len(leaders), 0)
        self.assertLessEqual(len(leaders), 10)

        held = [leader["held"] for leader in leaders]
        self.assertEqual(held, sorted(held, reverse=True), "not ordered by cells held")

        with Archive(self.path) as archive:
            standing: dict[str, int] = {}
            for row in archive.cells():
                standing[row.did] = standing.get(row.did, 0) + 1
            total_by_did: dict[str, int] = {}
            for row in archive.since(0, limit=100000):
                total_by_did[row.did] = total_by_did.get(row.did, 0) + 1

        for leader in leaders:
            with self.subTest(did=leader["did"][:20]):
                self.assertEqual(leader["held"], standing[leader["did"]])
                self.assertEqual(leader["placed"], total_by_did[leader["did"]])
                # Held cells are a subset of placements, and witnessed a subset of held.
                self.assertLessEqual(leader["held"], leader["placed"])
                self.assertLessEqual(leader["witnessed"], leader["held"])

    def test_leaders_hold_no_more_than_the_canvas_has(self) -> None:
        """The held counts partition the occupied cells; they cannot exceed them."""
        painted = self.get("/snapshot")["painted"]
        held = sum(leader["held"] for leader in self.get("/leaders")["leaders"])
        self.assertLessEqual(held, painted)

    def test_health_reports_lag(self) -> None:
        body = self.get("/health")
        self.assertEqual(body["room"], ROOM)
        self.assertIn("lag", body)
        self.assertEqual(body["placements"], 120)

    def test_unknown_routes_are_refused(self) -> None:
        for path in ("/nope", "/since/abc", "/presence/nothex", "/presence/0" * 3):
            with self.subTest(path):
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    self.get(path)
                self.assertEqual(caught.exception.code, 404)

    def test_a_cell_outside_the_canvas_is_refused_as_a_bad_cell(self) -> None:
        """400, not 404.

        This used to accept either, and that is how the route pattern came to be stale: it
        matched two digits while the canvas grew to 144 wide, so `/cell/144/0` never reached
        the handler and answered 404 for the wrong reason. Every column past 99 answered 404
        too, which is a third of the board with no proof export, and this test passed
        throughout. Distinguishing the two codes is what makes it a test of the bounds.
        """
        for path in (f"/cell/{COLS}/0", f"/cell/0/{ROWS}", f"/cell/{COLS}/{ROWS}"):
            with self.subTest(path):
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    self.get(path)
                self.assertEqual(caught.exception.code, 400)

    def test_every_column_and_row_is_reachable(self) -> None:
        """The last cell on each axis answers, not just the first.

        Walking the corners rather than one cell: a pattern that is too narrow, an off-by-one
        bound, and an axis swap each survive a test that only ever asks for 0,0.
        """
        for cx, cy in ((0, 0), (COLS - 1, 0), (0, ROWS - 1), (COLS - 1, ROWS - 1)):
            with self.subTest(cell=(cx, cy)):
                body = self.get(f"/cell/{cx}/{cy}")
                self.assertEqual((body["cx"], body["cy"]), (cx, cy))
                self.assertIsInstance(body["placements"], list)

    def test_presence_counts_viewers_and_forgets_them(self) -> None:
        """The route, end to end. The expiry itself is tested in test_presence.py."""
        first = self.get("/presence/" + "a" * 16)
        self.assertEqual(first["viewers"], 1)
        self.assertFalse(first["capped"])
        self.assertEqual(self.get("/presence/" + "a" * 16)["viewers"], 1)
        self.assertEqual(self.get("/presence/" + "b" * 16)["viewers"], 2)

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
