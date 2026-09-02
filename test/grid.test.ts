import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { Grid } from "../src/canvas/grid.ts";
import {
  COLS,
  MAX_CONTEST,
  ROWS,
  bufferToFlatCell,
  cellIndex,
  cellTop,
  inBounds,
} from "../src/canvas/projection.ts";

describe("Grid.place", () => {
  it("reports a change when an empty cell is marked", () => {
    const grid = new Grid();
    assert.equal(grid.place(0, 0, 1), true);
    assert.equal(grid.step[cellIndex(0, 0)], 1);
  });

  it("does not count the first mark on an empty cell as a contest", () => {
    const grid = new Grid();
    grid.place(3, 4, 7);
    assert.equal(grid.contest[cellIndex(3, 4)], 0);
  });

  it("counts an overwrite as a contest", () => {
    const grid = new Grid();
    grid.place(3, 4, 7);
    grid.place(3, 4, 9);
    assert.equal(grid.contest[cellIndex(3, 4)], 1);
  });

  it("treats re-placing the same step as no change and no contest", () => {
    const grid = new Grid();
    grid.place(3, 4, 7);
    assert.equal(grid.place(3, 4, 7), false);
    assert.equal(grid.contest[cellIndex(3, 4)], 0);
  });

  it("saturates the contest count instead of wrapping the byte", () => {
    const grid = new Grid();
    const i = cellIndex(1, 1);
    grid.place(1, 1, 1);
    grid.contest[i] = 255;
    grid.place(1, 1, 2);
    assert.equal(grid.contest[i], 255);
  });

  it("accepts the first and last cell", () => {
    const grid = new Grid();
    assert.equal(grid.place(0, 0, 1), true);
    assert.equal(grid.place(COLS - 1, ROWS - 1, 15), true);
  });

  it("throws rather than silently ignoring a cell outside the canvas", () => {
    const grid = new Grid();
    for (const [cx, cy] of [[-1, 0], [0, -1], [COLS, 0], [0, ROWS]] as const) {
      assert.throws(() => grid.place(cx, cy, 1), RangeError, `expected throw at ${cx},${cy}`);
    }
  });

  it("refuses the empty step and anything past the palette", () => {
    const grid = new Grid();
    // 16 used to be past the end. The palette now runs to 35, so the bound moved with
    // it — asserting the old number would have been asserting nothing.
    for (const step of [0, -1, 36, 1.5, Number.NaN]) {
      assert.throws(() => grid.place(2, 2, step), RangeError, `expected throw for step ${step}`);
    }
  });

  it("returns null outside the canvas rather than a fabricated cell", () => {
    const grid = new Grid();
    assert.equal(grid.get(-1, 0), null);
    assert.equal(grid.get(COLS, ROWS), null);
  });

  it("counts painted cells, not placements", () => {
    const grid = new Grid();
    assert.equal(grid.painted(), 0);
    grid.place(5, 5, 1);
    grid.place(5, 5, 2);
    assert.equal(grid.painted(), 1);
    grid.place(6, 5, 3);
    assert.equal(grid.painted(), 2);
  });
});

describe("projection", () => {
  it("inverts to the same cell at the centre of every flat top face", () => {
    // The inverse is only used to bound a redraw region, but if it disagrees with the
    // forward projection the region can omit a cell and leave a stale tile on screen.
    for (let cy = 0; cy < ROWS; cy += 7) {
      for (let cx = 0; cx < COLS; cx += 7) {
        const top = cellTop(cx, cy, 0);
        const got = bufferToFlatCell(top.x, top.y + 11 / 2);
        assert.deepEqual(got, { cx, cy }, `round trip failed at ${cx},${cy}`);
      }
    }
  });

  it("caps elevation so the scene keeps fixed bounds", () => {
    const capped = cellTop(0, 0, 8);
    const beyond = cellTop(0, 0, 40);
    assert.equal(beyond.y, capped.y);
  });

  it("agrees with inBounds at the edges", () => {
    assert.equal(inBounds(0, 0), true);
    assert.equal(inBounds(COLS - 1, ROWS - 1), true);
    assert.equal(inBounds(COLS, 0), false);
    assert.equal(inBounds(0, -1), false);
  });
});

/* The tower: a cell's history standing up.
 *
 * Elevation already showed how often a cell had been contested. What it did not show was
 * *what* it had been — every level took the current colour, so painting over a tall stack
 * repainted the whole building. And because the snapshot carried only the top colour, a
 * reload flattened every tower to a single square.
 *
 * The two are one missing fact, and these are the assertions that say it is no longer
 * missing. `MAX_CONTEST` is imported rather than written as 8 because the same number is
 * spelled `MAX_STACK` on the server, and a test that hard-codes it stops noticing when they
 * drift apart.
 */
