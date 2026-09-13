"""Do our frames match the protocol, and do our ids match everyone else's?

Two kinds of check, and the second is the one that matters.

The first validates every frame this project can emit against
`vendor/tclk1-frames.schema.json` — the artifact tclk's own decoder uses. That catches a field
we spelled wrong or a shape we invented.

The second recomputes the contract id of **real offers taken from the live room** and compares
it with the id their authors put in them. That is the only check that can tell us our
canonicalization agrees with other conforming implementations, and it is the thing the spec
warns is easy to get wrong. A fixture we wrote ourselves could not: it would agree with us by
construction.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import frames
from frames import FrameError

SCHEMA = json.loads(
    (Path(__file__).resolve().parent / "vendor" / "tclk1-frames.schema.json").read_text(
        encoding="utf-8"
    )
)

#: Offers captured from /r/tclk-offers on 2026-09-13, verbatim, ids included. Kept as a file
#: rather than fetched at test time: a test that needs the network is a test that fails when
#: someone else's service is down.
CAPTURED = Path(__file__).resolve().parent / "vendor" / "captured-offers.jsonl"

DID_A = "did:key:z6Mkt98WxK78RZ9524wtthPi8vYaU2EQYKJcJEzBWWnjjkYG"
DID_B = "did:key:z6MkkrPU26RGhFiinsF97bKYawQ3xTPZ9nGh4ZLpXaJ1kQm2"

HOUR_MS = 3_600_000
NOW_MS = 1_789_300_000_000


def validate(frame: dict) -> None:
    """Raise if `frame` does not satisfy the vendored schema."""
    import jsonschema

    jsonschema.validate(frame, SCHEMA)


class Canonicalization(unittest.TestCase):
    def test_keys_are_sorted_and_separators_are_tight(self) -> None:
        body = frames.canonical({"b": 2, "a": 1})
        self.assertEqual(body, '{"a":1,"b":2}')

    def test_non_ascii_is_escaped(self) -> None:
        # The id hashes these bytes, so the escaping is not cosmetic: an implementation that
        # hashed the pre-escape string would disagree with us on any frame carrying one.
        self.assertEqual(frames.canonical({"a": "ü"}), '{"a":"\\u00fc"}')

    def test_keys_with_no_value_are_dropped(self) -> None:
        self.assertEqual(frames.strip_unset({"a": 1, "b": None}), {"a": 1})

    def test_every_sweepable_character_is_escaped_rather_than_carried(self) -> None:
        """The property the room needs, asserted directly.

        technocore replaces every character in Cc, Cf, Cs, Co, Zl and Zp with a space before
        storage. If one reached the wire raw, the frame signed and the frame stored would
        differ and the signature would stop verifying. Canonical JSON escapes all of them, so
        this asserts the escaping — not a refusal, which cannot happen and would be a test of
        nothing at all.
        """
        for codepoint in [0x00, 0x01, 0x1F, 0x7F, 0x85, 0x200B, 0x2028, 0x2029]:
            with self.subTest(codepoint=hex(codepoint)):
                text = frames.encode(
                    {"type": "cancel", "from": DID_A, "reason": chr(codepoint)}
                )
                self.assertNotIn(chr(codepoint), text)
                self.assertTrue(all(0x20 <= ord(c) < 0x7F for c in text))

    def test_encode_carries_the_version_prefix(self) -> None:
        text = frames.encode(
            {"type": "cancel", "from": DID_A, "contract": "0x" + "a" * 64}
        )
        self.assertTrue(text.startswith("tclk1 {"))


class BuiltFramesSatisfyTheSchema(unittest.TestCase):
    """Every frame this project can emit, checked against tclk's own artifact."""

    def setUp(self) -> None:
        self.offer = frames.build_offer(
            sender=DID_A,
            role="payer",
            amount="144",
            asset="PAPER",
            rails=["paper"],
            claim_by_ms=NOW_MS + 6 * HOUR_MS,
            refund_after_ms=NOW_MS + 12 * HOUR_MS,
            expires_ms=NOW_MS + 2 * HOUR_MS,
            job={"proto": "a2a", "id": "job-1", "context": "https://example.invalid/j"},
        )
        self.secret, self.statement = frames.new_secret()

    def test_offer(self) -> None:
        validate(self.offer)

    def test_accept(self) -> None:
        validate(
            frames.build_accept(
                sender=DID_B,
                # A hex32 naming the offer, not a free string — the schema says so and the
                # prose does not.
                ref=self.offer["id"],
                statement=self.statement,
                contract=self.offer["id"],
            )
        )

    def test_lock(self) -> None:
        validate(
            frames.build_lock(
                sender=DID_A, contract=self.offer["id"], rail="paper", ref="r1"
            )
        )

    def test_reveal(self) -> None:
        validate(
            frames.build_reveal(
                sender=DID_B, contract=self.offer["id"], secret=self.secret
            )
        )

    def test_receipt(self) -> None:
        validate(
            frames.strip_unset(
                frames.build_receipt(
                    sender=DID_A,
                    contract=self.offer["id"],
                    outcome="claimed",
                    rail="paper",
                )
            )
        )

    def test_accept_refuses_a_ref_that_is_not_a_hex32(self) -> None:
        # The mistake the prose invites, locked out.
        with self.assertRaises(FrameError):
            frames.build_accept(
                sender=DID_B,
                ref="1",
                statement=self.statement,
                contract=self.offer["id"],
            )

    def test_lock_keeps_ref_free_but_non_empty(self) -> None:
        # Same field name, different meaning: here it is the rail's own reference.
        validate(
            frames.build_lock(
                sender=DID_A, contract=self.offer["id"], rail="paper", ref="paper-tx-7"
            )
        )
        with self.assertRaises(FrameError):
            frames.build_lock(
                sender=DID_A, contract=self.offer["id"], rail="paper", ref=""
            )

    def test_the_statement_matches_its_secret(self) -> None:
        self.assertEqual(frames.statement_for(self.secret), self.statement)


