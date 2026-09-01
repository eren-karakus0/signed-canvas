import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { Grid } from "../src/canvas/grid.ts";
import { N, bufferToFlatCell, cellIndex, cellTop, inBounds } from "../src/canvas/projection.ts";

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
    assert.equal(grid.place(N - 1, N - 1, 15), true);
  });

  it("throws rather than silently ignoring a cell outside the canvas", () => {
    const grid = new Grid();
    for (const [cx, cy] of [[-1, 0], [0, -1], [N, 0], [0, N]] as const) {
      assert.throws(() => grid.place(cx, cy, 1), RangeError, `expected throw at ${cx},${cy}`);
    }
  });

  it("refuses the empty step and anything past the ramp", () => {
    const grid = new Grid();
    for (const step of [0, -1, 16, 1.5, Number.NaN]) {
      assert.throws(() => grid.place(2, 2, step), RangeError, `expected throw for step ${step}`);
    }
  });

  it("returns null outside the canvas rather than a fabricated cell", () => {
    const grid = new Grid();
    assert.equal(grid.get(-1, 0), null);
    assert.equal(grid.get(N, N), null);
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
    for (let cy = 0; cy < N; cy += 7) {
      for (let cx = 0; cx < N; cx += 7) {
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
    assert.equal(inBounds(N - 1, N - 1), true);
    assert.equal(inBounds(N, 0), false);
    assert.equal(inBounds(0, -1), false);
  });
});
