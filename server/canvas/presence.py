"""Who is looking at the canvas right now.

This is the one number on the page that cannot be proved, and the interface says so. Every
other figure rests on a signature: a pixel is witnessed because the signature verified here.
A viewer count rests on browsers volunteering that they exist, and a browser can say anything.
It is a courtesy figure, not evidence, and dressing it up as evidence would undo the one claim
this product actually makes.

Why it is not technocore.chat's presence convention (`/kv/<room>/hb-<nick>/set/<seq>`),
checked against the live service on 2026-09-03:

  - notes have no server-side expiry, so one key per visitor accumulates forever in a shared
    public namespace capped at 131072 — a leak into someone else's service, not just ours;
  - `GET /kv/<ns>` lists key names only, with no write time, so liveness has to be inferred
    from the value, which is "the seq you last saw";
  - that inference fails exactly when this canvas is quiet. With no placements for a day,
    every heartbeat still holds the same seq, so someone who visited last week reads as
    present. A count that cannot tell a live viewer from an old one is a count that lies.

So presence is held here, in memory, where a last-seen time is exact and expiry is real.
Nothing is persisted: this answers "now", and a restart correctly forgets everyone.
"""

from __future__ import annotations

import re
import threading

# 16 hex characters, generated per page load in the browser. Not the visitor's did:key: a
# viewer count has no business learning which identity is reading, and a per-load id counts
# what the number claims to count — open tabs — rather than people or keys.
VIEWER_PATTERN = re.compile(r"^[0-9a-f]{16}$")

# Long enough that one missed beat does not drop a viewer, short enough that a closed tab
# leaves promptly. The client beats at a third of this.
DEFAULT_WINDOW_SECONDS = 45.0

# A ceiling on what one process will track. Reached only under a flood of invented ids, which
# nothing can prevent — see the module docstring.
DEFAULT_CAPACITY = 20_000


class Presence:
    """Last-seen times for viewers, bounded in size and swept on every use.

    Safe to call from several request threads: the server hands each connection its own
    thread, so an unguarded dict would drop beats under concurrent writes.
    """

    def __init__(
        self,
        window_seconds: float = DEFAULT_WINDOW_SECONDS,
        capacity: int = DEFAULT_CAPACITY,
    ) -> None:
        if window_seconds <= 0:
            raise ValueError("window_seconds must be positive")
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self._window = window_seconds
        self._capacity = capacity
        self._seen: dict[str, float] = {}
        self._lock = threading.Lock()

    @property
    def capacity(self) -> int:
        return self._capacity

    def beat(self, viewer: str, now: float) -> tuple[int, bool]:
        """Record that `viewer` is here, and answer how many are.

        Returns the count and whether the tracker is at capacity, so the caller can say
        "20000+" rather than state a number it knows is a floor.

        :raises ValueError: if `viewer` is not 16 hex characters.
        """
        if not VIEWER_PATTERN.match(viewer):
            raise ValueError("viewer must be 16 hex characters")
        with self._lock:
            self._sweep(now)
            if viewer not in self._seen and len(self._seen) >= self._capacity:
                return len(self._seen), True
            self._seen[viewer] = now
            return len(self._seen), len(self._seen) >= self._capacity

    def count(self, now: float) -> int:
        """How many viewers have beaten within the window."""
        with self._lock:
            self._sweep(now)
            return len(self._seen)

    def _sweep(self, now: float) -> None:
        """Drop viewers whose last beat fell out of the window. Caller holds the lock.

        A clock that moves backwards would otherwise strand entries forever, so a last-seen
        time in the future is treated as now rather than trusted.
        """
        cutoff = now - self._window
        stale = [viewer for viewer, at in self._seen.items() if at <= cutoff]
        for viewer in stale:
            del self._seen[viewer]
