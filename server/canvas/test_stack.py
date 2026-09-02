"""The tower plane: a cell's history, standing up.

A cell overwritten N times is drawn as a column N levels tall, each level keeping the colour
that was there. Until this plane existed the snapshot carried only the newest colour per cell,
which had two consequences nobody had written down:

    - every tower collapsed to a flat square on reload, because the height comes from the
      count of levels and the count was never sent;
    - every level of a live tower took the newest colour, because there was one colour.

Both are the same missing fact, so both are tested here as one.

The pairing that matters is `pack_stack` against `Archive.tower_rows`: the query decides which
placements are worth keeping and the packer decides how they are laid out, and a disagreement
between them draws a plausible tower out of the wrong colours.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from archive import Archive
from snapshot import MAX_STACK, STACK_BYTES, get_level, pack, pack_stack, set_level

ROOM = "p-canvas-test"
DID = "did:key:z6MkkQQzb6WvXYaN1Q9F4aJhCZ8SsuUmZv8mYnZ8Zt3rjKQ9"
BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"


class Row:
    """The three fields the packers read. Deliberately not the archive's Row."""

    def __init__(self, cx: int, cy: int, step: int, witnessed: bool = True) -> None:
        self.cx, self.cy, self.step, self.witnessed = cx, cy, step, witnessed


def tower(plane: bytes, cx: int, cy: int) -> list[int]:
    index = cy * 64 + cx
    return [get_level(plane, index, k) for k in range(MAX_STACK)]


class Packing(unittest.TestCase):
    def test_a_cell_placed_once_has_no_tower(self) -> None:
        # The first mark on an empty cell is not a contest, so it stands at ground level.
        self.assertEqual(tower(pack_stack([Row(5, 5, 4)]), 5, 5), [0] * MAX_STACK)

    def test_the_levels_below_the_top_are_kept_oldest_first(self) -> None:
        plane = pack_stack([Row(2, 3, 3), Row(2, 3, 7), Row(2, 3, 9), Row(2, 3, 12)])
        # 12 is the top and lives in `cells`; 3, 7, 9 are the tower, bottom first.
        self.assertEqual(tower(plane, 2, 3), [3, 7, 9, 0, 0, 0, 0, 0])

    def test_the_top_is_not_in_this_plane(self) -> None:
        # The one duplication worth refusing: if the top were in both planes they could
        # disagree about the same fact, and nothing would say which was right.
        plane = pack_stack([Row(1, 1, 6), Row(1, 1, 11)])
        self.assertNotIn(11, tower(plane, 1, 1))
        self.assertEqual(tower(plane, 1, 1)[0], 6)

    def test_a_tower_taller_than_the_cap_keeps_its_most_recent_levels(self) -> None:
        # Past the cap the column would leave the viewport, so the oldest levels go. Which
        # ones survive is a visible decision, not an implementation detail.
        plane = pack_stack([Row(1, 1, k) for k in range(1, 13)])
        self.assertEqual(tower(plane, 1, 1), [4, 5, 6, 7, 8, 9, 10, 11])

    def test_exactly_one_more_than_the_cap_fills_the_tower(self) -> None:
        plane = pack_stack([Row(1, 1, k) for k in range(1, MAX_STACK + 2)])
        self.assertEqual(tower(plane, 1, 1), list(range(1, MAX_STACK + 1)))

    def test_cells_do_not_bleed_into_each_other(self) -> None:
        # Eight levels per cell, one byte each: an off-by-one in the index writes into the
        # neighbouring cell's tower and looks like a rendering bug.
        plane = pack_stack([Row(0, 0, 1), Row(0, 0, 2), Row(1, 0, 5), Row(1, 0, 6)])
        self.assertEqual(tower(plane, 0, 0)[:2], [1, 0])
        self.assertEqual(tower(plane, 1, 0)[:2], [5, 0])

    def test_the_plane_is_the_documented_size(self) -> None:
        self.assertEqual(len(pack_stack([])), STACK_BYTES)

    def test_every_level_of_every_cell_round_trips(self) -> None:
        # Exhaustive over the layout rather than a spot check: this is index arithmetic, and
        # index arithmetic is wrong at exactly one place or not at all.
        plane = bytearray(STACK_BYTES)
        for index in range(0, 64 * 64, 37):
            for level in range(MAX_STACK):
                set_level(plane, index, level, (index + level) % 15 + 1)
        for index in range(0, 64 * 64, 37):
            for level in range(MAX_STACK):
                self.assertEqual(
                    get_level(plane, index, level), (index + level) % 15 + 1
                )

    def test_an_unpaintable_step_is_refused(self) -> None:
        with self.assertRaises(Exception):
            pack_stack([Row(0, 0, 36)])

    def test_a_cell_off_the_canvas_is_refused(self) -> None:
        with self.assertRaises(Exception):
            pack_stack([Row(64, 0, 3)])


