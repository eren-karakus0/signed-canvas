/* The canvas ramp, recorded in .design/identity.md as PATINA.
   Index 0 is the empty cell and is not a player colour: it cannot be written. */

export const EMPTY = 0;

/* 01-15 are PATINA, the ramp chosen in T-2c and recorded in .design/identity.md. Untouched:
   every pixel ever placed carries one of these indices and still means what it meant.

   16-35 are the extension. The ramp is one perceptual walk from hot to cold, which is why it
   has no pink, no purple, no saturated blue — a single ramp cannot hold them. These are a
   second family: the main hues, at a saturation the ramp deliberately avoids, so they read
   as additions rather than as more ramp.

   Measured before being believed, in CIEDE2000. The measurement is no longer a note about a
   measurement — `test/palette.test.ts` recomputes it on every run, which is the only version
   of "we checked" that stays true after someone edits this file. */
export const PALETTE: readonly string[] = [
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
  "#0D1B21", // 15 cold — the ramp ends here
  "#E02B2B", // 16 red
  "#8E1616", // 17 deep red
  "#FF6B9D", // 18 pink
  "#FFB3C8", // 19 pale pink
  "#B14AE0", // 20 violet
  "#6A1FA8", // 21 deep purple
  "#C9B6F0", // 22 lavender
  "#2B5CE0", // 23 blue
  "#5BB8F5", // 24 sky
  "#16276B", // 25 navy
  "#2ECC40", // 26 green
  "#8CE8A8", // 27 mint
  "#00A65A", // 28 emerald
  "#F5D020", // 29 yellow
  "#FF5C1A", // 30 bright orange
  "#22D3D3", // 31 cyan
  "#4A3226", // 32 dark brown
  /* 33 · white is the one colour that does not have to clear 8 from the ground — it sits 1.1
     from it, so a white cell on empty ground reads as empty. That is not a defect here: white
     exists to be painted *over* a colour, which is what a shared canvas needs it for, and it
     is 24.6 from the nearest colour it would ever cover. Painting white on blank ground is
     erasing, and erasing looking like nothing is correct. `test/palette.test.ts` states this
     as an exception rather than lowering the bar for everything. */
  "#FFFFFF", // 33 white
  "#7C878C", // 34 grey
  "#3D4A50", // 35 slate
];

/** How far the hot-to-cold ramp runs. Past it the palette is hues, not a walk. */
export const RAMP_END = 15;

/** Player-writable indices, hot to cold. */
export const STEPS: readonly number[] = PALETTE.map((_, i) => i).slice(1);

/* Side faces derive from the top face rather than from their own tokens: one material,
   lit from one direction. Precomputed because they are read once per tile per redraw. */
const darken = (hex: string, k: number): string => {
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * k);
  const g = Math.round(parseInt(hex.slice(3, 5), 16) * k);
  const b = Math.round(parseInt(hex.slice(5, 7), 16) * k);
  return `rgb(${r},${g},${b})`;
};

export const FACE_LEFT: readonly string[] = PALETTE.map((c) => darken(c, 0.7));
export const FACE_RIGHT: readonly string[] = PALETTE.map((c) => darken(c, 0.85));

/** The plot paper the drawing sits on. Not part of the ramp. */
export const GRID_LINE = "#DCE7EB";
export const GROUND = "#FBFDFD";
