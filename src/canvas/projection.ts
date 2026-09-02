/* 2:1 axonometric, per .design/identity.md. Parallel projection, never a perspective
   camera: PLOT is a technical drawing and a technical drawing does not have a vanishing
   point. Every function here works in *buffer* pixels at scale 1; the view applies zoom. */

/* The canvas is wider than it is tall, because the screen is.
 *
 * It was 64x64, which left a square of pixels in the middle of a wide stage and empty ground
 * either side of it. Growing it *rightwards only* means every pixel already placed keeps the
 * coordinates it was signed with — a placement is a signature over `px <x>,<y> …`, so moving
 * a cell would not move a pixel, it would orphan one.
 *
 * 96 is not a free choice either. The wire format writes coordinates as `\d{1,2}`, so 99 is
 * the ceiling, and the room already holds `px 58,54` — dropping the height to fit a wider
 * ratio would have put a real pixel outside the canvas. */
export const COLS = 96;
export const ROWS = 64;
export const CELLS = COLS * ROWS;
export const TW = 22; // tile width
export const TH = 11; // tile height — exactly TW/2, which is what makes it 2:1
export const LIFT = 7; // rise in pixels per contest

/* Elevation is capped so the scene has fixed bounds. A cell contested more than this many
   times stops growing; the number is shown in the readout instead of encoded in height. */
export const MAX_CONTEST = 8;

export const PAD = 20;
export const HEADROOM = MAX_CONTEST * LIFT + PAD;

/** Buffer dimensions at scale 1. */
export const BUF_W = (COLS + ROWS) * (TW / 2) + PAD * 2;
export const BUF_H = (COLS + ROWS) * (TH / 2) + HEADROOM + PAD;

/** Origin of cell (0,0)'s top vertex, in buffer pixels. */
export const OX = ROWS * (TW / 2) + PAD;
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
  cx >= 0 && cy >= 0 && cx < COLS && cy < ROWS;

export const cellIndex = (cx: number, cy: number): number => cy * COLS + cx;
