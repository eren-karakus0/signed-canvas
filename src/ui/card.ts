/* A picture of the canvas, made to be posted somewhere else.
 *
 * What a card like this can honestly be is narrow, and it is worth being exact about. An image
 * proves nothing: anyone can draw one that says whatever they like, including this one. So the
 * card does not present itself as evidence. It shows the canvas, states the numbers plainly,
 * and carries the address where the same numbers can be checked against signatures that are
 * not in the picture. It points at the proof rather than pretending to be it.
 *
 * That is also why it says "witnessed" with a count rather than a badge. A badge invites the
 * reading that the image is certified; a count next to a total is a fact someone can go and
 * disagree with.
 */

import { COLS, ROWS } from "../canvas/projection.ts";
import { EMPTY, GRID_LINE, GROUND, PALETTE } from "../canvas/palette.ts";
import type { Grid } from "../canvas/grid.ts";

/* Sized for a timeline. 2:1 is what X crops to, and a card built to a different ratio is a
 * card whose edges get cut off in the one place it is meant to be seen. */
const WIDTH = 1200;
const HEIGHT = 600;
const MARGIN = 32;
const FOOTER = 84;

const INK = "#0F2A33";
const ACCENT = "#0B8FA8";
const PAPER = "#EDF2F4";

/** Facts the card states. Each one is either counted here or read from the archive. */
export interface CardFacts {
  /** Cells holding a colour. */
  readonly painted: number;
  /** Of those, how many rest on a signature that verified in the archive. */
  readonly witnessed: number;
  /** The room sequence the picture is current to. */
  readonly seq: number;
  /** Where the same numbers can be checked. Shown, so it travels with the image. */
  readonly url: string;
}

const MICRO = '11px ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';
const LABEL = '13px ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

const context = (canvas: HTMLCanvasElement): CanvasRenderingContext2D => {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("2D canvas context unavailable");
  return ctx;
};

/**
 * Draw the card and return it as a PNG blob.
 *
 * @throws Error if a 2D context is unavailable, or the browser cannot encode a PNG.
 */
export async function shareCard(grid: Grid, facts: CardFacts): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const g = context(canvas);

  g.fillStyle = PAPER;
  g.fillRect(0, 0, WIDTH, HEIGHT);

  /* The board keeps its own proportions. Stretching it to fill the card would make a pixel
   * canvas whose pixels are not square, which is the one thing a picture of a pixel canvas
   * must not do. */
  const cell = Math.floor(
    Math.min((WIDTH - MARGIN * 2) / COLS, (HEIGHT - MARGIN * 2 - FOOTER) / ROWS),
  );
  const drawnW = cell * COLS;
  const drawnH = cell * ROWS;
  const left = Math.round((WIDTH - drawnW) / 2);
  // Centred with the footer as one block, not pinned to the top margin. Whole cells mean the
  // drawn height is almost never the height that was budgeted for it, and the leftover was
  // landing entirely under the caption as a band of nothing.
  const top = Math.round((HEIGHT - (drawnH + FOOTER)) / 2);

  g.fillStyle = GROUND;
  g.fillRect(left, top, drawnW, drawnH);

  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      const step = grid.step[cy * COLS + cx] ?? EMPTY;
      if (step === EMPTY) continue;
      g.fillStyle = PALETTE[step]!;
      g.fillRect(left + cx * cell, top + cy * cell, cell, cell);
    }
  }

  // The plot rules, at the same eight-cell rhythm the site draws, so the card looks like the
  // thing it is a picture of.
  g.strokeStyle = GRID_LINE;
  g.lineWidth = 1;
  g.beginPath();
  for (let i = 0; i <= COLS; i += 8) {
    g.moveTo(left + i * cell + 0.5, top);
    g.lineTo(left + i * cell + 0.5, top + drawnH);
  }
  for (let i = 0; i <= ROWS; i += 8) {
    g.moveTo(left, top + i * cell + 0.5);
    g.lineTo(left + drawnW, top + i * cell + 0.5);
  }
  g.stroke();

  g.strokeStyle = "rgba(15, 42, 51, 0.18)";
  g.strokeRect(left + 0.5, top + 0.5, drawnW - 1, drawnH - 1);

  const baseline = top + drawnH + 40;

  g.fillStyle = INK;
  g.font = `600 22px ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace`;
  g.textBaseline = "alphabetic";
  g.fillText("EVERY PIXEL IS SIGNED", left, baseline);

  g.font = LABEL;
  g.fillStyle = ACCENT;
  const counts = `${facts.painted} placed · ${facts.witnessed} witnessed · seq ${facts.seq}`;
  g.fillText(counts, left, baseline + 26);

  // Right-aligned so the address is the last thing read, and reads as a destination rather
  // than a caption.
  g.textAlign = "right";
  g.font = LABEL;
  g.fillStyle = INK;
  g.fillText(facts.url, left + drawnW, baseline);

  g.font = MICRO;
  g.fillStyle = "rgba(15, 42, 51, 0.55)";
  // The disclaimer travels with the picture. Detached from the site, "every pixel is signed"
  // beside a did:key reads like a token project, and the correction has to arrive with it.
  g.fillText("no token · nothing for sale · not affiliated with Flop Labs", left + drawnW, baseline + 26);
  g.textAlign = "left";

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("the browser did not encode the card"));
    }, "image/png");
  });
}

/**
 * Put the card where the person can use it: the clipboard if the browser allows it,
 * otherwise a saved file.
 *
 * Returns which of the two happened, so the interface can say the true one. Reporting "copied"
 * after a download is the kind of small lie that makes someone paste an empty clipboard into
 * a post.
 *
 * @throws Error if neither route works.
 */
export async function offerCard(blob: Blob, filename: string): Promise<"clipboard" | "file"> {
  // Feature-detected rather than assumed: Firefox has no image write support at the time of
  // writing, and Safari only allows it inside the click that asked for it.
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return "clipboard";
    } catch {
      // Denied permission, or a browser that lists the API and refuses the type. Fall through
      // to the file, which always works.
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on the next turn of the event loop: revoking immediately races the download in
  // some browsers and saves a zero-byte file.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "file";
}
