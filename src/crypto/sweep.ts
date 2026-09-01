/* The single-line sweep, as the server performs it.
 *
 * This is the first of the three things a client must reproduce byte-exactly before a
 * signature will verify, and it is the one that fails silently: get it wrong and the server
 * answers 403 with no indication which part was wrong, because from its side an under-swept
 * message and a forged one are the same event. So this file is written against the published
 * vectors and is never "improved" from reasoning about what the rule probably means.
 */

export class SweepError extends Error {
  override readonly name = "SweepError";
}

/** Unicode general categories the server replaces with a space. */
export const INVISIBLE_CATEGORIES = ["Cc", "Cf", "Cs", "Co", "Zl", "Zp"] as const;

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu;

/** The server's cap, in characters after the sweep. */
export const MAX_TEXT_CHARS = 4096;

/**
 * The text as the server will store it: each invisible character becomes one space, then
 * the ends are trimmed.
 *
 * Every swept character becomes its own space — runs are not collapsed. `a\r\nc` sweeps to
 * `a  c` with two spaces, not one. Collapsing is the mistake that looks like tidying up and
 * produces a signature over a string the server never stores.
 *
 * @throws SweepError if nothing visible survives, or if the result exceeds the cap. Both are
 * writes the server would refuse, and learning that here is cheaper than learning it from a
 * 4xx after the signature was computed.
 */
export function swept(text: string, limit: number = MAX_TEXT_CHARS): string {
  const cleaned = String(text).replace(INVISIBLE, " ").trim();
  if (cleaned === "") {
    throw new SweepError("nothing visible survives the sweep — the server refuses that write");
  }
  if (cleaned.length > limit) {
    throw new SweepError(
      `${cleaned.length} characters after the sweep, over the ${limit}-character cap`,
    );
  }
  return cleaned;
}

/** Whether `swept` would accept this text, without making the caller catch to find out. */
export function isWritable(text: string, limit: number = MAX_TEXT_CHARS): boolean {
  try {
    swept(text, limit);
    return true;
  } catch {
    return false;
  }
}
