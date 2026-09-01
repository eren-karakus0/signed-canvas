/* The renderer.
 *
 * ADR 0002 measured the naive approach — redraw 4,096 cells every frame — at 36 fps p50,
 * which fails NFR-7. So the scene is drawn once into an offscreen bitmap and the view
 * blits it under a transform, and a placement repaints only the region it can affect.
 * Neither of those is an optimisation here; both are load-bearing.
 *
 * A second offscreen buffer encodes each cell's index as a colour. Elevation makes "which
 * cell did the pointer land on" a visibility question rather than a geometry one — a raised
 * tile hides the tiles behind it — and reading one pixel answers it exactly, where inverse
 * projection would answer it wrongly for every occluded cell.
 */

import {
  BUF_H,
  BUF_W,
  LIFT,
  MAX_CONTEST,
  N,
  OX,
  OY,
  PAD,
  TH,
  TW,
  cellIndex,
  cellTop,
} from "./projection.ts";
import { EMPTY, FACE_LEFT, FACE_RIGHT, GRID_LINE, GROUND, PATINA } from "./palette.ts";
import type { Grid } from "./grid.ts";

/** Scene bitmap resolution multiplier. Keeps 0-radius edges crisp when zoomed in. */
const SS = 2;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const ctx2d = (c: HTMLCanvasElement, readback: boolean): CanvasRenderingContext2D => {
  const g = c.getContext("2d", { alpha: true, willReadFrequently: readback });
  if (!g) throw new Error("2D canvas context unavailable");
  return g;
};

export class Scene {
  private readonly sceneBuf: HTMLCanvasElement;
  private readonly sceneCtx: CanvasRenderingContext2D;
  private readonly pickBuf: HTMLCanvasElement;
  private readonly pickCtx: CanvasRenderingContext2D;

  private readonly grid: Grid;

  constructor(grid: Grid) {
    this.grid = grid;
    this.sceneBuf = document.createElement("canvas");
    this.sceneBuf.width = BUF_W * SS;
    this.sceneBuf.height = BUF_H * SS;
    this.sceneCtx = ctx2d(this.sceneBuf, false);
    this.sceneCtx.scale(SS, SS);

    // The pick buffer stays at 1:1. It is sampled, never shown, so resolution buys nothing.
    this.pickBuf = document.createElement("canvas");
    this.pickBuf.width = BUF_W;
    this.pickBuf.height = BUF_H;
    this.pickCtx = ctx2d(this.pickBuf, true);

    this.drawAll();
  }

  get bitmap(): HTMLCanvasElement {
    return this.sceneBuf;
  }

  /** Contest count for a linear cell index. The view needs it to place the hover mark. */
  contestAt(index: number): number {
    return this.grid.contest[index] ?? 0;
  }

  /** Full redraw. ~25–30 ms measured; called on load and on a wholesale state replacement. */
  drawAll(): void {
    this.sceneCtx.clearRect(0, 0, BUF_W, BUF_H);
    this.pickCtx.clearRect(0, 0, BUF_W, BUF_H);
    this.drawGround();
    for (let cy = 0; cy < N; cy++) {
      for (let cx = 0; cx < N; cx++) this.drawCell(cx, cy);
    }
  }

  /**
   * Repaint everything that a change at one cell can have altered: the cell itself, whatever
   * it now covers, and whatever now covers it. Returns the buffer-space rect that changed.
   */
  invalidateCell(cx: number, cy: number): Rect {
    const rect = this.cellRect(cx, cy);
    this.redrawRegion(rect);
    return rect;
  }

  private cellRect(cx: number, cy: number): Rect {
    // Vertical extent is taken at the maximum lift, not the current one: the cell may have
    // just grown, and the region has to cover where it is going as well as where it was.
    const flatY = OY + (cx + cy) * (TH / 2);
    return {
      x: OX + (cx - cy) * (TW / 2) - TW / 2,
      y: flatY - MAX_CONTEST * LIFT,
      w: TW,
      h: TH + MAX_CONTEST * LIFT,
    };
  }

