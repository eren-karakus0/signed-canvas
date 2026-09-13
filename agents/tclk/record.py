"""The durable record of one deal.

The room is coordination; this file is the record. That is not a preference — `/r/tclk-offers`
takes about four messages a second, so a frame we sent leaves the readable window within
minutes, and a deal that tried to resume by re-reading the room would find nothing. The tclk
spec says the same in its own words: *"the room is coordination, not the record. Both parties
persist frames they care about."*

Written before the next frame is emitted. The ordering matters more than it looks: a frame
that reached the room but not this file is a frame we would send again on resume, and the
counterparty would see it twice.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any


class RecordError(RuntimeError):
    """The record could not be read or written."""


def _fsync_directory(directory: Path) -> None:
    """Make a rename durable, where the platform offers that.

    A rename is only on the disk once the directory entry is, so POSIX needs this. Windows
    refuses to open a directory for reading at all — not a failure to handle but a platform
    that does not offer the guarantee. The rename is still atomic there, and a deal that lost
    its last frame to a power cut re-reads the room for it.
    """
    try:
        handle = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(handle)
    except OSError:
        pass
    finally:
        os.close(handle)


class DealRecord:
    """One deal's frames, in the order they happened, on disk.

    Not a general store: one file, one contract, named by the contract id. A deal is small and
    always read whole, so rewriting it atomically is simpler than appending to a log and
    cheaper than the bugs an append format invites.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self._state: dict[str, Any] = {"frames": []}
        if path.exists():
            self._state = self._read()

    @classmethod
    def open(cls, directory: Path, contract: str, **fields: Any) -> "DealRecord":
        """The record for `contract`, created with `fields` if it does not exist yet.

        :raises RecordError: if the directory cannot be made, or the file cannot be read or
            written.
        """
        try:
            directory.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise RecordError(f"cannot create {directory}: {exc}") from exc
        record = cls(directory / f"{contract[2:18]}.json")
        if not record.path.exists():
            record._state = {"contract": contract, "opened_at": time.time(), **fields}
            record._state["frames"] = []
            record._write()
        return record

    @classmethod
    def find(cls, directory: Path, identifier: str) -> "DealRecord":
        """The record for an offer id or a contract id.

        A deal is filed under the offer id, because that exists from the moment the offer is
        built. It is *named* by the contract id, which only exists once somebody accepts — so
        the same deal answers to two identifiers, and anything looking one up may hold either.

        :raises RecordError: if no record matches.
        """
        direct = directory / f"{identifier[2:18]}.json"
        if direct.exists():
            return cls(direct)
        for path in sorted(directory.glob("*.json")):
            record = cls(path)
            if record.contract == identifier:
                return record
            frames = record.frames
            if frames and frames[0].get("frame", {}).get("id") == identifier:
                return record
            for entry in frames:
                if entry.get("frame", {}).get("contract") == identifier:
                    return record
        raise RecordError(f"no deal in {directory} answers to {identifier[:18]}…")

    @property
    def contract(self) -> str:
        return str(self._state.get("contract", ""))

    @property
    def frames(self) -> list[dict[str, Any]]:
        """Every frame recorded, oldest first. Copies: callers must not edit history."""
        return [dict(entry) for entry in self._state["frames"]]

    def get(self, field: str, default: Any = None) -> Any:
        return self._state.get(field, default)

    def set(self, **fields: Any) -> None:
        """Store fields that belong to the deal rather than to any one frame."""
        self._state.update(fields)
        self._write()

    def append(
        self, *, label: str, room: str, seq: int, sender: str, frame: dict
    ) -> None:
        """Record one frame, on disk, before anything else happens.

        Idempotent on `(room, seq)`: overlapping reads deliver a frame we already hold, and
        recording it twice would make the rebuild see two accepts and refuse the second.

        :raises RecordError: if the file cannot be written.
        """
        for entry in self._state["frames"]:
            if entry["room"] == room and entry["seq"] == seq:
                return
        self._state["frames"].append(
            {
                "label": label,
                "room": room,
                "seq": seq,
                "from": sender,
                "frame": frame,
                "seen_at": time.time(),
            }
        )
        self._write()

    def _read(self) -> dict[str, Any]:
        try:
            state = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RecordError(f"cannot read {self.path}: {exc}") from exc
        if not isinstance(state, dict) or not isinstance(state.get("frames"), list):
            raise RecordError(f"{self.path} is not a deal record")
        return state

    def _write(self) -> None:
        """Replace the file atomically and get it onto the disk before returning.

        Written to a temporary file beside the target and renamed, so a crash mid-write leaves
        the previous record rather than a truncated one.
        """
        payload = json.dumps(self._state, indent=2, sort_keys=True)
        directory = self.path.parent
        temporary: str | None = None
        try:
            handle_fd, temporary = tempfile.mkstemp(
                dir=directory, prefix=".deal-", suffix=".tmp"
            )
            with os.fdopen(handle_fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            temporary = None
            _fsync_directory(directory)
        except OSError as exc:
            raise RecordError(f"cannot write {self.path}: {exc}") from exc
        finally:
            if temporary is not None and os.path.exists(temporary):
                # The replace never happened; leaving a .deal-*.tmp behind would look like a
                # crash artefact to the next reader.
                os.unlink(temporary)
