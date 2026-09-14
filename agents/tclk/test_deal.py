"""The state machine and the record, including the thing NFR-6 actually asks for.

The resume test is the point of this file. A deal that can only be driven forward in one
process is a deal that dies with the process, and every frame it had already sent stays sent.
So the check is not "does resume work" in the abstract — it is: killed at each of the five
positions, does a fresh read of the file emit the correct next frame and never one already
accepted.
"""

from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import deal as deal_module
import frames
from deal import Deal, DealError, State
from record import DealRecord, RecordError

PAYER = "did:key:z6Mkt98WxK78RZ9524wtthPi8vYaU2EQYKJcJEzBWWnjjkYG"
PAYEE = "did:key:z6MkkMUtyaoMQ1qNiBc84kxgY76LnDbmJ8vEo5RFbvVbEpJ6"
STRANGER = "did:key:z6MkkrPU26RGhFiinsF97bKYawQ3xTPZ9nGh4ZLpXaJ1kQm2"

HOUR_MS = 3_600_000
#: Real time, not a fixed constant. The state machine judges each frame against the clock it
#: arrived under, and a record written now carries a real `seen_at` — a synthetic epoch would
#: put the fixture's frames hours away from their own observation times and expire the offer
#: underneath them.
NOW_MS = int(time.time() * 1000)


def an_offer() -> dict:
    return frames.build_offer(
        sender=PAYER,
        role="payer",
        amount="144",
        asset="PAPER",
        rails=["paper"],
        claim_by_ms=NOW_MS + 6 * HOUR_MS,
        refund_after_ms=NOW_MS + 12 * HOUR_MS,
        expires_ms=NOW_MS + 2 * HOUR_MS,
        job={"proto": "a2a", "id": "job-1"},
    )


def entries_through(position: str) -> tuple[list[dict], str, str]:
    """Recorded entries up to and including `position`, plus the secret and statement."""
    offer = an_offer()
    secret, statement = frames.new_secret()
    # The contract id is derived from the offer and this acceptance, not taken from the offer.
    accept = frames.accept_offer(sender=PAYEE, offer=offer, statement=statement)
    contract = accept["contract"]
    built = [
        ("offer", PAYER, offer),
        ("accept", PAYEE, accept),
        (
            "lock",
            PAYER,
            frames.build_lock(
                sender=PAYER, contract=contract, rail="paper", ref="tx-1"
            ),
        ),
        (
            "reveal",
            PAYEE,
            frames.build_reveal(sender=PAYEE, contract=contract, secret=secret),
        ),
        (
            "receipt",
            PAYER,
            frames.build_receipt(
                sender=PAYER, contract=contract, outcome="claimed", rail="paper"
            ),
        ),
    ]
    labels = [label for label, _, _ in built]
    stop = labels.index(position) + 1
    # `seen_at` as a real record carries it: seconds, near now, a little apart so the order
    # the frames were observed in is the order they are replayed in.
    entries = [
        {
            "label": label,
            "room": "p-test",
            "seq": i + 1,
            "from": sender,
            "frame": frame,
            "seen_at": NOW_MS / 1000 + i,
        }
        for i, (label, sender, frame) in enumerate(built[:stop])
    ]
    return entries, secret, statement


class Rebuilding(unittest.TestCase):
    def test_each_position_reaches_the_state_it_should(self) -> None:
        for position, expected in (
            ("offer", State.OPENED),
            ("accept", State.ACCEPTED),
            ("lock", State.LOCKED),
            ("reveal", State.REVEALED),
            ("receipt", State.SETTLED),
        ):
            with self.subTest(position=position):
                entries, _, _ = entries_through(position)
                self.assertEqual(deal_module.rebuild(entries, NOW_MS).state, expected)

    def test_the_accepter_becomes_the_other_side(self) -> None:
        entries, _, _ = entries_through("accept")
        rebuilt = deal_module.rebuild(entries, NOW_MS)
        self.assertEqual(rebuilt.payer, PAYER)
        self.assertEqual(rebuilt.payee, PAYEE)

    def test_a_deal_that_does_not_start_with_an_offer_is_refused(self) -> None:
        entries, _, _ = entries_through("accept")
        with self.assertRaises(DealError):
            deal_module.rebuild(entries[1:], NOW_MS)
        with self.assertRaises(DealError):
            deal_module.rebuild([], NOW_MS)

    def test_a_live_deal_past_its_refund_time_is_expired(self) -> None:
        # The clock has the last word: the counterparty's obligations have lapsed, whatever
        # the frames say.
        entries, _, _ = entries_through("lock")
        late = NOW_MS + 13 * HOUR_MS
        self.assertEqual(deal_module.rebuild(entries, late).state, State.EXPIRED)