describe("Grid tower", () => {
  it("keeps the colour it covered, rather than repainting the level", () => {
    const grid = new Grid();
    grid.place(2, 3, 4);
    grid.place(2, 3, 11);
    assert.equal(grid.step[cellIndex(2, 3)], 11, "the top is the newest colour");
    assert.equal(grid.levelAt(cellIndex(2, 3), 0), 4, "the level below keeps what was there");
  });

  it("stacks levels oldest at the bottom", () => {
    const grid = new Grid();
    for (const step of [3, 7, 9, 12]) grid.place(1, 1, step);
    const i = cellIndex(1, 1);
    assert.deepEqual([0, 1, 2].map((k) => grid.levelAt(i, k)), [3, 7, 9]);
    assert.equal(grid.step[i], 12);
  });

  it("has no level under a cell placed once", () => {
    const grid = new Grid();
    grid.place(5, 5, 6);
    assert.equal(grid.levelAt(cellIndex(5, 5), 0), 0);
    assert.equal(grid.contest[cellIndex(5, 5)], 0);
  });

  it("does not grow when the same colour is placed again", () => {
    const grid = new Grid();
    grid.place(4, 4, 9);
    assert.equal(grid.place(4, 4, 9), false);
    assert.equal(grid.contest[cellIndex(4, 4)], 0);
    assert.equal(grid.levelAt(cellIndex(4, 4), 0), 0);
  });

  it("drops the oldest level once the tower is full, keeping the recent history", () => {
    const grid = new Grid();
    for (let step = 1; step <= MAX_CONTEST + 4; step++) grid.place(6, 6, step);
    const i = cellIndex(6, 6);
    const levels = Array.from({ length: MAX_CONTEST }, (_, k) => grid.levelAt(i, k));
    assert.equal(grid.step[i], MAX_CONTEST + 4, "the top is still the newest");
    assert.deepEqual(
      levels,
      Array.from({ length: MAX_CONTEST }, (_, k) => MAX_CONTEST + 3 - (MAX_CONTEST - 1 - k)),
      "the tower holds the most recent levels below the top",
    );
    assert.equal(levels.at(-1), MAX_CONTEST + 3, "the level under the top is what it covered");
  });

  it("does not let one cell's levels reach into another's", () => {
    const grid = new Grid();
    grid.place(0, 0, 1);
    grid.place(0, 0, 2);
    grid.place(1, 0, 5);
    assert.equal(grid.levelAt(cellIndex(1, 0), 0), 0, "a neighbour must stay untouched");
    assert.equal(grid.levelAt(cellIndex(0, 0), 0), 1);
  });
});

describe("Grid.restore", () => {
  it("rebuilds a tower the snapshot already knows, without replaying it", () => {
    const grid = new Grid();
    grid.restore(2, 3, 12, [3, 7, 9]);
    const i = cellIndex(2, 3);
    assert.equal(grid.step[i], 12);
    assert.equal(grid.contest[i], 3, "elevation comes from the number of levels");
    assert.deepEqual([0, 1, 2].map((k) => grid.levelAt(i, k)), [3, 7, 9]);
  });

  it("leaves a cell flat when the archive sends no tower", () => {
    // An archive older than the stack plane. Flat is what it used to draw, and drawing it
    // flat is honest; inventing levels would not be.
    const grid = new Grid();
    grid.restore(4, 4, 6, []);
    assert.equal(grid.contest[cellIndex(4, 4)], 0);
    assert.equal(grid.step[cellIndex(4, 4)], 6);
  });

  it("stops at the first gap rather than drawing a floating level", () => {
    // 0 terminates the plane. A level above a gap cannot happen, and if it somehow arrived,
    // drawing it would put a block in mid-air and make the canvas look broken rather than
    // the data.
    const grid = new Grid();
    grid.restore(1, 1, 10, [3, 0, 9]);
    const i = cellIndex(1, 1);
    assert.equal(grid.contest[i], 1);
    assert.deepEqual([0, 1, 2].map((k) => grid.levelAt(i, k)), [3, 0, 0]);
  });

  it("replaces a cell outright rather than adding to it", () => {
    const grid = new Grid();
    for (const step of [1, 2, 3, 4]) grid.place(7, 7, step);
    grid.restore(7, 7, 9, [5]);
    const i = cellIndex(7, 7);
    assert.equal(grid.contest[i], 1, "a restore is the whole cell, not a placement on it");
    assert.deepEqual([0, 1].map((k) => grid.levelAt(i, k)), [5, 0]);
  });

  it("keeps building normally once restored", () => {
    // The path a real session takes: load the snapshot, then place on top of it.
    const grid = new Grid();
    grid.restore(3, 3, 8, [2, 4]);
    grid.place(3, 3, 13);
    const i = cellIndex(3, 3);
    assert.equal(grid.contest[i], 3);
    assert.deepEqual([0, 1, 2].map((k) => grid.levelAt(i, k)), [2, 4, 8]);
    assert.equal(grid.step[i], 13);
  });

  it("refuses a cell off the canvas", () => {
    assert.throws(() => new Grid().restore(COLS, 0, 3, []), RangeError);
  });
});