  private redrawRegion(rect: Rect): void {
    const pad = 1; // antialiased edges bleed a fraction of a pixel past the geometry
    const r: Rect = { x: rect.x - pad, y: rect.y - pad, w: rect.w + pad * 2, h: rect.h + pad * 2 };

    // Bound the candidate cells by inverting the projection at the rect's corners. The
    // bound is deliberately loose; each candidate is then tested against the rect, which
    // turns a few hundred candidates into a few dozen actual draws.
    const dLo = (2 * (r.x - OX - TW / 2)) / TW;
    const dHi = (2 * (r.x + r.w - OX + TW / 2)) / TW;
    const sLo = (2 * (r.y - OY - TH)) / TH;
    const sHi = (2 * (r.y + r.h - OY + MAX_CONTEST * LIFT)) / TH;

    const cxLo = Math.max(0, Math.floor((sLo + dLo) / 2));
    const cxHi = Math.min(N - 1, Math.ceil((sHi + dHi) / 2));
    const cyLo = Math.max(0, Math.floor((sLo - dHi) / 2));
    const cyHi = Math.min(N - 1, Math.ceil((sHi - dLo) / 2));

    // One clip per surface, not one per pass: on a GPU-backed canvas each save/clip/restore
    // can force a flush, and doing it twice per surface was measurable.
    for (const g of [this.sceneCtx, this.pickCtx]) {
      const isPick = g === this.pickCtx;
      g.save();
      g.beginPath();
      g.rect(r.x, r.y, r.w, r.h);
      g.clip();
      g.clearRect(r.x, r.y, r.w, r.h);
      if (!isPick) this.drawGround(r);
      // Row-major ascending is a valid back-to-front order: a cell can only be covered by
      // (cx+1,cy), (cx,cy+1) and (cx+1,cy+1), all of which come later in this order.
      for (let cy = cyLo; cy <= cyHi; cy++) {
        for (let cx = cxLo; cx <= cxHi; cx++) {
          if (!this.cellIntersects(cx, cy, r)) continue;
          this.drawCellTo(g, cx, cy, isPick);
        }
      }
      g.restore();
    }
  }

  private cellIntersects(cx: number, cy: number, r: Rect): boolean {
    const b = this.cellRect(cx, cy);
    return !(b.x > r.x + r.w || b.x + b.w < r.x || b.y > r.y + r.h || b.y + b.h < r.y);
  }

  private drawGround(clip?: Rect): void {
    const g = this.sceneCtx;
    g.fillStyle = GROUND;
    if (clip) g.fillRect(clip.x, clip.y, clip.w, clip.h);
    else g.fillRect(0, 0, BUF_W, BUF_H);

    // The plot paper: one line every 8 cells, 1px, never a decorative grid.
    //
    // Each line spans the whole buffer, so on a small repaint the clip alone is not enough
    // — measured at 11.2 ms per placement in Chromium, against 13.7 ms for redrawing all
    // 4,096 cells, which meant the dirty region was buying nothing. Culling by bounding box
    // is what actually makes the region small.
    g.strokeStyle = GRID_LINE;
    g.lineWidth = 1;
    for (let i = 0; i <= N; i += 8) {
      this.strokeSegment(
        OX - i * (TW / 2), OY + i * (TH / 2),
        OX + (N - i) * (TW / 2), OY + (N + i) * (TH / 2),
        clip,
      );
      this.strokeSegment(
        OX + i * (TW / 2), OY + i * (TH / 2),
        OX + (i - N) * (TW / 2), OY + (i + N) * (TH / 2),
        clip,
      );
    }
  }

  /**
   * Stroke a segment, or the part of it inside `clip`. A bounding-box test is not enough
   * here: these lines are full-length diagonals, so their boxes cover half the buffer and
   * would reject almost nothing.
   */
  private strokeSegment(
    x0: number, y0: number, x1: number, y1: number,
    clip: Rect | undefined,
  ): void {
    let ax = x0;
    let ay = y0;
    let bx = x1;
    let by = y1;

    if (clip) {
      const span = clipSegment(x0, y0, x1, y1, clip);
      if (!span) return;
      ax = x0 + (x1 - x0) * span.t0;
      ay = y0 + (y1 - y0) * span.t0;
      bx = x0 + (x1 - x0) * span.t1;
      by = y0 + (y1 - y0) * span.t1;
    }

    const g = this.sceneCtx;
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(bx, by);
    g.stroke();
  }