class WhoOwesWhat(unittest.TestCase):
    def test_each_side_owes_only_its_own_frames(self) -> None:
        for position, owed_by, owed in (
            ("offer", PAYEE, "accept"),
            ("accept", PAYER, "lock"),
            ("lock", PAYEE, "reveal"),
            ("reveal", PAYER, "receipt"),
        ):
            with self.subTest(position=position):
                entries, _, _ = entries_through(position)
                rebuilt = deal_module.rebuild(entries, NOW_MS)
                self.assertEqual(rebuilt.owes(owed_by), owed)
                other = PAYER if owed_by == PAYEE else PAYEE
                self.assertIsNone(rebuilt.owes(other), "the other side owes nothing")

    def test_an_open_offer_may_be_accepted_by_anyone_but_its_author(self) -> None:
        # An open offer has no counterparty yet; that is what makes it open. Asserting that a
        # stranger owes nothing here would be asserting that nobody can ever take it.
        rebuilt = deal_module.rebuild(entries_through("offer")[0], NOW_MS)
        self.assertEqual(rebuilt.owes(STRANGER), "accept")
        self.assertEqual(rebuilt.owes(PAYEE), "accept")
        self.assertIsNone(rebuilt.owes(PAYER), "the author cannot take their own offer")

    def test_once_accepted_a_stranger_owes_nothing(self) -> None:
        rebuilt = deal_module.rebuild(entries_through("accept")[0], NOW_MS)
        self.assertIsNone(rebuilt.owes(STRANGER))

    def test_a_settled_deal_owes_nothing_to_anyone(self) -> None:
        entries, _, _ = entries_through("receipt")
        rebuilt = deal_module.rebuild(entries, NOW_MS)
        for who in (PAYER, PAYEE, STRANGER):
            self.assertIsNone(rebuilt.owes(who))


class Guards(unittest.TestCase):
    def setUp(self) -> None:
        entries, self.secret, self.statement = entries_through("lock")
        self.entries = entries
        self.deal = deal_module.rebuild(entries, NOW_MS)
        self.contract = self.deal.contract

    def _apply(self, frame: dict, sender: str, now_ms: int = NOW_MS):
        return deal_module.apply(self.deal, frame, sender, now_ms)

    def test_a_reveal_whose_secret_does_not_hash_to_the_statement_is_refused(
        self,
    ) -> None:
        # The one cryptographic link in the sequence, and the only guard here that checks
        # something rather than someone.
        wrong, _ = frames.new_secret()
        result = self._apply(
            frames.build_reveal(sender=PAYEE, contract=self.contract, secret=wrong),
            PAYEE,
        )
        self.assertFalse(result.ok)
        self.assertIn("does not hash", result.reason)

    def test_the_right_secret_is_accepted(self) -> None:
        result = self._apply(
            frames.build_reveal(
                sender=PAYEE, contract=self.contract, secret=self.secret
            ),
            PAYEE,
        )
        self.assertTrue(result.ok, result.reason)

    def test_a_reveal_from_the_payer_is_refused(self) -> None:
        frame = frames.build_reveal(
            sender=PAYER, contract=self.contract, secret=self.secret
        )
        result = self._apply(frame, PAYER)
        self.assertFalse(result.ok)
        self.assertIn("payee", result.reason)

    def test_a_reveal_after_the_claim_window_is_refused(self) -> None:
        frame = frames.build_reveal(
            sender=PAYEE, contract=self.contract, secret=self.secret
        )
        result = self._apply(frame, PAYEE, now_ms=NOW_MS + 7 * HOUR_MS)
        self.assertFalse(result.ok)
        self.assertIn("claim window", result.reason)

    def test_a_frame_naming_another_contract_is_refused(self) -> None:
        frame = frames.build_reveal(
            sender=PAYEE, contract="0x" + "c" * 64, secret=self.secret
        )
        result = self._apply(frame, PAYEE)
        self.assertFalse(result.ok)

    def test_a_frame_whose_from_is_not_its_sender_is_refused(self) -> None:
        # Signature verification happens before this, but the two must agree or a verified
        # frame could still carry someone else's name.
        frame = frames.build_reveal(
            sender=PAYEE, contract=self.contract, secret=self.secret
        )
        result = self._apply(frame, STRANGER)
        self.assertFalse(result.ok)
        self.assertIn("does not match", result.reason)

    def test_out_of_turn_frames_are_refused(self) -> None:
        frame = frames.build_receipt(
            sender=PAYER, contract=self.contract, outcome="claimed", rail="paper"
        )
        result = self._apply(frame, PAYER)
        self.assertFalse(result.ok)
        self.assertIn("expected reveal", result.reason)