class AgainstTheArchive(unittest.TestCase):
    """The query and the packer have to agree about which placements matter."""

    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "canvas.db"

    def tearDown(self) -> None:
        self.dir.cleanup()

    def _archive_with(self, placements: list[tuple[int, int, int]]) -> Archive:
        archive = Archive(self.path)
        archive.room = ROOM
        archive.apply_batch(
            [
                {
                    "seq": seq,
                    "ts": "2026-09-02T00:00:00.000000Z",
                    "from": DID,
                    "text": f"px {cx},{cy} {BASE36[step]} {seq:06x}",
                    "nonce": 1788000000000 + seq,
                }
                for seq, (cx, cy, step) in enumerate(placements, start=1)
            ]
        )
        return archive

    def test_the_archive_feeds_the_packer_the_tower_the_client_will_draw(self) -> None:
        with self._archive_with(
            [(2, 3, 3), (2, 3, 7), (9, 9, 4), (2, 3, 9), (2, 3, 12)]
        ) as archive:
            rows = list(archive.tower_rows(MAX_STACK + 1))
            plane = pack_stack(rows)
            top = {(r.cx, r.cy): r.step for r in archive.cells()}

        self.assertEqual(tower(plane, 2, 3), [3, 7, 9, 0, 0, 0, 0, 0])
        self.assertEqual(top[(2, 3)], 12, "the top belongs to the cells plane")
        self.assertEqual(tower(plane, 9, 9), [0] * MAX_STACK, "one placement, no tower")

    def test_the_query_bounds_work_by_occupied_cells_not_by_history(self) -> None:
        # A cell contested far past the cap must not drag its whole history out of the
        # database on every snapshot — that is the difference between a canvas that stays
        # cheap to load and one that gets slower the longer it is played.
        with self._archive_with([(4, 4, (k % 15) + 1) for k in range(200)]) as archive:
            rows = list(archive.tower_rows(MAX_STACK + 1))
        self.assertEqual(len(rows), MAX_STACK + 1)

    def test_rows_arrive_oldest_first_within_a_cell(self) -> None:
        # `pack_stack` trusts the order it is given; if the query reversed it the tower would
        # be built upside down and still look like a tower.
        with self._archive_with([(1, 1, 2), (1, 1, 5), (1, 1, 9)]) as archive:
            rows = [r.step for r in archive.tower_rows(MAX_STACK + 1)]
        self.assertEqual(rows, [2, 5, 9])

    def test_cells_and_stack_describe_the_same_canvas(self) -> None:
        placements = [(3, 3, 1), (3, 3, 2), (3, 3, 3), (7, 2, 8), (7, 2, 9)]
        with self._archive_with(placements) as archive:
            cells, _ = pack(list(archive.cells()))
            plane = pack_stack(list(archive.tower_rows(MAX_STACK + 1)))

        def top_of(cx: int, cy: int) -> int:
            # One byte per cell since the palette outgrew four bits.
            return cells[cy * 64 + cx]

        self.assertEqual(top_of(3, 3), 3)
        self.assertEqual(tower(plane, 3, 3), [1, 2, 0, 0, 0, 0, 0, 0])
        self.assertEqual(top_of(7, 2), 9)
        self.assertEqual(tower(plane, 7, 2), [8, 0, 0, 0, 0, 0, 0, 0])


if __name__ == "__main__":
    unittest.main()
