/* The cell state the renderer draws. Nothing here knows about signatures or the network:
   the archiver and the room feed it, and it only ever holds what has already been verified. */

import { MAX_CONTEST, N, cellIndex, inBounds } from "./projection.ts";
import { MAX_STEP } from "./wire.ts";
import { EMPTY } from "./palette.ts";

export interface Cell {
  readonly cx: number;
  readonly cy: number;
  readonly step: number;
  readonly contest: number;
}

export class Grid {
  /** Palette index per cell, 0 = empty. This is the *top* of the tower. */
  readonly step = new Uint8Array(N * N);
  /** How many times the cell has been overwritten. Drives elevation. */
  readonly contest = new Uint8Array(N * N);
  /**
   * The colours *under* the top, `MAX_CONTEST` slots per cell, bottom first. 0 = no level.
   *
   * A contested cell is drawn as a column, and every level of it used to take the newest
   * colour — so painting over a tall stack repainted the whole building. The tower is the
   * cell's history standing up, and history does not change colour when something new lands
   * on top of it.
   *
   * Bounded because the elevation is: past `MAX_CONTEST` levels the column leaves the
   * viewport, so a cell contested more often keeps its most recent levels. The server packs
   * the same window, and `snapshot.py` carries the matching constant.
   */
  readonly layers = new Uint8Array(N * N * MAX_CONTEST);

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
    if (!Number.isInteger(step) || step <= EMPTY || step > MAX_STEP) {
      throw new RangeError(`not a writable palette step: ${step}`);
    }
    const i = cellIndex(cx, cy);
    const before = this.step[i]!;
    if (before === step) return false;
    if (before !== EMPTY) {
      this.pushLevel(i, before);
      if (this.contest[i]! < 255) this.contest[i]!++;
    }
    this.step[i] = step;
    return true;
  }

  /** The colour at `level` under the top of a cell, or 0 if the tower is not that tall. */
  levelAt(index: number, level: number): number {
    if (level < 0 || level >= MAX_CONTEST) return EMPTY;
    return this.layers[index * MAX_CONTEST + level]!;
  }

  /**
   * Push the colour being covered onto the cell's tower.
   *
   * Once the tower is full the oldest level is dropped rather than the newest refused: the
   * column shows the most recent history, which is the part that is still being contested.
   */
  private pushLevel(index: number, step: number): void {
    const base = index * MAX_CONTEST;
    const depth = Math.min(this.contest[index]!, MAX_CONTEST);
    if (depth < MAX_CONTEST) {
      this.layers[base + depth] = step;
      return;
    }
    this.layers.copyWithin(base, base + 1, base + MAX_CONTEST);
    this.layers[base + MAX_CONTEST - 1] = step;
  }

  /**
   * Replace a cell outright: its top colour and the tower beneath it.
   *
   * Used when loading a snapshot, where the server already knows the whole column. Going
   * through `place` instead would rebuild the tower one placement at a time and, with only
   * the top colour to hand, produce a flat canvas — which is exactly what a reload used to
   * show.
   *
   * @throws RangeError if the cell is outside the canvas.
   */
  restore(cx: number, cy: number, step: number, tower: readonly number[]): void {
    if (!inBounds(cx, cy)) throw new RangeError(`cell out of bounds: ${cx},${cy}`);
    const i = cellIndex(cx, cy);
    const base = i * MAX_CONTEST;
    let depth = 0;
    for (let level = 0; level < MAX_CONTEST; level++) {
      const colour = tower[level] ?? EMPTY;
      // 0 terminates: a gap would mean a floating level, which cannot happen and must not
      // be drawn as though it had.
      this.layers[base + level] = depth === level && colour !== EMPTY ? colour : EMPTY;
      if (depth === level && colour !== EMPTY) depth++;
    }
    this.step[i] = step;
    this.contest[i] = depth;
  }

  /** Count of cells a player has marked. Used by the readout, not by the renderer. */
  painted(): number {
    let n = 0;
    for (let i = 0; i < this.step.length; i++) if (this.step[i] !== EMPTY) n++;
    return n;
  }
}