class AcceptGuards(unittest.TestCase):
    def setUp(self) -> None:
        self.entries, _, self.statement = entries_through("offer")
        self.deal = deal_module.rebuild(self.entries, NOW_MS)

    def test_an_author_cannot_accept_their_own_offer(self) -> None:
        frame = frames.accept_offer(
            sender=PAYER, offer=self.deal.offer, statement=self.statement
        )
        result = deal_module.apply(self.deal, frame, PAYER, NOW_MS)
        self.assertFalse(result.ok)
        self.assertIn("its own author", result.reason)

    def test_an_accept_after_the_offer_expired_is_refused(self) -> None:
        frame = frames.accept_offer(
            sender=PAYEE, offer=self.deal.offer, statement=self.statement
        )
        result = deal_module.apply(self.deal, frame, PAYEE, NOW_MS + 3 * HOUR_MS)
        self.assertFalse(result.ok)
        self.assertIn("expired", result.reason)

    def test_an_accept_whose_contract_id_does_not_recompute_is_refused(self) -> None:
        """The check the spec makes mandatory, and the bug a live counterparty exposed.

        This project used the offer id as the contract id. Every frame after the accept would
        then have named something the counterparty never agreed to.
        """
        frame = frames.accept_offer(
            sender=PAYEE, offer=self.deal.offer, statement=self.statement
        )
        frame["contract"] = "0x" + "f" * 64
        result = deal_module.apply(self.deal, frame, PAYEE, NOW_MS)
        self.assertFalse(result.ok)
        self.assertIn("does not recompute", result.reason)

    def test_an_accept_naming_a_different_offer_is_refused(self) -> None:
        frame = frames.build_accept(
            sender=PAYEE,
            ref="0x" + "d" * 64,
            statement=self.statement,
            contract="0x" + "e" * 64,
        )
        result = deal_module.apply(self.deal, frame, PAYEE, NOW_MS)
        self.assertFalse(result.ok)


class Cancelling(unittest.TestCase):
    def test_cancel_is_allowed_before_the_lock_and_refused_after(self) -> None:
        for position, allowed in (("offer", True), ("accept", True), ("lock", False)):
            with self.subTest(position=position):
                entries, _, _ = entries_through(position)
                rebuilt = deal_module.rebuild(entries, NOW_MS)
                frame = {"type": "cancel", "from": PAYER, "contract": rebuilt.contract}
                self.assertEqual(
                    deal_module.apply(rebuilt, frame, PAYER, NOW_MS).ok, allowed
                )

    def test_a_stranger_cannot_cancel(self) -> None:
        entries, _, _ = entries_through("offer")
        rebuilt = deal_module.rebuild(entries, NOW_MS)
        frame = {"type": "cancel", "from": STRANGER, "contract": rebuilt.contract}
        self.assertFalse(deal_module.apply(rebuilt, frame, STRANGER, NOW_MS).ok)