class OfferGuards(unittest.TestCase):
    def _offer(self, **overrides):
        kwargs = {
            "sender": DID_A,
            "role": "payer",
            "amount": "144",
            "asset": "PAPER",
            "rails": ["paper"],
            "claim_by_ms": NOW_MS + 6 * HOUR_MS,
            "refund_after_ms": NOW_MS + 12 * HOUR_MS,
            "expires_ms": NOW_MS + 2 * HOUR_MS,
        }
        kwargs.update(overrides)
        return frames.build_offer(**kwargs)

    def test_deadlines_must_order(self) -> None:
        # The gap between them is the payee's claim window; inverted, there is none.
        with self.assertRaises(FrameError):
            self._offer(
                claim_by_ms=NOW_MS + 12 * HOUR_MS, refund_after_ms=NOW_MS + 6 * HOUR_MS
            )
        with self.assertRaises(FrameError):
            self._offer(claim_by_ms=NOW_MS, refund_after_ms=NOW_MS)

    def test_point_locks_are_refused(self) -> None:
        with self.assertRaises(FrameError) as caught:
            self._offer(lock="point")
        self.assertIn("unaudited", str(caught.exception))

    def test_malformed_fields_are_refused(self) -> None:
        for overrides in (
            {"sender": "did:key:nope"},
            {"role": "referee"},
            {"amount": "0"},
            {"amount": "-1"},
            {"amount": "12.5"},
            {"rails": []},
            {"rails": ["NOT A RAIL"]},
            {"job": {"proto": "a2a"}},
            {"job": {"proto": "a2a", "id": "x", "extra": "y"}},
        ):
            with self.subTest(**overrides), self.assertRaises(FrameError):
                self._offer(**overrides)

    def test_rails_are_deduplicated_and_ordered_before_the_id_is_computed(self) -> None:
        # The array's order is not meaningful, but it is part of the bytes the id hashes, so
        # two builders given the same set must produce the same id.
        one = self._offer(rails=["paper", "flop-htlc", "paper"])
        self.assertEqual(one["rails"], ["flop-htlc", "paper"])


class ContractIds(unittest.TestCase):
    def test_the_id_is_stable_and_excludes_itself(self) -> None:
        offer = frames.build_offer(
            sender=DID_A,
            role="payer",
            amount="144",
            asset="PAPER",
            rails=["paper"],
            claim_by_ms=NOW_MS + 6 * HOUR_MS,
            refund_after_ms=NOW_MS + 12 * HOUR_MS,
            expires_ms=NOW_MS + 2 * HOUR_MS,
        )
        self.assertEqual(frames.contract_id(offer), offer["id"])
        # Recomputing from a copy without the id must give the same answer.
        without = {k: v for k, v in offer.items() if k != "id"}
        self.assertEqual(frames.contract_id(without), offer["id"])

    def test_real_offers_from_the_room_reproduce_their_own_ids(self) -> None:
        """The only check that can catch us disagreeing with other implementations.

        These are other agents' offers, captured verbatim. If our canonicalization or our
        domain separator were wrong, the ids would not match — and no fixture of our own
        making could tell us, because it would be wrong in the same direction.
        """
        if not CAPTURED.exists():
            self.skipTest(f"no captured offers at {CAPTURED}")
        checked = 0
        for line in CAPTURED.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            offer = json.loads(line)
            with self.subTest(id=offer.get("id", "")[:14]):
                self.assertEqual(frames.contract_id(offer), offer["id"])
            checked += 1
        self.assertGreaterEqual(checked, 5, "too few captured offers to be evidence")


class Decoding(unittest.TestCase):
    def test_a_well_formed_frame_decodes(self) -> None:
        text = frames.encode(
            {"type": "cancel", "from": DID_A, "contract": "0x" + "b" * 64}
        )
        self.assertEqual(frames.decode(text)["type"], "cancel")

    def test_anything_else_is_refused(self) -> None:
        for text in (
            "",
            "hello",
            "tclk2 {}",
            "tclk1 not json",
            "tclk1 [1,2]",
            'tclk1 {"type":"invent","from":"' + DID_A + '"}',
            'tclk1 {"type":"cancel","from":"nobody"}',
            'tclk1 {"type":"cancel"}',
        ):
            with self.subTest(text=text[:28]), self.assertRaises(FrameError):
                frames.decode(text)


if __name__ == "__main__":
    unittest.main()
