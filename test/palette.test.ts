/* The palette's separation claims, recomputed rather than remembered.
 *
 * `palette.ts` used to carry the measurements as a comment: "closest pair among the additions
 * 13.0, none within 8 of a ramp step". The measurement was real, the script that produced it
 * was not kept, and a claim nobody can re-run is a claim that quietly stops being true the
 * first time someone adds a colour. So the check lives here and runs with everything else.
 *
 * CIEDE2000 rather than plain Euclidean distance in RGB: the question is whether a person can
 * tell two cells apart, and RGB distance answers a different question — #000000 and #0000FF are
 * far apart in RGB and both read as "dark" at seven pixels across.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { GRID_LINE, GROUND, PALETTE, RAMP_END } from "../src/canvas/palette.ts";
import { MAX_STEP } from "../src/canvas/wire.ts";

/** Below this two cells stop being reliably distinguishable at the size one is drawn. */
const MIN_SEPARATION = 8;

const INK = "#0F2A33";
const ACCENT = "#0B8FA8";

const linear = (channel: number): number => {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** sRGB hex to CIE L*a*b*, D65. */
const lab = (hex: string): [number, number, number] => {
  const r = linear(parseInt(hex.slice(1, 3), 16));
  const g = linear(parseInt(hex.slice(3, 5), 16));
  const b = linear(parseInt(hex.slice(5, 7), 16));
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
};

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** CIEDE2000, per Sharma, Wu and Dalal (2005), with kL = kC = kH = 1. */
export const distance = (first: string, second: string): number => {
  const [l1, a1, b1] = lab(first);
  const [l2, a2, b2] = lab(second);
  const meanChroma = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(meanChroma ** 7 / (meanChroma ** 7 + 25 ** 7)));
  const ap1 = (1 + g) * a1;
  const ap2 = (1 + g) * a2;
  const cp1 = Math.hypot(ap1, b1);
  const cp2 = Math.hypot(ap2, b2);

  const hue = (b: number, a: number): number => {
    if (b === 0 && a === 0) return 0;
    const h = Math.atan2(b, a) * DEG;
    return h < 0 ? h + 360 : h;
  };
  const hp1 = hue(b1, ap1);
  const hp2 = hue(b2, ap2);

  let dhp = 0;
  if (cp1 * cp2 !== 0) {
    dhp = hp2 - hp1;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dLp = l2 - l1;
  const dCp = cp2 - cp1;
  const dHp = 2 * Math.sqrt(cp1 * cp2) * Math.sin((dhp / 2) * RAD);

  const meanL = (l1 + l2) / 2;
  const meanCp = (cp1 + cp2) / 2;
  let meanHp: number;
  if (cp1 * cp2 === 0) meanHp = hp1 + hp2;
  else {
    meanHp = (hp1 + hp2) / 2;
    if (Math.abs(hp1 - hp2) > 180) meanHp += hp1 + hp2 < 360 ? 180 : -180;
  }

  const t =
    1 -
    0.17 * Math.cos((meanHp - 30) * RAD) +
    0.24 * Math.cos(2 * meanHp * RAD) +
    0.32 * Math.cos((3 * meanHp + 6) * RAD) -
    0.2 * Math.cos((4 * meanHp - 63) * RAD);
  const sl = 1 + (0.015 * (meanL - 50) ** 2) / Math.sqrt(20 + (meanL - 50) ** 2);
  const sc = 1 + 0.045 * meanCp;
  const sh = 1 + 0.015 * meanCp * t;
  const rt =
    -Math.sin(2 * (30 * Math.exp(-(((meanHp - 275) / 25) ** 2))) * RAD) *
    (2 * Math.sqrt(meanCp ** 7 / (meanCp ** 7 + 25 ** 7)));

  return Math.sqrt(
    (dLp / sl) ** 2 + (dCp / sc) ** 2 + (dHp / sh) ** 2 + rt * (dCp / sc) * (dHp / sh),
  );
};

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