class Resuming(unittest.TestCase):
    """NFR-6, asserted the way it is written: killed at each position, resume correctly."""

    def test_a_fresh_read_at_each_position_emits_the_right_next_frame(self) -> None:
        for position, resumer, expected in (
            ("offer", PAYEE, "accept"),
            ("accept", PAYER, "lock"),
            ("lock", PAYEE, "reveal"),
            ("reveal", PAYER, "receipt"),
        ):
            with (
                self.subTest(position=position),
                tempfile.TemporaryDirectory() as folder,
            ):
                entries, secret, _ = entries_through(position)
                contract = entries[0]["frame"]["id"]  # the record is filed under the offer

                # Write the deal as the first process would have, then drop every reference
                # to it — the second process gets nothing but the file.
                first = DealRecord.open(Path(folder), contract, payer=PAYER)
                for entry in entries:
                    first.append(
                        label=entry["label"],
                        room=entry["room"],
                        seq=entry["seq"],
                        sender=entry["from"],
                        frame=entry["frame"],
                    )
                del first

                reopened = DealRecord(Path(folder) / f"{contract[2:18]}.json")
                rebuilt = deal_module.rebuild(reopened.frames, NOW_MS)
                self.assertEqual(rebuilt.owes(resumer), expected)

                if expected != "accept":
                    frame = deal_module.next_frame(
                        rebuilt, resumer, rail="paper", ref="tx-1", secret=secret
                    )
                    self.assertEqual(frame["type"], expected)
                    # The derived contract id, not the offer id: after an accept the deal is
                    # named by the contract, and a resumed process must name the same one.
                    self.assertEqual(frame["contract"], rebuilt.contract)

    def test_a_settled_deal_resumes_into_owing_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            entries, _, _ = entries_through("receipt")
            contract = entries[0]["frame"]["id"]
            record = DealRecord.open(Path(folder), contract, payer=PAYER)
            for entry in entries:
                record.append(
                    label=entry["label"],
                    room=entry["room"],
                    seq=entry["seq"],
                    sender=entry["from"],
                    frame=entry["frame"],
                )
            rebuilt = deal_module.rebuild(DealRecord(record.path).frames, NOW_MS)
            self.assertEqual(rebuilt.state, State.SETTLED)
            with self.assertRaises(DealError):
                deal_module.next_frame(rebuilt, PAYER)


class Refunding(unittest.TestCase):
    """The way out when nobody delivers, which is the common ending in this room.

    Measured on the live deal this code opened: the counterparty accepted one second after the
    offer landed and never revealed. Expiry is not an error path here; it is the path.
    """

    def _expired(self, position: str):
        entries, _, _ = entries_through(position)
        late = NOW_MS + 19 * HOUR_MS
        return deal_module.rebuild(entries, late), late

    def test_an_expired_deal_with_escrow_owes_the_payer_a_refund(self) -> None:
        deal, late = self._expired("lock")
        self.assertEqual(deal.state, State.EXPIRED)
        self.assertEqual(deal.owes(PAYER), "refund")
        self.assertIsNone(deal.owes(PAYEE), "the payee owes nothing after expiry")

    def test_an_expired_offer_nobody_locked_owes_nothing(self) -> None:
        # There is no escrow to take back — only an offer nobody took. A refund frame here
        # would name money that never moved.
        deal, _ = self._expired("offer")
        self.assertEqual(deal.state, State.EXPIRED)
        self.assertIsNone(deal.owes(PAYER))

    def test_a_refund_with_no_escrow_behind_it_is_refused(self) -> None:
        # `owes` already declines to ask for one; this is the other half, because a frame can
        # arrive without this side having asked for it. A refund on an offer nobody locked
        # would name money that never moved.
        deal, late = self._expired("accept")
        frame = frames.build_refund(sender=PAYER, contract=deal.contract, reason="lapsed")
        result = deal_module.apply(deal, frame, PAYER, late)
        self.assertFalse(result.ok)
        self.assertIn("nothing was locked", result.reason)

    def test_only_the_payer_can_refund(self) -> None:
        deal, late = self._expired("lock")
        frame = frames.build_refund(sender=PAYEE, contract=deal.contract, reason="mine now")
        result = deal_module.apply(deal, frame, PAYEE, late)
        self.assertFalse(result.ok)
        self.assertIn("only the payer", result.reason)

    def test_a_refund_before_its_time_is_refused(self) -> None:
        entries, _, _ = entries_through("lock")
        deal = deal_module.rebuild(entries, NOW_MS)
        frame = frames.build_refund(sender=PAYER, contract=deal.contract, reason="early")
        result = deal_module.apply(deal, frame, PAYER, NOW_MS)
        self.assertFalse(result.ok)
        self.assertIn("has not arrived", result.reason)

    def test_the_receipt_after_a_refund_says_refunded_not_claimed(self) -> None:
        """The most misleading line this code could write, locked out by a test."""
        deal, late = self._expired("lock")
        refund = deal_module.next_frame(deal, PAYER)
        self.assertEqual(refund["type"], "refund")

        after = deal_module._advance(deal, refund, PAYER, State.REFUNDED)
        receipt = deal_module.next_frame(after, PAYER, rail="paper")
        self.assertEqual(receipt["type"], "receipt")
        self.assertEqual(receipt["outcome"], "refunded")

    def test_a_refunded_deal_is_not_pushed_back_into_expiry_by_the_clock(self) -> None:
        # Re-marking a closed deal expired would ask for the refund a second time.
        entries, _, _ = entries_through("lock")
        late = NOW_MS + 19 * HOUR_MS
        deal = deal_module.rebuild(entries, late)
        refund = deal_module.next_frame(deal, PAYER)
        entries.append(
            {"label": "refund", "room": "p-test", "seq": 90, "from": PAYER, "frame": refund}
        )
        self.assertEqual(deal_module.rebuild(entries, late + HOUR_MS).state, State.REFUNDED)


