/* 2:1 axonometric, per .design/identity.md. Parallel projection, never a perspective
   camera: PLOT is a technical drawing and a technical drawing does not have a vanishing
   point. Every function here works in *buffer* pixels at scale 1; the view applies zoom. */

export const N = 64; // canvas is N x N cells (NFR-7)
export const TW = 22; // tile width
export const TH = 11; // tile height — exactly TW/2, which is what makes it 2:1
export const LIFT = 7; // rise in pixels per contest

/* Elevation is capped so the scene has fixed bounds. A cell contested more than this many
   times stops growing; the number is shown in the readout instead of encoded in height. */
export const MAX_CONTEST = 8;

export const PAD = 20;
export const HEADROOM = MAX_CONTEST * LIFT + PAD;

/** Buffer dimensions at scale 1. */
export const BUF_W = N * TW + PAD * 2;
export const BUF_H = N * TH + HEADROOM + PAD;

/** Origin of cell (0,0)'s top vertex, in buffer pixels. */
export const OX = BUF_W / 2;
export const OY = HEADROOM;

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Top vertex of a cell in buffer space. `contest` raises it. */
export function cellTop(cx: number, cy: number, contest: number): Point {
  return {
    x: OX + (cx - cy) * (TW / 2),
    y: OY + (cx + cy) * (TH / 2) - Math.min(contest, MAX_CONTEST) * LIFT,
  };
}

/**
 * Inverse projection, ignoring elevation: which cell would sit under this buffer point if
 * the whole grid were flat. Used only to bound a redraw region — never to answer "what did
 * the user click", because elevation makes that question a visibility question. The pick
 * buffer answers that one.
 */
export function bufferToFlatCell(bx: number, by: number): { cx: number; cy: number } {
  const u = (bx - OX) / TW;
  const v = (by - OY) / TH;
  return { cx: Math.floor(v + u), cy: Math.floor(v - u) };
}

export const inBounds = (cx: number, cy: number): boolean =>
  cx >= 0 && cy >= 0 && cx < N && cy < N;

export const cellIndex = (cx: number, cy: number): number => cy * N + cx;
