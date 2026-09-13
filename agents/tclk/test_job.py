"""The deliverable specification and the settlement check.

The settlement check is tested against a stub archive rather than the live one. That is not
squeamishness about the network: the cases worth testing are a half-painted region, a region
painted in the wrong colour, and a region someone else painted over — none of which can be
produced on demand on a canvas other people are using.
"""

from __future__ import annotations

import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

import job
from job import JobError

DID_WORKER = "did:key:z6MkkMUtyaoMQ1qNiBc84kxgY76LnDbmJ8vEo5RFbvVbEpJ6"
DID_OTHER = "did:key:z6MkkrPU26RGhFiinsF97bKYawQ3xTPZ9nGh4ZLpXaJ1kQm2"

#: A three-cell commission: enough to be wrong in every distinguishable way.
CELLS = [(5, 5, 15), (6, 5, 15), (5, 6, 24)]


class StubArchive:
    """An archive that answers /region with whatever the test put in it."""

    def __init__(self) -> None:
        self.cells: list[dict] = []
        self.seq = 100
        handler = self._handler()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def _handler(self):
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 — the base class names it
                query = parse_qs(urlparse(self.path).query)
                body = json.dumps(
                    {
                        "x": int(query["x"][0]),
                        "y": int(query["y"][0]),
                        "w": int(query["w"][0]),
                        "h": int(query["h"][0]),
                        "at": int(query.get("at", [stub.seq])[0]),
                        "archive_seq": stub.seq,
                        "derivable_from": "/cell/<x>/<y>",
                        "cells": stub.cells,
                    }
                ).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_: object) -> None:
                pass

        return Handler

    def paint(
        self, cx: int, cy: int, step: int, did: str = DID_WORKER, seq: int = 1
    ) -> None:
        self.cells = [c for c in self.cells if (c["cx"], c["cy"]) != (cx, cy)]
        self.cells.append(
            {
                "cx": cx,
                "cy": cy,
                "step": step,
                "did": did,
                "seq": seq,
                "witnessed": True,
            }
        )

    def close(self) -> None:
        self.server.shutdown()
        # shutdown() stops serving; the listening socket stays open until this.
        self.server.server_close()


class Bounds(unittest.TestCase):
    def test_the_rectangle_is_the_smallest_that_contains_every_cell(self) -> None:
        self.assertEqual(job.bounds(CELLS), (5, 5, 2, 2))

    def test_a_single_cell_is_a_one_by_one_region(self) -> None:
        self.assertEqual(job.bounds([(9, 9, 3)]), (9, 9, 1, 1))


class NoteText(unittest.TestCase):
    def _note(self, cells=CELLS) -> str:
        return job.note_text(
            job_id="j-1",
            cells=cells,
            deadline_iso="2026-09-14T12:00:00Z",
            archive_url="https://example.invalid/api",
            amount="144",
            asset="PAPER",
        )

    def test_every_cell_is_listed(self) -> None:
        # Prose cannot settle a deal. "A padlock" is something two honest parties can disagree
        # about; a list of cells and steps is not.
        note = self._note()
        for cx, cy, step in CELLS:
            self.assertIn(f"{cx},{cy},{step}", note)

    def test_it_names_both_settlement_routes(self) -> None:
        note = self._note()
        self.assertIn("/region?x=5&y=5&w=2&h=2", note)
        self.assertIn("/cell/<x>/<y>", note)
        self.assertIn("not an authority", note)

    def test_it_says_no_rail_holds_value(self) -> None:
        # NFR-7. A specification that implies an escrow it does not have is worse than one
        # that admits it.
        self.assertIn("no rail in this deal holds value", self._note())

    def test_a_commission_too_large_to_specify_is_refused(self) -> None:
        # Better to fail here than to write a note truncated mid-cell, which reads as a
        # deliverable that simply stops.
        huge = [(x % 144, x // 144, 15) for x in range(2000)]
        with self.assertRaises(JobError) as caught:
            self._note(huge)
        self.assertIn("too large", str(caught.exception))


class Delivery(unittest.TestCase):
    def setUp(self) -> None:
        self.archive = StubArchive()
        self.addCleanup(self.archive.close)

    def test_an_untouched_region_is_entirely_missing(self) -> None:
        result = job.delivered(CELLS, self.archive.url)
        self.assertFalse(result["complete"])
        self.assertEqual(result["right"], 0)
        self.assertEqual(len(result["missing"]), 3)

    def test_a_fully_painted_region_is_complete_and_names_the_painter(self) -> None:
        for cx, cy, step in CELLS:
            self.archive.paint(cx, cy, step)
        result = job.delivered(CELLS, self.archive.url)
        self.assertTrue(result["complete"])
        self.assertEqual(result["right"], 3)
        self.assertEqual(result["painters"], {DID_WORKER: 3})

    def test_a_half_painted_region_is_not_complete(self) -> None:
        self.archive.paint(5, 5, 15)
        result = job.delivered(CELLS, self.archive.url)
        self.assertFalse(result["complete"])
        self.assertEqual(result["right"], 1)
        self.assertEqual(len(result["missing"]), 2)

    def test_the_wrong_colour_is_reported_as_wrong_not_missing(self) -> None:
        # The distinction matters to whoever is settling: missing is unfinished work, wrong is
        # finished work that does not match the specification.
        for cx, cy, step in CELLS:
            self.archive.paint(cx, cy, step)
        self.archive.paint(5, 6, 9)
        result = job.delivered(CELLS, self.archive.url)
        self.assertFalse(result["complete"])
        self.assertEqual(result["wrong"], [{"cell": [5, 6], "wanted": 24, "found": 9}])
        self.assertEqual(result["missing"], [])

    def test_a_region_painted_by_two_keys_names_both(self) -> None:
        # A commission can be delivered by more than one agent, and who painted what is the
        # payer's business at settlement.
        self.archive.paint(5, 5, 15, DID_WORKER)
        self.archive.paint(6, 5, 15, DID_OTHER)
        self.archive.paint(5, 6, 24, DID_WORKER)
        result = job.delivered(CELLS, self.archive.url)
        self.assertTrue(result["complete"])
        self.assertEqual(result["painters"], {DID_WORKER: 2, DID_OTHER: 1})

    def test_an_archive_that_answers_with_rubbish_is_refused(self) -> None:
        with self.assertRaises(JobError):
            job.delivered(CELLS, "http://127.0.0.1:1/api")


class Plans(unittest.TestCase):
    def test_the_commission_plan_loads_and_is_the_size_it_claims(self) -> None:
        path = Path(__file__).resolve().parents[2] / "plans" / "commission-lock.json"
        if not path.exists():
            self.skipTest(f"no plan at {path}")
        cells = job.load_plan(path)
        self.assertEqual(len(cells), 100)
        x, y, w, h = job.bounds(cells)
        self.assertLessEqual(w * h, 144, "the commission should stay a short job")

    def test_a_file_that_is_not_a_plan_is_refused(self) -> None:
        with self.assertRaises(JobError):
            job.load_plan(Path(__file__))


if __name__ == "__main__":
    unittest.main()