class Records(unittest.TestCase):
    def test_the_same_observation_twice_does_not_double_the_history(self) -> None:
        # Overlapping reads deliver a frame we already have; recording it again would make
        # the rebuild see two accepts and refuse the second.
        with tempfile.TemporaryDirectory() as folder:
            record = DealRecord.open(Path(folder), "0x" + "a" * 64)
            for _ in range(3):
                record.append(
                    label="offer",
                    room="p-x",
                    seq=1,
                    sender=PAYER,
                    frame={"type": "offer"},
                )
            self.assertEqual(len(record.frames), 1)

    def test_frames_are_returned_as_copies(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            record = DealRecord.open(Path(folder), "0x" + "a" * 64)
            record.append(
                label="offer", room="p-x", seq=1, sender=PAYER, frame={"type": "offer"}
            )
            record.frames[0]["label"] = "tampered"
            self.assertEqual(record.frames[0]["label"], "offer")

    def test_a_deal_answers_to_both_its_offer_id_and_its_contract_id(self) -> None:
        """The same deal has two names, and a lookup may hold either.

        It is filed under the offer id, which exists from the moment the offer is built, and
        named by the contract id, which exists only once somebody accepts. A follower resuming
        from the contract id could not find its own record until this existed.
        """
        with tempfile.TemporaryDirectory() as folder:
            entries, _, _ = entries_through("accept")
            offer_id = entries[0]["frame"]["id"]
            contract_id = entries[1]["frame"]["contract"]
            self.assertNotEqual(offer_id, contract_id)

            record = DealRecord.open(Path(folder), offer_id, payer=PAYER)
            for entry in entries:
                record.append(
                    label=entry["label"], room=entry["room"], seq=entry["seq"],
                    sender=entry["from"], frame=entry["frame"],
                )
            for identifier in (offer_id, contract_id):
                with self.subTest(identifier=identifier[:12]):
                    found = DealRecord.find(Path(folder), identifier)
                    self.assertEqual(found.path, record.path)
            with self.assertRaises(RecordError):
                DealRecord.find(Path(folder), "0x" + "9" * 64)

    def test_a_file_that_is_not_a_record_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "broken.json"
            path.write_text('{"not": "a record"}', encoding="utf-8")
            with self.assertRaises(RecordError):
                DealRecord(path)
            path.write_text("{{{", encoding="utf-8")
            with self.assertRaises(RecordError):
                DealRecord(path)

    def test_the_file_survives_being_written_repeatedly(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            record = DealRecord.open(Path(folder), "0x" + "a" * 64, payer=PAYER)
            for seq in range(1, 20):
                record.append(
                    label="x",
                    room="p-x",
                    seq=seq,
                    sender=PAYER,
                    frame={"type": "offer"},
                )
            reopened = DealRecord(record.path)
            self.assertEqual(len(reopened.frames), 19)
            self.assertEqual(reopened.get("payer"), PAYER)
            # No temporary files left behind by the atomic replace.
            self.assertEqual([p.name for p in Path(folder).glob(".deal-*")], [])


if __name__ == "__main__":
    unittest.main()
