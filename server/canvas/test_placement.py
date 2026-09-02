"""The wire grammar, on the server's side of it.

This file exists because of a bug it would have caught. Widening the palette moved `step` from
one hex digit to one base36 digit in four places — the client, the agent tools, the verifier
and here — and here it landed half-applied: `MAX_STEP` said 35 while the parser still read the
digit as hex. Every server test used a step under 16, where base36 and hex are the same
characters, so all of them passed and the archive silently dropped every pixel painted in a
colour hex could not express.

Silently is the operative word. `parse` returns None for a line that is not a placement, which
is correct — the room is world-writable and most of its traffic is not ours — so a placement it
fails to recognise looks exactly like someone chatting.
"""

from __future__ import annotations

import unittest

from placement import MAX_STEP, MIN_STEP, parse

BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"


class Grammar(unittest.TestCase):
    def test_the_documented_example(self) -> None:
        placement = parse("px 12,47 3 k8f2a1")
        assert placement is not None
        self.assertEqual((placement.cx, placement.cy, placement.step), (12, 47, 3))
        self.assertEqual(placement.token, "k8f2a1")

    def test_every_step_the_palette_allows_round_trips(self) -> None:
        # The whole range, not a sample: the failure this file was written for was a single
        # digit-base mismatch that only shows above 15.
        for step in range(MIN_STEP, MAX_STEP + 1):
            with self.subTest(step=step):
                line = f"px 7,8 {BASE36[step]} abcdef"
                placement = parse(line)
                self.assertIsNotNone(placement, f"{line!r} must parse")
                assert placement is not None
                self.assertEqual(placement.step, step)

    def test_the_steps_hex_could_not_express(self) -> None:
        for digit, step in (("g", 16), ("p", 25), ("z", 35)):
            with self.subTest(digit=digit):
                placement = parse(f"px 0,0 {digit} abcdef")
                self.assertIsNotNone(placement)
                assert placement is not None
                self.assertEqual(placement.step, step)

    def test_hex_digits_still_mean_what_they_meant(self) -> None:
        # Every pixel already in the room carries one of these. If widening the base had
        # shifted them, the canvas would have repainted itself the moment this deployed.
        for digit, step in (("1", 1), ("9", 9), ("a", 10), ("f", 15)):
            with self.subTest(digit=digit):
                placement = parse(f"px 3,4 {digit} abcdef")
                assert placement is not None
                self.assertEqual(placement.step, step)

    def test_a_third_party_line_already_in_the_room(self) -> None:
        # Written by an agent that read the room's first message, before any of this.
        placement = parse("px 15,40 a w9p2mz")
        assert placement is not None
        self.assertEqual((placement.cx, placement.cy, placement.step), (15, 40, 10))


class NotAPlacement(unittest.TestCase):
    def test_lines_that_must_not_paint(self) -> None:
        for line in (
            "px 12,47 3 k8f2a1 ",  # trailing space
            " px 12,47 3 k8f2a1",  # leading space
            "px  12,47 3 k8f2a1",  # doubled space
            "px 12,47 03 k8f2a1",  # decimal step: the mistake that cost 85 lines
            "px 12,47 0 k8f2a1",  # 0 is the empty cell, not a colour
            "px 64,0 1 abcdef",  # off the canvas
            "px 0,64 1 abcdef",
            "px 12,47 3 K8F2A1",  # uppercase token
            "px 12,47 3 k8f2a",  # short token
            "px 12,47 3 k8f2a1x",  # long token
            "px 12,47 - abcdef",  # not a digit at all
            "gm",
            "",
        ):
            with self.subTest(line=line):
                self.assertIsNone(parse(line), f"{line!r} must not paint")

    def test_a_step_past_the_palette_is_refused_by_value_not_by_shape(self) -> None:
        # `z` is 35 and paintable; there is no single base36 digit above it, so the bound is
        # asserted here rather than left to the grammar to imply.
        self.assertIsNotNone(parse("px 0,0 z abcdef"))
        self.assertEqual(MAX_STEP, 35)


if __name__ == "__main__":
    unittest.main()