  private drawCell(cx: number, cy: number): void {
    this.drawCellTo(this.sceneCtx, cx, cy, false);
    this.drawCellTo(this.pickCtx, cx, cy, true);
  }

  private drawCellTo(
    g: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    pick: boolean,
  ): void {
    const i = cellIndex(cx, cy);
    const step = this.grid.step[i]!;
    if (step === EMPTY && !pick) return;
    // Empty cells still go into the pick buffer: an empty cell is the most important thing
    // a player can click.
    const contest = Math.min(this.grid.contest[i]!, MAX_CONTEST);
    const h = contest * LIFT;
    const { x: sx, y: sy } = cellTop(cx, cy, contest);
    const id = pick ? encodeId(i) : "";

    if (h > 0) {
      g.fillStyle = pick ? id : FACE_LEFT[step]!;
      g.beginPath();
      g.moveTo(sx - TW / 2, sy + TH / 2);
      g.lineTo(sx, sy + TH);
      g.lineTo(sx, sy + TH + h);
      g.lineTo(sx - TW / 2, sy + TH / 2 + h);
      g.closePath();
      g.fill();

      g.fillStyle = pick ? id : FACE_RIGHT[step]!;
      g.beginPath();
      g.moveTo(sx, sy + TH);
      g.lineTo(sx + TW / 2, sy + TH / 2);
      g.lineTo(sx + TW / 2, sy + TH / 2 + h);
      g.lineTo(sx, sy + TH + h);
      g.closePath();
      g.fill();
    }

    g.fillStyle = pick ? id : PATINA[step]!;
    g.beginPath();
    g.moveTo(sx, sy);
    g.lineTo(sx + TW / 2, sy + TH / 2);
    g.lineTo(sx, sy + TH);
    g.lineTo(sx - TW / 2, sy + TH / 2);
    g.closePath();
    g.fill();
  }

  /**
   * Which cell is visible at this buffer-space point, or null for the paper.
   *
   * Sampling nine pixels rather than one is not caution: the pick shapes are antialiased,
   * so a pixel on a tile boundary holds a blend of two ids and can decode to a third cell
   * entirely. Taking the majority of a 3x3 both removes that and, at a genuine boundary,
   * returns whichever cell owns more of the area under the cursor — which is the answer a
   * player expects anyway. A mis-pick would place a signed pixel in the wrong cell, and
   * that is not recoverable.
   */
  pick(bx: number, by: number): number | null {
    const x = Math.round(bx) - 1;
    const y = Math.round(by) - 1;
    if (x < -1 || y < -1 || x > BUF_W || y > BUF_H) return null;
    const data = this.pickCtx.getImageData(x, y, 3, 3).data;

    const tally = new Map<number, number>();
    for (let p = 0; p < 9; p++) {
      const o = p * 4;
      if (data[o + 3]! < 250) continue; // blended against transparent paper
      const id = data[o]! + (data[o + 1]! << 8) + (data[o + 2]! << 16);
      if (id < 1 || id > N * N) continue;
      tally.set(id, (tally.get(id) ?? 0) + 1);
    }
    let best = 0;
    let bestN = 0;
    for (const [id, n] of tally) {
      if (n > bestN) {
        best = id;
        bestN = n;
      }
    }
    return best === 0 ? null : best - 1;
  }
}

/**
 * Liang–Barsky: the parameter range of the segment that lies inside the rect, or null if
 * none of it does. Returned as parameters rather than points so the caller keeps full
 * precision on the original endpoints.
 */
function clipSegment(
  x0: number, y0: number, x1: number, y1: number,
  r: Rect,
): { t0: number; t1: number } | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  const edges: ReadonlyArray<readonly [number, number]> = [
    [-dx, x0 - r.x],
    [dx, r.x + r.w - x0],
    [-dy, y0 - r.y],
    [dy, r.y + r.h - y0],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null; // parallel to this edge and outside it
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return { t0, t1 };
}

/* Cell index + 1 as an opaque colour. +1 keeps 0 meaning "nothing here", so a cleared
   region and cell (0,0) are never confused. 4,096 cells need 13 bits; blue stays 0. */
function encodeId(i: number): string {
  const id = i + 1;
  return `rgb(${id & 255},${(id >> 8) & 255},${(id >> 16) & 255})`;
}

export { BUF_W, BUF_H, PAD };
