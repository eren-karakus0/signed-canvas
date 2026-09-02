"""Presence: does the viewer count expire, bound itself, and refuse rubbish.

A count that never forgets is the failure this exists to avoid — it is exactly what
technocore.chat's note-based convention would have given us, and why presence is held here
instead. So the expiry is the first thing tested, and it is tested with an injected clock:
sleeping through a 45 second window makes a test that is slow and still not proof.
"""

from __future__ import annotations

import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from presence import DEFAULT_CAPACITY, DEFAULT_WINDOW_SECONDS, Presence


def viewer(n: int) -> str:
    return f"{n:016x}"


class PresenceTest(unittest.TestCase):
    def test_a_single_beat_counts_one(self) -> None:
        presence = Presence()
        self.assertEqual(presence.beat(viewer(1), 1000.0), (1, False))

    def test_the_same_viewer_beating_twice_is_still_one(self) -> None:
        presence = Presence()
        presence.beat(viewer(1), 1000.0)
        self.assertEqual(presence.beat(viewer(1), 1005.0), (1, False))

    def test_distinct_viewers_add_up(self) -> None:
        presence = Presence()
        for n in range(1, 6):
            presence.beat(viewer(n), 1000.0)
        self.assertEqual(presence.count(1000.0), 5)

    def test_a_viewer_falls_out_after_the_window(self) -> None:
        # The whole point: a tab that closed stops beating and must stop counting.
        presence = Presence(window_seconds=45.0)
        presence.beat(viewer(1), 1000.0)
        self.assertEqual(presence.count(1044.0), 1)
        self.assertEqual(presence.count(1046.0), 0)

    def test_one_viewer_leaving_does_not_take_the_others(self) -> None:
        presence = Presence(window_seconds=45.0)
        presence.beat(viewer(1), 1000.0)
        presence.beat(viewer(2), 1030.0)
        self.assertEqual(presence.count(1050.0), 1)
        self.assertEqual(presence.beat(viewer(2), 1050.0), (1, False))

    def test_a_beat_refreshes_rather_than_stacking(self) -> None:
        presence = Presence(window_seconds=45.0)
        presence.beat(viewer(1), 1000.0)
        presence.beat(viewer(1), 1040.0)
        self.assertEqual(presence.count(1080.0), 1)

    def test_capacity_is_a_ceiling_and_is_reported(self) -> None:
        # Nothing can stop invented ids, so the number is bounded and says when it is a floor
        # rather than growing without limit and calling it a measurement.
        presence = Presence(capacity=3)
        for n in range(1, 4):
            presence.beat(viewer(n), 1000.0)
        self.assertEqual(presence.beat(viewer(99), 1000.0), (3, True))
        self.assertEqual(presence.count(1000.0), 3)

    def test_capacity_frees_up_as_viewers_expire(self) -> None:
        presence = Presence(window_seconds=45.0, capacity=2)
        presence.beat(viewer(1), 1000.0)
        presence.beat(viewer(2), 1000.0)
        self.assertEqual(presence.beat(viewer(3), 1000.0), (2, True))
        self.assertEqual(presence.beat(viewer(3), 1100.0), (1, False))

    def test_a_viewer_already_tracked_is_refreshed_even_at_capacity(self) -> None:
        presence = Presence(capacity=2)
        presence.beat(viewer(1), 1000.0)
        presence.beat(viewer(2), 1000.0)
        self.assertEqual(presence.beat(viewer(1), 1010.0), (2, True))
        self.assertEqual(presence.count(1010.0), 2)

    def test_an_id_that_is_not_sixteen_hex_characters_is_refused(self) -> None:
        presence = Presence()
        for bad in (
            "",
            "xyz",
            "0" * 15,
            "0" * 17,
            "0" * 15 + "G",
            "../../etc",
            "0" * 15 + " ",
        ):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                presence.beat(bad, 1000.0)

    def test_a_clock_that_jumps_backwards_does_not_strand_a_viewer(self) -> None:
        # A last-seen time in the future would otherwise never fall out of the window.
        presence = Presence(window_seconds=45.0)
        presence.beat(viewer(1), 2000.0)
        self.assertEqual(presence.count(1000.0), 1)
        self.assertEqual(presence.count(2046.0), 0)

    def test_construction_rejects_a_window_or_capacity_that_cannot_work(self) -> None:
        for kwargs in ({"window_seconds": 0}, {"window_seconds": -1}, {"capacity": 0}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                Presence(**kwargs)

    def test_concurrent_beats_are_all_recorded(self) -> None:
        # The server hands each connection its own thread. An unguarded dict drops entries
        # under this, and it drops them silently.
        presence = Presence(capacity=1000)
        errors: list[BaseException] = []

        def beat(n: int) -> None:
            try:
                presence.beat(viewer(n), 1000.0)
            except BaseException as exc:  # noqa: BLE001 — recorded and re-raised below
                errors.append(exc)

        threads = [threading.Thread(target=beat, args=(n,)) for n in range(1, 201)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(errors, [])
        self.assertEqual(presence.count(1000.0), 200)

    def test_the_defaults_are_the_ones_the_client_is_paced_against(self) -> None:
        # The client beats at a third of the window. If this window shrinks, a viewer on a
        # slow connection starts flickering in and out of the count.
        self.assertEqual(DEFAULT_WINDOW_SECONDS, 45.0)
        self.assertGreaterEqual(DEFAULT_CAPACITY, 1000)


if __name__ == "__main__":
    unittest.main()
