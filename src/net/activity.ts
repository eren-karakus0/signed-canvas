/* The canvas's pulse: how many pixels landed, bucket by bucket.
 *
 * The header used to answer "how many pixels are there" and nothing else. That is a total, and
 * a total cannot say whether anything is happening — a canvas that had five hundred placements
 * last year and none since reads exactly like one that is busy right now.
 *
 * Bucketed by the archive rather than here. The alternative is every visitor downloading the
 * whole history to count it themselves, which is the same answer computed from a much larger
 * download once per person.
 */

const TIMEOUT_MS = 8_000;

export interface Activity {
  /** Placements per bucket, oldest first. */
  readonly buckets: readonly number[];
  /** How many hours each bucket covers. */
  readonly bucketHours: number;
}

/**
 * The recent pulse, or null if the archive cannot answer.
 *
 * Null rather than thrown, and null rather than an empty array: the strip is decoration on a
 * canvas that works without it, and an archive that has not been updated yet answers 404 here.
 * An empty array would draw a flat line, which is a claim about the canvas rather than an
 * admission that we do not know.
 */
export async function activity(archiveUrl: string): Promise<Activity | null> {
  const abort = new AbortController();
  const bail = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${archiveUrl}/activity`, { signal: abort.signal });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const buckets = (body as { buckets?: unknown }).buckets;
    const bucketHours = (body as { bucket_hours?: unknown }).bucket_hours;
    // Checked rather than trusted: these become bar heights, and a string that arrived where
    // a number was expected would size a bar by its character count.
    if (!Array.isArray(buckets) || buckets.length === 0) return null;
    if (!buckets.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) return null;
    if (typeof bucketHours !== "number" || !Number.isFinite(bucketHours) || bucketHours <= 0) {
      return null;
    }
    return { buckets: buckets as number[], bucketHours };
  } catch {
    return null;
  } finally {
    clearTimeout(bail);
  }
}
