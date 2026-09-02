/* How many people are looking at the canvas.
 *
 * The archive holds the count, because it can hold an exact last-seen time and expire it.
 * technocore.chat's presence convention cannot: its notes have no expiry, `GET /kv/<ns>` lists
 * key names without a write time, and the value it standardises is "the seq you last saw" —
 * which stops distinguishing a live viewer from an old one exactly when the canvas is quiet.
 * Using it would also leave one permanent note per visitor in a shared public namespace.
 *
 * The id is invented per page load and is not the visitor's did:key. A viewer count has no
 * business learning which identity is reading, and a per-load id counts what the number
 * claims to count: open tabs, not people and not keys.
 *
 * A hidden tab does not beat. It is not looking, and a browser suspends its timers anyway, so
 * beating on the way out would only mean claiming a viewer that is not there for as long as
 * the window lasts.
 */

const BEAT_MS = 15_000;
const TIMEOUT_MS = 8_000;

/** Told to the caller when the count is unknown, so it can say nothing rather than "0". */
export type Watching = number | null;

export interface PresenceEvents {
  /** The count changed, or became unknown. `capped` means the answer is a floor. */
  onCount(watching: Watching, capped: boolean): void;
}

const viewerId = (): string => {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Beat while this tab is visible, reporting the count each time.
 *
 * Returns a function that stops it. Never throws: a viewer count that could break the page it
 * decorates would be worse than no viewer count, so a failed beat reports "unknown" and the
 * next one tries again.
 */
export function follow(archiveUrl: string, events: PresenceEvents): () => void {
  const id = viewerId();
  let timer = 0;
  let stopped = false;
  let inFlight: AbortController | null = null;

  const beat = async (): Promise<void> => {
    if (stopped || document.hidden) return;
    inFlight?.abort();
    const abort = new AbortController();
    inFlight = abort;
    const bail = setTimeout(() => abort.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${archiveUrl}/presence/${id}`, { signal: abort.signal });
      if (!response.ok) throw new Error(String(response.status));
      const body: unknown = await response.json();
      const viewers = (body as { viewers?: unknown }).viewers;
      const capped = (body as { capped?: unknown }).capped === true;
      // Checked rather than trusted: this is drawn into the page, and a number that arrived
      // as a string would render as one.
      if (typeof viewers !== "number" || !Number.isFinite(viewers) || viewers < 0) {
        throw new Error("the archive did not answer with a count");
      }
      if (!stopped) events.onCount(Math.floor(viewers), capped);
    } catch {
      // Includes the abort on stop, which is why nothing is reported after stopping.
      if (!stopped) events.onCount(null, false);
    } finally {
      clearTimeout(bail);
      if (inFlight === abort) inFlight = null;
    }
  };

  const onVisibility = (): void => {
    // Coming back should show a current number rather than the one from before the tab was
    // hidden, which by now is as old as the absence.
    if (!document.hidden) void beat();
  };

  void beat();
  timer = window.setInterval(() => void beat(), BEAT_MS);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    stopped = true;
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibility);
    inFlight?.abort();
  };
}
