/* Who is holding the most of the canvas.
 *
 * Ranked by cells still held rather than by placements made. Repainting one cell four hundred
 * times is four hundred placements and one pixel, and a board that put that at the top would
 * be advertising the one habit a shared canvas does not need. The placement count comes back
 * too and is the more flattering of the two, which is a reason to show both rather than to
 * quietly pick the kinder number.
 *
 * Aggregated by the archive. The alternative is every visitor downloading the whole history to
 * count it themselves, which is the same answer computed from a much larger download once per
 * person.
 */

const TIMEOUT_MS = 8_000;

export interface Leader {
  readonly did: string;
  /** Cells whose newest placement is this key's. */
  readonly held: number;
  /** Every placement it ever made, including ones since painted over. */
  readonly placed: number;
  /** How many of the held cells carry a signature that verified here. */
  readonly witnessed: number;
}

const isLeader = (value: unknown): value is Leader => {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.did === "string" &&
    row.did.startsWith("did:key:") &&
    typeof row.held === "number" &&
    typeof row.placed === "number" &&
    typeof row.witnessed === "number" &&
    Number.isFinite(row.held) &&
    Number.isFinite(row.placed) &&
    Number.isFinite(row.witnessed)
  );
};

/**
 * The current board, or an empty list if the archive cannot answer.
 *
 * Empty rather than thrown: a ranking is decoration on a canvas that works without it, and an
 * archive that has not been updated yet answers 404 here. The interface shows nothing in that
 * case, which is the right amount to say about a number it does not have.
 *
 * Every field is checked rather than trusted. These strings are drawn into the page, and a
 * `held` that arrived as a string would render as one.
 */
export async function leaders(archiveUrl: string): Promise<Leader[]> {
  const abort = new AbortController();
  const bail = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${archiveUrl}/leaders`, { signal: abort.signal });
    if (!response.ok) return [];
    const body: unknown = await response.json();
    const rows = (body as { leaders?: unknown }).leaders;
    if (!Array.isArray(rows)) return [];
    return rows.filter(isLeader);
  } catch {
    return [];
  } finally {
    clearTimeout(bail);
  }
}
