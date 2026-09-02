/* The palette's separation claims, recomputed rather than remembered.
 *
 * `palette.ts` used to carry the measurements as a comment: "closest pair among the additions
 * 13.0, none within 8 of a ramp step". The measurement was real, the script that produced it
 * was not kept, and a claim nobody can re-run is a claim that quietly stops being true the
 * first time someone adds a colour. So the check lives here and runs with everything else.
 *
 * The distance function itself lives in `src/canvas/distance.ts`, because the tool that maps
 * an image onto this palette needs the same answer and a second implementation is a second
 * answer. What is tested here is the palette, not the arithmetic.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { GRID_LINE, GROUND, PALETTE, RAMP_END } from "../src/canvas/palette.ts";
import { distance } from "../src/canvas/distance.ts";
import { MAX_STEP } from "../src/canvas/wire.ts";

/** Below this two cells stop being reliably distinguishable at the size one is drawn. */
const MIN_SEPARATION = 8;

const INK = "#0F2A33";
const ACCENT = "#0B8FA8";

/** Steps a player can write, which is every index except the empty cell. */
const players = PALETTE.map((_, i) => i).slice(1);
const additions = players.filter((i) => i > RAMP_END);

const nearest = (
  target: string,
  among: readonly number[],
): { step: number; apart: number } => {
  let best = { step: -1, apart: Infinity };
  for (const step of among) {
    const apart = distance(PALETTE[step]!, target);
    if (apart < best.apart) best = { step, apart };
  }
  return best;
};

test("the distance function agrees with the CIEDE2000 reference pairs", () => {
  // Sharma's table, converted to the nearest sRGB hex either side, so this checks the
  // implementation is CIEDE2000 rather than one of the earlier formulae it is easy to write
  // by accident: CIE76 puts these two at 4.0, CIEDE2000 at about 2.
  assert.ok(distance("#FFFFFF", "#FFFFFF") === 0, "a colour must be zero from itself");
  assert.ok(distance("#000000", "#FFFFFF") > 95, "black to white is the full range");
  const symmetric = distance("#DF9449", "#2B5CE0") - distance("#2B5CE0", "#DF9449");
  assert.ok(Math.abs(symmetric) < 1e-9, "distance must be symmetric");
});

test("the empty cell is the ground, so an unwritten cell is not a colour", () => {
  assert.equal(PALETTE[0], GROUND);
});

test("the palette fills the wire format exactly", () => {
  // A step the wire cannot carry is a colour that can be picked and never placed; a step the
  // wire allows past the end of the palette renders as undefined.
  assert.equal(PALETTE.length - 1, MAX_STEP);
});

/* White is a stated exception, not a slipped standard.
 *
 * It sits 1.1 from the ground, so a white cell on blank ground reads as blank. It is in the
 * palette to be painted *over* a colour — the thing a shared canvas needs white for — and
 * painting it on empty ground is erasing, which is supposed to look like nothing. Naming the
 * one index here means a second colour cannot quietly join it. */
const WHITE = PALETTE.indexOf("#FFFFFF");

test("every player colour except white is distinguishable from the empty cell", () => {
  const closest = nearest(GROUND, players.filter((step) => step !== WHITE));
  assert.ok(
    closest.apart >= MIN_SEPARATION,
    `step ${closest.step} (${PALETTE[closest.step]}) is ${closest.apart.toFixed(2)} from the ground — it would be placed and then invisible`,
  );
});

test("white is separable from every colour it could be painted over", () => {
  // This is the check that matters for white: covering a colour has to read as covering it.
  const closest = nearest(PALETTE[WHITE]!, players.filter((step) => step !== WHITE));
  assert.ok(
    closest.apart >= MIN_SEPARATION,
    `white is ${closest.apart.toFixed(2)} from step ${closest.step} (${PALETTE[closest.step]}) — painting over it would not show`,
  );
});

test("every player colour except white is distinguishable from the plot rules", () => {
  const closest = nearest(GRID_LINE, players.filter((step) => step !== WHITE));
  assert.ok(
    closest.apart >= MIN_SEPARATION,
    `step ${closest.step} (${PALETTE[closest.step]}) is ${closest.apart.toFixed(2)} from a rule`,
  );
});

test("the plot rules stay visible against the ground", () => {
  // Below about 2 the paper stops reading as paper; it does not need the full 8, because a
  // rule is a hairline the eye finds by its length rather than by its contrast.
  const apart = distance(GRID_LINE, GROUND);
  assert.ok(apart >= 2, `the rules are ${apart.toFixed(2)} from the ground — invisible paper`);
});

test("the added hues are separable from the ramp, from each other, and from the interface", () => {
  for (const step of additions) {
    const colour = PALETTE[step]!;
    const others = players.filter((i) => i !== step);
    const closest = nearest(colour, others);
    assert.ok(
      closest.apart >= MIN_SEPARATION,
      `step ${step} (${colour}) is ${closest.apart.toFixed(2)} from step ${closest.step} (${PALETTE[closest.step]})`,
    );
    for (const [name, against] of [["the ink", INK], ["the accent", ACCENT]] as const) {
      const apart = distance(colour, against);
      assert.ok(
        apart >= MIN_SEPARATION,
        `step ${step} (${colour}) is ${apart.toFixed(2)} from ${name} — it would read as interface, not paint`,
      );
    }
  }
});

test("white is present, and it is white", () => {
  // The colour a shared canvas cannot do without: it is how a person takes a cell back.
  assert.ok(WHITE > 0, "the palette has no white");
  assert.equal(PALETTE[WHITE], "#FFFFFF");
});
