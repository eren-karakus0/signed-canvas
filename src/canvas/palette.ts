/* The canvas ramp, recorded in .design/identity.md as PATINA.
   Index 0 is the empty cell and is not a player colour: it cannot be written. */

export const EMPTY = 0;

export const PATINA: readonly string[] = [
  "#FBFDFD", // 00 · empty cell, = --current-color-20
  "#DF9449", // 01 hot
  "#D87A35",
  "#C6602C",
  "#A84C2E",
  "#935637",
  "#846441",
  "#827D4A",
  "#617C49",
  "#417549",
  "#2F7364",
  "#206163",
  "#1B4D54",
  "#173942",
  "#122830",
  "#0D1B21", // 15 cold
];

/** Player-writable indices, hot to cold. */
export const STEPS: readonly number[] = PATINA.map((_, i) => i).slice(1);

/* Side faces derive from the top face rather than from their own tokens: one material,
   lit from one direction. Precomputed because they are read once per tile per redraw. */
const darken = (hex: string, k: number): string => {
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * k);
  const g = Math.round(parseInt(hex.slice(3, 5), 16) * k);
  const b = Math.round(parseInt(hex.slice(5, 7), 16) * k);
  return `rgb(${r},${g},${b})`;
};

export const FACE_LEFT: readonly string[] = PATINA.map((c) => darken(c, 0.7));
export const FACE_RIGHT: readonly string[] = PATINA.map((c) => darken(c, 0.85));

/** The plot paper the drawing sits on. Not part of the ramp. */
export const GRID_LINE = "#DCE7EB";
export const GROUND = "#FBFDFD";
