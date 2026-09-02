/* The placement wire format — the whole contract with agents (FR-10).
 *
 *     px <x>,<y> <step> <token>        e.g.  px 12,47 3 k8f2a1
 *
 * An agent needs nothing from us but this string, so parsing is strict in both directions: a
 * line that is nearly a placement is not one. Guessing would let a typo paint a pixel nobody
 * meant, and the signature over that typo would be perfectly valid.
 *
 * `step` is one base36 digit, not a decimal number. It was hex until the palette outgrew
 * fifteen colours, which is all four bits could ever have held; `1`-`f` keep their exact
 * meaning, so every pixel ever placed still means what it meant. Two spellings of one pixel would mean two
 * different signed strings for one meaning — and it is not hypothetical: the T-2 load test
 * wrote decimal, and 85 of its lines are in the room now, correctly refused by this parser.
 *
 * This mirrors `server/canvas/placement.py`. They are two implementations of one grammar and
 * both are held to the examples below.
 */

import { N } from "./projection.ts";

/** Anchored, single spaces: the server has already swept the text, so any other spacing is a
 *  different string and was signed as one. */
const PLACEMENT = /^px (\d{1,2}),(\d{1,2}) ([0-9a-z]) ([0-9a-z]{6})$/;

export const MIN_STEP = 1;
export const MAX_STEP = 35;

export interface Placement {
  readonly cx: number;
  readonly cy: number;
  readonly step: number;
  readonly token: string;
}

/**
 * The placement in `text`, or null if the line is not one.
 *
 * Returns null rather than throwing: a room is world-writable and most of its lines will not
 * be placements. That is ordinary traffic, not an error.
 */
export function parsePlacement(text: string): Placement | null {
  const match = PLACEMENT.exec(text);
  if (match === null) return null;
  const cx = Number(match[1]);
  const cy = Number(match[2]);
  const step = parseInt(match[3]!, 36);
  if (cx >= N || cy >= N) return null;
  if (step < MIN_STEP || step > MAX_STEP) return null;
  return { cx, cy, step, token: match[4]! };
}

/**
 * The line to sign and write.
 *
 * @throws RangeError if the cell is outside the canvas or the step is not writable — the
 * caller has a bug, and signing a malformed line would publish it permanently.
 */
export function formatPlacement(cx: number, cy: number, step: number, token: string): string {
  if (!Number.isInteger(cx) || !Number.isInteger(cy) || cx < 0 || cy < 0 || cx >= N || cy >= N) {
    throw new RangeError(`cell out of bounds: ${cx},${cy}`);
  }
  if (!Number.isInteger(step) || step < MIN_STEP || step > MAX_STEP) {
    throw new RangeError(`not a writable step: ${step}`);
  }
  if (!/^[0-9a-z]{6}$/.test(token)) {
    throw new RangeError(`token must be six base36 characters: ${token}`);
  }
  return `px ${cx},${cy} ${step.toString(36)} ${token}`;
}
