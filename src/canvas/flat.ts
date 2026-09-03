/* The canvas seen straight on.
 *
 * The axonometric view is in `scene.ts` and it is not going away — elevation is how this
 * canvas shows that a cell was fought over, and nothing else we draw says that. But it is the
 * wrong default for the thing people come to do. A square grid drawn at 2:1 becomes a rhombus,
 * and a flag, a logo or a word drawn on a rhombus does not read as a flag, a logo or a word.
 * The whole culture this canvas is modelled on is people drawing exactly those, together, so a
 * projection that makes them illegible is a projection working against the product.
 *
 * Straight on, none of the machinery in `scene.ts` is needed, which is why this is a separate
 * file rather than a flag on that one:
 *
 *   - nothing occludes anything, so "which cell is under the pointer" is arithmetic rather
 *     than a visibility question, and there is no pick buffer to keep in step with the scene;
 *   - a cell's repaint touches one cell, not the diagonal of neighbours that can cover it;
 *   - grid lines are axis-aligned, so they clip to a rectangle without Liang-Barsky.
 *
 * The tower data is untouched. `Grid` still records every level and the snapshot still carries
 * it; this view draws the top of the stack, exactly as r/place does, and the history stays
 * available to the readout, to the tooltip and to the tilted view.
 */

import { COLS, ROWS, cellIndex } from "./projection.ts";
import { EMPTY, GRID_LINE, GROUND, PALETTE } from "./palette.ts";
import type { Grid } from "./grid.ts";
import type { Rect, Surface } from "./surface.ts";

/** Buffer pixels per cell. The view scales this; it only sets how crisp a zoomed-in cell is. */
export const CELL = 16;
export const FLAT_PAD = 8;
export const FLAT_W = COLS * CELL + FLAT_PAD * 2;
export const FLAT_H = ROWS * CELL + FLAT_PAD * 2;

/** One line every this many cells — the plot paper, not a grid on every cell. */
const RULE_EVERY = 8;

const ctx2d = (c: HTMLCanvasElement): CanvasRenderingContext2D => {
  const g = c.getContext("2d", { alpha: false });
  if (!g) throw new Error("2D canvas context unavailable");
  return g;
};

export class FlatScene implements Surface {
  private readonly buffer: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly grid: Grid;

  constructor(grid: Grid) {
    this.grid = grid;
    this.buffer = document.createElement("canvas");
    this.buffer.width = FLAT_W;
    this.buffer.height = FLAT_H;
    this.ctx = ctx2d(this.buffer);
    this.drawAll();
  }

  get bitmap(): HTMLCanvasElement {
    return this.buffer;
  }

  get bufferWidth(): number {
    return FLAT_W;
  }

  get bufferHeight(): number {
    return FLAT_H;
  }

  contestAt(index: number): number {
    return this.grid.contest[index] ?? 0;
  }

  drawAll(): void {
    const g = this.ctx;
    g.fillStyle = GROUND;
    g.fillRect(0, 0, FLAT_W, FLAT_H);
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) this.fillCell(cx, cy);
    }
    this.drawRules();
  }

  /**
   * Repaint one cell. Straight on, that is all a placement can have changed.
   *
   * The rules are redrawn over the cell rather than left broken: a filled square painted on
   * top of a line removes the line for as long as the cell is there, and a plot grid with
   * holes in it looks like a rendering fault.
   */
  invalidateCell(cx: number, cy: number): Rect {
    this.fillCell(cx, cy);
    const rect = this.cellRect(cx, cy);
    this.drawRules(rect);
    return rect;
  }

  /** Which cell a buffer point is in, or null outside the grid. */
  pick(bx: number, by: number): number | null {
    const cx = Math.floor((bx - FLAT_PAD) / CELL);
    const cy = Math.floor((by - FLAT_PAD) / CELL);
    if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return null;
    return cellIndex(cx, cy);
  }

  /**
   * The hover mark: a crosshair whose arms break either side of the cell.
   *
   * Never a filled highlight. The player is about to judge a colour against its neighbours,
   * and a mark that covers the cell hides the one thing they are looking at.
   */
  drawMark(g: CanvasRenderingContext2D, cell: number, colour: string, scale: number): void {
    const { x, y } = this.cellRect(cell % COLS, Math.floor(cell / COLS));
    const mid = CELL / 2;
    const arm = CELL * 1.6;
    const gap = CELL * 0.85;

    g.lineWidth = Math.max(1, 1.5 / scale);
    g.strokeStyle = colour;
    g.beginPath();
    g.moveTo(x + mid - gap - arm, y + mid);
    g.lineTo(x + mid - gap, y + mid);
    g.moveTo(x + mid + gap, y + mid);
    g.lineTo(x + mid + gap + arm, y + mid);
    g.moveTo(x + mid, y + mid - gap - arm);
    g.lineTo(x + mid, y + mid - gap);
    g.moveTo(x + mid, y + mid + gap);
    g.lineTo(x + mid, y + mid + gap + arm);
    g.stroke();

    g.strokeRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1);
  }

  get cellSide(): number {
    return CELL;
  }

  cellOrigin(cell: number): { x: number; y: number } {
    const { x, y } = this.cellRect(cell % COLS, Math.floor(cell / COLS));
    return { x, y };
  }

  private cellRect(cx: number, cy: number): Rect {
    return { x: FLAT_PAD + cx * CELL, y: FLAT_PAD + cy * CELL, w: CELL, h: CELL };
  }

  private fillCell(cx: number, cy: number): void {
    const step = this.grid.step[cellIndex(cx, cy)] ?? EMPTY;
    const { x, y } = this.cellRect(cx, cy);
    this.ctx.fillStyle = step === EMPTY ? GROUND : PALETTE[step]!;
    this.ctx.fillRect(x, y, CELL, CELL);
  }

  /** The plot paper. Bounded by `clip` when one is given, so a repaint stays small. */
  private drawRules(clip?: Rect): void {
    const g = this.ctx;
    g.strokeStyle = GRID_LINE;
    g.lineWidth = 1;
    g.beginPath();
    // Separate loops: the canvas is not square any more, so a vertical rule stops at COLS
    // and a horizontal one at ROWS. One shared loop drew lines past the edge of the grid.
    for (let i = 0; i <= COLS; i += RULE_EVERY) {
      const at = FLAT_PAD + i * CELL + 0.5;
      if (clip && (at < clip.x - 1 || at > clip.x + clip.w + 1)) continue;
      g.moveTo(at, clip ? Math.max(FLAT_PAD, clip.y) : FLAT_PAD);
      g.lineTo(at, clip ? Math.min(FLAT_H - FLAT_PAD, clip.y + clip.h) : FLAT_H - FLAT_PAD);
    }
    for (let i = 0; i <= ROWS; i += RULE_EVERY) {
      const at = FLAT_PAD + i * CELL + 0.5;
      if (clip && (at < clip.y - 1 || at > clip.y + clip.h + 1)) continue;
      g.moveTo(clip ? Math.max(FLAT_PAD, clip.x) : FLAT_PAD, at);
      g.lineTo(clip ? Math.min(FLAT_W - FLAT_PAD, clip.x + clip.w) : FLAT_W - FLAT_PAD, at);
    }
    g.stroke();
  }
}
