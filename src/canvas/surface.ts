/* What the view needs from a projection, and nothing more.
 *
 * There are two: straight on (`flat.ts`, the default, where art is legible) and 2:1
 * axonometric (`scene.ts`, where a contested cell stands up as a column). They share almost
 * no machinery — elevation is what forces a pick buffer, an occlusion-aware repaint region and
 * clipped diagonal rules, and none of that exists in a grid seen face on.
 *
 * So they are separate implementations behind this, rather than one renderer with a flag. The
 * flag version was considered and is worse: every method would branch, and the branch that
 * runs for the view nobody is looking at is the branch that quietly rots.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Surface {
  /** The offscreen bitmap the view blits under its transform. */
  readonly bitmap: HTMLCanvasElement;
  /** Its dimensions at scale 1. They differ per projection, so the view asks rather than assumes. */
  readonly bufferWidth: number;
  readonly bufferHeight: number;

  /** Redraw everything. Called on load and on a wholesale state replacement. */
  drawAll(): void;

  /** Redraw what a change at one cell can have altered. Returns the region that changed. */
  invalidateCell(cx: number, cy: number): Rect;

  /** Which cell a buffer point is in, or null for none. */
  pick(bx: number, by: number): number | null;

  /** How often a cell has been overwritten. The readout reports it; elevation may encode it. */
  contestAt(index: number): number;

  /** Where a cell sits in buffer space. Used to anchor a panel to a cell rather than to the
   *  pointer, which is what a keyboard cursor needs. */
  cellOrigin(cell: number): { x: number; y: number };

  /**
   * Draw the hover mark for `cell`, in buffer space.
   *
   * Each projection owns its own geometry — the mark sits on a rhombus in one and a square in
   * the other — and `scale` is passed so the stroke stays one screen pixel at any zoom.
   */
  drawMark(
    g: CanvasRenderingContext2D,
    cell: number,
    colour: string,
    scale: number,
  ): void;
}
