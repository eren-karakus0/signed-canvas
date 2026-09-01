/* The cell state the renderer draws. Nothing here knows about signatures or the network:
   the archiver and the room feed it, and it only ever holds what has already been verified. */

import { N, cellIndex, inBounds } from "./projection.ts";
import { EMPTY } from "./palette.ts";

export interface Cell {
  readonly cx: number;
  readonly cy: number;
  readonly step: number;
  readonly contest: number;
}

export class Grid {
  /** Palette index per cell, 0 = empty. */
  readonly step = new Uint8Array(N * N);
  /** How many times the cell has been overwritten. Drives elevation. */
  readonly contest = new Uint8Array(N * N);

  get(cx: number, cy: number): Cell | null {
    if (!inBounds(cx, cy)) return null;
    const i = cellIndex(cx, cy);
    return { cx, cy, step: this.step[i]!, contest: this.contest[i]! };
  }

  /**
   * Apply a placement. Returns true if anything changed, so callers can skip a repaint.
   * Contest counts overwrites, not placements: the first mark on an empty cell is not a
   * contest, and re-placing the same colour on the same cell is not one either.
   *
   * @throws RangeError if the cell is outside the canvas or the step is not writable.
   */
  place(cx: number, cy: number, step: number): boolean {
    if (!inBounds(cx, cy)) throw new RangeError(`cell out of bounds: ${cx},${cy}`);
    if (!Number.isInteger(step) || step <= EMPTY || step > 15) {
      throw new RangeError(`not a writable palette step: ${step}`);
    }
    const i = cellIndex(cx, cy);
    const before = this.step[i]!;
    if (before === step) return false;
    if (before !== EMPTY && this.contest[i]! < 255) this.contest[i]!++;
    this.step[i] = step;
    return true;
  }

  /** Count of cells a player has marked. Used by the readout, not by the renderer. */
  painted(): number {
    let n = 0;
    for (let i = 0; i < this.step.length; i++) if (this.step[i] !== EMPTY) n++;
    return n;
  }
}
