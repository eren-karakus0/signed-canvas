"""Where a deal has got to, and what this side owes next.

A pure function over the frames recorded so far. That is the whole design: resume is not a
separate code path that has to agree with the normal one, it *is* the normal one — read the
file, compute the state, emit what is owed. A state machine that also kept state in memory
would have two answers to the same question, and they would disagree exactly once, in
production, after a crash.

Applying a frame that fails a guard leaves the state untouched and says why. tclk's own
reference does the same (`applyFrame` returns `{state, ok, reason}`), and the reason matters
more than the refusal: a deal that silently ignores a malformed frame looks identical to one
waiting for a frame that never arrives.

**What the guards can and cannot establish.** They can check that a reveal's secret hashes to
the statement the accept committed to — that is real, and it is the one cryptographic link in
the sequence. They cannot check that any work was done. The payee mints the secret, so
revealing it proves only that the payee is the party who accepted. Nothing in this module
should be read as delivery verification, because there is none.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from enum import Enum
from typing import Any

import frames


class State(str, Enum):
    """Where a deal stands. The string values are what gets written to the record."""

    OPENED = "opened"
    ACCEPTED = "accepted"
    LOCKED = "locked"
    REVEALED = "revealed"
    SETTLED = "settled"
    CANCELLED = "cancelled"
    EXPIRED = "expired"


TERMINAL = frozenset({State.SETTLED, State.CANCELLED, State.EXPIRED})

#: Which side owes the next frame in each live state. The payer opens, locks and receipts;
#: the payee accepts and reveals.
OWED: dict[State, tuple[str, str]] = {
    State.OPENED: ("payee", "accept"),
    State.ACCEPTED: ("payer", "lock"),
    State.LOCKED: ("payee", "reveal"),
    State.REVEALED: ("payer", "receipt"),
}


@dataclass(frozen=True)
class Applied:
    """The result of offering one frame to the state machine."""

    state: State
    ok: bool
    reason: str = ""


@dataclass(frozen=True)
class Deal:
    """A deal reconstructed from its recorded frames."""

    contract: str
    payer: str
    payee: str
    state: State
    offer: dict[str, Any]
    statement: str = ""
    secret: str = ""

    def owes(self, me: str) -> str | None:
        """The frame `me` owes now, or None if it is somebody else's turn or the deal is over.

        `me` is a did:key compared against the sides of this deal, not a role name, so a
        caller cannot claim a side it does not hold the key for.

        **An open offer is the exception, and it has to be.** Until somebody accepts, the
        counterparty does not exist — that is what an open offer *is*. So in `OPENED` this
        answers "accept" to anyone except the offer's own author, who is barred from taking
        their own offer. Anything else would make the state unreachable: the payee cannot be
        compared against a DID nobody has chosen yet.
        """
        if self.state in TERMINAL:
            return None
        side, frame = OWED[self.state]
        mine = self.payer if side == "payer" else self.payee
        if not mine:
            return frame if me != self.offer.get("from") else None
        return frame if mine == me else None


class DealError(ValueError):
    """A sequence of frames that is not a deal."""


def _hashes_to(secret: str, statement: str) -> bool:
    if not (secret.startswith("0x") and statement.startswith("0x")):
        return False
    try:
        digest = hashlib.sha256(bytes.fromhex(secret[2:])).hexdigest()
    except ValueError:
        return False
    return "0x" + digest == statement


def rebuild(entries: list[dict[str, Any]], now_ms: int) -> Deal:
    """The deal these recorded frames describe.

    Frames are applied in the order recorded. One that fails a guard is skipped with its
    reason rather than aborting the rebuild: the record is history, and history can contain a
    frame somebody sent that the protocol did not accept.

    :raises DealError: if the first frame is not an offer, or there are no frames at all.
    """
    if not entries:
        raise DealError("a deal with no frames is not a deal")
    first = entries[0].get("frame", {})
    if first.get("type") != "offer":
        raise DealError(f"a deal starts with an offer, not {first.get('type')!r}")

    offer = first
    payer = offer["from"] if offer.get("role") == "payer" else ""
    payee = "" if payer else offer["from"]
    deal = Deal(
        # Until somebody accepts there is no contract, only an offer. `contract` holds the
        # offer id in the meantime so the field is never empty, and the accept replaces it.
        contract=offer["id"],
        payer=payer,
        payee=payee,
        state=State.OPENED,
        offer=offer,
    )

    for entry in entries[1:]:
        result = apply(deal, entry.get("frame", {}), entry.get("from", ""), now_ms)
        if result.ok:
            deal = _advance(
                deal, entry.get("frame", {}), entry.get("from", ""), result.state
            )

    # The clock has the last word: a live deal whose refund time has passed is expired,
    # whatever the frames say, because the counterparty's obligations have lapsed.
    if deal.state not in TERMINAL and now_ms >= int(offer.get("refundAfterMs", 0)):
        deal = Deal(**{**deal.__dict__, "state": State.EXPIRED})
    return deal


def apply(deal: Deal, frame: dict[str, Any], sender: str, now_ms: int) -> Applied:
    """Would `frame` from `sender` advance `deal`, and if not, why not.

    Never mutates. The caller advances the deal only on `ok`.
    """
    kind = frame.get("type")
    if kind is None:
        return Applied(deal.state, False, "frame has no type")
    if deal.state in TERMINAL:
        return Applied(deal.state, False, f"deal is {deal.state.value}")
    if frame.get("from") != sender:
        return Applied(deal.state, False, "frame's from does not match who sent it")

    if kind == "cancel":
        # Either side may cancel, but only before funds are locked; after that the deadlines
        # govern and a unilateral cancel would strand the other party's escrow.
        if deal.state not in (State.OPENED, State.ACCEPTED):
            return Applied(
                deal.state, False, "cancel after lock; the deadlines govern now"
            )
        if sender not in (deal.payer, deal.payee):
            return Applied(deal.state, False, "cancel from a party to this deal only")
        return Applied(State.CANCELLED, True)

    if kind == "heartbeat":
        return Applied(deal.state, False, "heartbeat is liveness, not a move")

    if frame.get("contract") not in (deal.contract, None) and kind != "accept":
        return Applied(deal.state, False, "frame names a different contract")

    expected_side, expected_kind = OWED[deal.state]
    if kind != expected_kind:
        return Applied(deal.state, False, f"expected {expected_kind}, got {kind}")

    if kind == "accept":
        if now_ms >= int(deal.offer.get("expiresMs", 0)):
            return Applied(deal.state, False, "the offer has expired")
        if frame.get("ref") != deal.offer.get("id"):
            return Applied(deal.state, False, "accept does not answer this offer")
        # The contract id is not the offer id: it comes into existence here, binding the full
        # offer to this acceptance, and both sides recompute it. A mismatch rejects the frame
        # — the spec says so, and it is the only thing stopping two parties from proceeding
        # with different ideas of what they agreed.
        try:
            expected = frames.contract_id_from_accept(deal.offer, frame)
        except frames.FrameError as exc:
            return Applied(deal.state, False, f"accept cannot be bound to a contract: {exc}")
        if frame.get("contract") != expected:
            return Applied(
                deal.state,
                False,
                f"contract id does not recompute: {str(frame.get('contract'))[:14]}… "
                f"against {expected[:14]}…",
            )
        statement = frame.get("statement", "")
        if not isinstance(statement, str) or len(statement) != 66:
            return Applied(deal.state, False, "a hash lock needs a 32-byte statement")
        if sender == deal.offer["from"]:
            return Applied(
                deal.state, False, "an offer cannot be accepted by its own author"
            )
        return Applied(State.ACCEPTED, True)

    expected_did = deal.payer if expected_side == "payer" else deal.payee
    if sender != expected_did:
        return Applied(deal.state, False, f"{kind} must come from the {expected_side}")

    if kind == "lock":
        rails = deal.offer.get("rails", [])
        if frame.get("rail") not in rails:
            return Applied(
                deal.state, False, f"rail is not one the offer named: {rails}"
            )
        return Applied(State.LOCKED, True)

    if kind == "reveal":
        if now_ms >= int(deal.offer.get("claimByMs", 0)):
            return Applied(deal.state, False, "the claim window has closed")
        if not _hashes_to(frame.get("secret", ""), deal.statement):
            return Applied(
                deal.state, False, "the secret does not hash to the statement"
            )
        return Applied(State.REVEALED, True)

    if kind == "receipt":
        if frame.get("outcome") not in ("claimed", "refunded", "cancelled"):
            return Applied(deal.state, False, "receipt needs a known outcome")
        return Applied(State.SETTLED, True)

    return Applied(deal.state, False, f"no rule for {kind}")


def _advance(deal: Deal, frame: dict[str, Any], sender: str, state: State) -> Deal:
    """The deal after an accepted frame. Only `apply` decides whether to call this."""
    fields = dict(deal.__dict__)
    fields["state"] = state
    if frame.get("type") == "accept":
        fields["statement"] = frame.get("statement", "")
        # From here on every frame names the deal by the contract id, not the offer id.
        fields["contract"] = frame["contract"]
        # The offer said which side its author took; the accepter is the other one.
        if deal.payer:
            fields["payee"] = sender
        else:
            fields["payer"] = sender
    elif frame.get("type") == "reveal":
        fields["secret"] = frame.get("secret", "")
    return Deal(**fields)


def next_frame(
    deal: Deal, me: str, *, rail: str = "", ref: str = "", secret: str = ""
) -> dict:
    """Build the frame `me` owes, or raise if nothing is owed.

    The arguments a frame needs but the deal cannot know — which rail the escrow is on, its
    reference there, the preimage only the payee holds — are passed in rather than invented.

    :raises DealError: if `me` owes nothing right now.
    """
    owed = deal.owes(me)
    if owed is None:
        raise DealError(f"{me[:20]}… owes nothing in state {deal.state.value}")
    if owed == "accept":
        raise DealError(
            "accept is built by the accepting side, which mints its own secret"
        )
    if owed == "lock":
        return frames.build_lock(sender=me, contract=deal.contract, rail=rail, ref=ref)
    if owed == "reveal":
        return frames.build_reveal(sender=me, contract=deal.contract, secret=secret)
    return frames.build_receipt(
        sender=me, contract=deal.contract, outcome="claimed", rail=rail or None
    )
