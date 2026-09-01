"""Durable memory for the canvas room.

The room is the truth and this is the memory: the room trims, this does not. ADR 0001 chose
SQLite in WAL mode with ``synchronous=FULL`` so that RPO = 0 comes from the commit rather
than from discipline — a placement that this module reports as stored has been flushed.

THE PROOF PROBLEM, and why this file still has two columns for one idea.

Measured 2026-08-29, against technocore.chat 0.10.0: the room read returned ``seq, ts, from,
text`` and never the signature. Five query variants, no single-message route, no schema in
``/openapi.json``, no knob in ``/config``. An archive built from room reads could therefore
hold only the server's word, so the schema was built to say, per row, which of two claims it
was making.

Re-measured 2026-09-01, against 0.11.2: **the room now serves the signature.** ``?format=json``
carries ``sig`` beside ``nonce`` on every record written since 0.11.0 (2026-08-31), on the
``?since=`` path this archive reads, and ``/r/<room>/export`` dumps the same bytes. Confirmed
by verifying 200 unrelated ``lobby`` records here, and by round-tripping one of our own: the
signature came back byte-identical to the one signed offline. The earlier finding was true
when it was made; the service changed under it.

The two columns survive that, because the distinction was never about our plumbing:

    attested   the room showed a ``did:key`` sender and no signature we could check.
               technocore.chat verified one at write time; we did not see it. Trust in the
               service. Every record written before 0.11.0 is permanently in this class, and
               the service's own manual agrees: treat a missing ``sig`` as "not
               re-verifiable", never as "invalid".
    witnessed  we hold a signature that verified *here*, against the payload rebuilt from the
               stored row, for a message that really is in the room. Trust in mathematics.

What changed is the ratio, not the meaning. A third-party agent writing straight to the room
(FR-10) is now witnessed like anyone else, with nothing handed to us and no relay involved.
The field is still verified rather than believed: a ``sig`` the service reports but that does
not check out leaves the row attested, because "witnessed" names what we proved, not what we
were told.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator

from placement import is_signed_sender, parse as parse_placement
from verifier import VerifierError, message_payload, verify_payload

log = logging.getLogger(__name__)

SCHEMA_VERSION = 1

_SCHEMA = """
CREATE TABLE IF NOT EXISTS placement (
    seq      INTEGER PRIMARY KEY,
    ts       TEXT    NOT NULL,
    did      TEXT    NOT NULL,
    nonce    TEXT    NOT NULL,
    text     TEXT    NOT NULL,
    cx       INTEGER NOT NULL,
    cy       INTEGER NOT NULL,
    step     INTEGER NOT NULL,
    sig      TEXT,
    seen_at  REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS placement_cell ON placement (cy, cx, seq);
CREATE INDEX IF NOT EXISTS placement_did  ON placement (did);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Signatures that arrived before the placement they belong to.
--
-- The relay holds a signature the instant a write is accepted, but the ingest loop has not
-- read that message back yet, so there is no row to attach it to. Dropping it there was the
-- first implementation and it meant no browser placement was ever witnessed: the timing made
-- the feature unreachable, silently, while every test passed.
--
-- Parked here instead, and applied by the ingest loop the moment the row lands.
CREATE TABLE IF NOT EXISTS pending_signature (
    seq     INTEGER PRIMARY KEY,
    sig     TEXT NOT NULL,
    seen_at REAL NOT NULL
);
"""


class ArchiveError(Exception):
    """The archive refused to record something."""


@dataclass(frozen=True)
class Row:
    """One archived placement."""

    seq: int
    ts: str
    did: str
    nonce: str
    text: str
    cx: int
    cy: int
    step: int
    sig: str | None

    @property
    def witnessed(self) -> bool:
        """True when we hold a signature that verified here, not just the server's word."""
        return self.sig is not None


@dataclass(frozen=True)
class Stats:
    """What the archive holds, for the health endpoint and the watchdog."""

    last_seq: int
    placements: int
    witnessed: int
    signers: int
    room_last_seq: int
    lag: int
    pending: int


class Archive:
    """A SQLite-backed record of every placement seen in the canvas room.

    Not thread-safe by itself; the ingest loop and the HTTP server each open their own
    connection to the same file, which is what WAL mode is for.
    """

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(self.path, isolation_level=None, timeout=30)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        # FULL, not NORMAL: NORMAL lets a commit return before the write reaches the disk,
        # which is exactly the window RPO = 0 forbids. The room append itself is not fsynced
        # by the server (`/config` reports fsync false), so this archive is the only place a
        # placement is durable at all.
        self._db.execute("PRAGMA synchronous=FULL")
        self._db.execute("PRAGMA foreign_keys=ON")
        self._db.executescript(_SCHEMA)
        self._set_meta_if_absent("schema_version", str(SCHEMA_VERSION))
        self._set_meta_if_absent("last_seq", "0")
        self._set_meta_if_absent("room_last_seq", "0")

    def close(self) -> None:
        self._db.close()

    def __enter__(self) -> "Archive":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    # ---------------------------------------------------------------- meta

    def _set_meta_if_absent(self, key: str, value: str) -> None:
        self._db.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", (key, value)
        )

    def _meta_int(self, key: str) -> int:
        row = self._db.execute(
            "SELECT value FROM meta WHERE key = ?", (key,)
        ).fetchone()
        return int(row["value"]) if row else 0

    @property
    def last_seq(self) -> int:
        """The highest room sequence this archive has processed."""
        return self._meta_int("last_seq")

    # ---------------------------------------------------------------- writes

    def apply_batch(
        self, messages: Iterable[dict], room_last_seq: int | None = None
    ) -> tuple[int, int]:
        """Record a batch of room messages atomically.

        Every accepted placement and the new ``last_seq`` land in one transaction, so a crash
        can only leave the archive at a batch boundary — never with a placement stored and the
        cursor unmoved, which would re-ingest it, or the cursor moved past a placement that
        was never stored, which would lose it.

        Non-placements advance the cursor without being stored: the room is world-writable
        and most of its traffic is not ours.

        A message carrying ``sig`` is witnessed here if — and only if — that signature
        verifies against the payload rebuilt from the message's own room, nonce and swept
        text. One that does not verify is stored attested and logged, never dropped: the
        placement is in the room either way, and refusing to record it would let a bad
        signature erase a real pixel.

        Returns:
            (placements stored, sequences advanced past)

        Raises:
            ArchiveError: if a message is missing the fields the room API documents.
        """
        stored = 0
        highest = self.last_seq
        rows: list[tuple] = []

        for message in messages:
            try:
                seq = int(message["seq"])
                sender = str(message["from"])
                text = str(message["text"])
                ts = str(message["ts"])
                nonce = str(message.get("nonce", ""))
            except (KeyError, TypeError, ValueError) as exc:
                raise ArchiveError(
                    f"room message missing documented fields: {message!r}"
                ) from exc

            highest = max(highest, seq)
            if not is_signed_sender(sender):
                continue
            placement = parse_placement(text)
            if placement is None:
                continue
            rows.append(
                (
                    seq,
                    ts,
                    sender,
                    nonce,
                    text,
                    placement.cx,
                    placement.cy,
                    placement.step,
                    self._checked_signature(sender, nonce, text, message.get("sig"), seq),
                    time.time(),
                )
            )
            stored += 1

        seen = self.last_seq
        self._db.execute("BEGIN IMMEDIATE")
        try:
            if rows:
                # Not INSERT OR IGNORE: a row archived before the service served signatures
                # must be able to gain one when it is read again. The guard keeps that a
                # backfill and never a downgrade — a signature already verified here is
                # final, and re-reading the room can only fill a hole, not open one.
                self._db.executemany(
                    "INSERT INTO placement "
                    "(seq, ts, did, nonce, text, cx, cy, step, sig, seen_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(seq) DO UPDATE SET sig = excluded.sig "
                    "WHERE placement.sig IS NULL AND excluded.sig IS NOT NULL",
                    rows,
                )
            self._db.execute(
                "INSERT INTO meta (key, value) VALUES ('last_seq', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (str(highest),),
            )
            if room_last_seq is not None:
                self._db.execute(
                    "INSERT INTO meta (key, value) VALUES ('room_last_seq', ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (str(max(room_last_seq, highest)),),
                )
            self._db.execute("COMMIT")
        except Exception:
            self._db.execute("ROLLBACK")
            raise

        # Outside the transaction on purpose: a parked signature that does not verify must
        # not roll back placements that are perfectly good.
        if rows:
            self.apply_pending(row[0] for row in rows)
        return stored, highest - seen

    def _checked_signature(
        self, did: str, nonce: str, text: str, signature: object, seq: int
    ) -> str | None:
        """The signature to store for this message, or None to leave the row attested.

        The room is world-writable and this field arrives with the rest of it, so it is
        untrusted twice over: it may be absent, the wrong type, malformed, or a perfectly
        valid signature over something else entirely. Only one that verifies against the
        payload rebuilt from *this* message is kept.

        Never raises for bad data — a batch of good placements must not be lost to one bad
        field. It does propagate the ``room`` property's own error for an archive that has no
        room recorded, because that is a caller bug which would otherwise fail every
        signature and demote the whole canvas to attested in silence.

        Raises:
            ArchiveError: if a signature needs checking and no room has been recorded.
        """
        if not isinstance(signature, str) or not signature:
            return None
        try:
            payload = message_payload(self.room, nonce, text)
            if verify_payload(did, signature, payload):
                return signature
        except VerifierError as exc:
            log.warning("seq %d: unusable signature from the room (%s)", seq, exc)
            return None
        log.warning(
            "seq %d: the room served a signature that does not verify — storing attested",
            seq,
        )
        return None

    def witness(self, seq: int, signature: str) -> bool:
        """Attach a signature to an archived placement, if it verifies.

        The signature is checked against the payload rebuilt from the stored row — the room
        name, the nonce and the swept text — so a signature for a *different* message cannot
        be attached to this one. The row must already exist, which means the message really
        did reach the room: a signature alone proves possession of a key, not that anything
        was ever published.

        Returns:
            True if the signature verified and was stored; False if it did not verify.

        Raises:
            ArchiveError: if no placement is archived at ``seq``.
        """
        row = self._db.execute(
            "SELECT seq, did, nonce, text FROM placement WHERE seq = ?", (seq,)
        ).fetchone()
        if row is None:
            raise ArchiveError(f"no archived placement at seq {seq}")
        room = self.room
        try:
            payload = message_payload(room, row["nonce"], row["text"])
            if not verify_payload(row["did"], signature, payload):
                return False
        except VerifierError:
            return False
        self._db.execute("BEGIN IMMEDIATE")
        try:
            self._db.execute(
                "UPDATE placement SET sig = ? WHERE seq = ?", (signature, seq)
            )
            self._db.execute("COMMIT")
        except Exception:
            self._db.execute("ROLLBACK")
            raise
        return True

    def remember_signature(self, seq: int, signature: str) -> None:
        """Park a signature for a placement that has not been archived yet.

        No verification happens here: there is nothing to verify it against. The relay has
        already checked it against the room, nonce and text it forwarded, and
        :meth:`apply_pending` checks it again against the archived row before it counts.
        """
        self._db.execute(
            "INSERT INTO pending_signature (seq, sig, seen_at) VALUES (?, ?, ?) "
            "ON CONFLICT(seq) DO UPDATE SET sig = excluded.sig, seen_at = excluded.seen_at",
            (seq, signature, time.time()),
        )

    def apply_pending(self, seqs: Iterable[int]) -> int:
        """Attach any parked signatures for these sequences. Returns how many stuck.

        Each one is verified against the row as archived, not against what the relay was
        told, so a parked signature cannot claim a placement it does not match. A parked
        signature that fails is discarded rather than retried forever.
        """
        applied = 0
        for seq in seqs:
            row = self._db.execute(
                "SELECT sig FROM pending_signature WHERE seq = ?", (seq,)
            ).fetchone()
            if row is None:
                continue
            try:
                if self.witness(seq, row["sig"]):
                    applied += 1
            except ArchiveError:
                continue
            self._db.execute("DELETE FROM pending_signature WHERE seq = ?", (seq,))
        return applied

    @property
    def pending_signatures(self) -> int:
        """How many signatures are waiting for their placement to be archived."""
        return int(
            self._db.execute("SELECT COUNT(*) AS n FROM pending_signature").fetchone()["n"]
        )

    @property
    def room(self) -> str:
        row = self._db.execute("SELECT value FROM meta WHERE key = 'room'").fetchone()
        if row is None:
            raise ArchiveError("archive has no room recorded; set it before witnessing")
        return row["value"]

    @room.setter
    def room(self, name: str) -> None:
        self._db.execute(
            "INSERT INTO meta (key, value) VALUES ('room', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (name,),
        )

    def record_room_head(self, room_last_seq: int) -> None:
        """Record where the room's head was, so lag can be reported without a second read."""
        self._db.execute(
            "INSERT INTO meta (key, value) VALUES ('room_last_seq', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(room_last_seq),),
        )

    # ---------------------------------------------------------------- reads

    def cells(self) -> Iterator[Row]:
        """The newest placement in each occupied cell — the canvas as it stands."""
        query = (
            "SELECT seq, ts, did, nonce, text, cx, cy, step, sig FROM placement "
            "WHERE seq IN (SELECT MAX(seq) FROM placement GROUP BY cy, cx) "
            "ORDER BY cy, cx"
        )
        for row in self._db.execute(query):
            yield Row(**dict(row))

    def since(self, seq: int, limit: int = 1000) -> list[Row]:
        """Placements newer than ``seq``, oldest first — the delta a client applies."""
        query = (
            "SELECT seq, ts, did, nonce, text, cx, cy, step, sig FROM placement "
            "WHERE seq > ? ORDER BY seq LIMIT ?"
        )
        return [Row(**dict(row)) for row in self._db.execute(query, (seq, limit))]

    def history(self, cx: int, cy: int) -> list[Row]:
        """Every placement in one cell, oldest first. What FR-6 shows on hover."""
        query = (
            "SELECT seq, ts, did, nonce, text, cx, cy, step, sig FROM placement "
            "WHERE cx = ? AND cy = ? ORDER BY seq"
        )
        return [Row(**dict(row)) for row in self._db.execute(query, (cx, cy))]

    def stats(self) -> Stats:
        counts = self._db.execute(
            "SELECT COUNT(*) AS n, "
            "COUNT(sig) AS witnessed, "
            "COUNT(DISTINCT did) AS signers FROM placement"
        ).fetchone()
        last_seq = self.last_seq
        room_last_seq = self._meta_int("room_last_seq")
        return Stats(
            last_seq=last_seq,
            placements=counts["n"],
            witnessed=counts["witnessed"],
            signers=counts["signers"],
            room_last_seq=room_last_seq,
            lag=max(0, room_last_seq - last_seq),
            pending=self.pending_signatures,
        )
