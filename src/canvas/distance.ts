/* How far apart two colours look, in CIEDE2000.
 *
 * Not Euclidean distance in RGB: the question this answers is whether a person can tell two
 * cells apart, and RGB distance answers a different one — #000000 and #0000FF are far apart in
 * RGB and both read as "dark" at seven pixels across.
 *
 * Used by the palette's own separation check and by the tool that maps an image onto the
 * palette. Both need the same answer, and a second implementation is a second answer.
 */

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
/** CIEDE2000 between two `#rrggbb` colours, with kL = kC = kH = 1. */
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
