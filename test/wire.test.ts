/* The placement grammar, in both directions.
 *
 * This is the contract with agents (FR-10), so it is the one string in the product nobody
 * can renegotiate later: it is what gets signed, and a signature over a differently-spelled
 * line is a signature over a different pixel.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { formatPlacement, parsePlacement } from "../src/canvas/wire.ts";
import { N } from "../src/canvas/projection.ts";

describe("parsePlacement", () => {
  it("reads the documented example", () => {
    assert.deepEqual(parsePlacement("px 12,47 3 k8f2a1"), {
      cx: 12,
      cy: 47,
      step: 3,
      token: "k8f2a1",
    });
  });

  it("reads a hex step above 9", () => {
    assert.equal(parsePlacement("px 0,0 f abcdef")?.step, 15);
  });

  it("accepts the first and last cell", () => {
    assert.deepEqual(parsePlacement("px 0,0 1 aaaaaa")?.cx, 0);
    assert.equal(parsePlacement(`px ${N - 1},${N - 1} 1 aaaaaa`)?.cy, N - 1);
  });

  it("refuses a two-digit decimal step", () => {
    // Not hypothetical. The T-2 load test wrote decimal, and 85 of its lines sit in the room
    // being correctly ignored. Accepting both would give one pixel two signed spellings.
    assert.equal(parsePlacement("px 51,25 13 c53172"), null);
  });

  it("refuses step 0, which is the empty cell and cannot be written", () => {
    assert.equal(parsePlacement("px 1,1 0 aaaaaa"), null);
  });

  it("refuses a cell outside the canvas", () => {
    assert.equal(parsePlacement(`px ${N},0 1 aaaaaa`), null);
    assert.equal(parsePlacement(`px 0,${N} 1 aaaaaa`), null);
    assert.equal(parsePlacement("px 99,99 1 aaaaaa"), null);
  });

  it("refuses anything the sweep would have left differently spaced", () => {
    for (const line of [
      " px 1,1 2 aaaaaa",
      "px 1,1 2 aaaaaa ",
      "px  1,1 2 aaaaaa",
      "px 1, 1 2 aaaaaa",
      "px 1,1  2 aaaaaa",
      "PX 1,1 2 aaaaaa",
    ]) {
      assert.equal(parsePlacement(line), null, `should refuse ${JSON.stringify(line)}`);
    }
  });

  it("refuses a token of the wrong length or alphabet", () => {
    assert.equal(parsePlacement("px 1,1 2 abcde"), null);
    assert.equal(parsePlacement("px 1,1 2 abcdefg"), null);
    assert.equal(parsePlacement("px 1,1 2 ABCDEF"), null);
  });

  it("returns null for ordinary room chatter rather than throwing", () => {
    for (const line of ["", "hello", "px", "pixel 1,1 2 aaaaaa", "gm"]) {
      assert.equal(parsePlacement(line), null);
    }
  });
});

describe("formatPlacement", () => {
  it("round-trips through the parser", () => {
    for (const [cx, cy, step] of [
      [0, 0, 1],
      [12, 47, 3],
      [63, 63, 15],
      [7, 8, 10],
    ] as const) {
      const line = formatPlacement(cx, cy, step, "k8f2a1");
      assert.deepEqual(parsePlacement(line), { cx, cy, step, token: "k8f2a1" });
    }
  });

  it("writes the step as one hex digit", () => {
    assert.equal(formatPlacement(1, 2, 10, "aaaaaa"), "px 1,2 a aaaaaa");
    assert.equal(formatPlacement(1, 2, 15, "aaaaaa"), "px 1,2 f aaaaaa");
  });

  it("throws rather than signing a line the canvas cannot hold", () => {
    for (const [cx, cy, step] of [
      [-1, 0, 1],
      [0, -1, 1],
      [N, 0, 1],
      [0, N, 1],
      [0, 0, 0],
      [0, 0, 16],
      [0, 0, 1.5],
    ] as const) {
      assert.throws(
        () => formatPlacement(cx, cy, step, "aaaaaa"),
        RangeError,
        `should refuse ${cx},${cy} step ${step}`,
      );
    }
  });

  it("throws on a token that is not six base36 characters", () => {
    assert.throws(() => formatPlacement(0, 0, 1, "AB!"), RangeError);
  });
});
