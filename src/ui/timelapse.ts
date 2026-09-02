/* Replaying the canvas from empty to now.
 *
 * This is the thing people shared out of r/place — not the finished picture, the watching of
 * it arrive. The archive has always been able to answer it: every placement is stored in
 * sequence order with who wrote it and when. Nothing here asks the room for anything.
 *
 * It runs on its own `Grid` and its own surface rather than rewinding the live one. The live
 * canvas has to stay correct while this plays — placements keep arriving from the room, and a
 * replay that borrowed the real grid would either fight them or have to be undone afterwards,
 * and "undone afterwards" is how a canvas ends up showing a past that never happened.
 */

import { Grid } from "../canvas/grid.ts";
import { FlatScene } from "../canvas/flat.ts";
import type { Record_ } from "../net/archive.ts";

/** How long a full replay takes, whatever it holds. `play` paces itself to this. */
const TARGET_SECONDS = 18;

export interface TimelapseEvents {
  /** Position changed: `at` placements applied out of `total`. */
  onProgress(at: number, total: number, record: Record_ | null): void;
  /** Playback reached the end on its own. */
  onEnd(): void;
}

export class Timelapse {
  readonly grid = new Grid();
  readonly scene: FlatScene;

  private records: readonly Record_[] = [];
  private at = 0;
  private playing = false;
  private frame = 0;
  private readonly events: TimelapseEvents;

  constructor(events: TimelapseEvents) {
    this.events = events;
    this.scene = new FlatScene(this.grid);
  }

  get length(): number {
    return this.records.length;
  }

  get position(): number {
    return this.at;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Load a history and rewind to the start. */
  load(records: readonly Record_[]): void {
    this.stop();
    this.records = records;
    this.at = 0;
    this.grid.clear();
    this.scene.drawAll();
    this.events.onProgress(0, this.records.length, null);
  }

  /**
   * Move to `position`, drawing only what changed where possible.
   *
   * Forward is incremental — one cell repainted per placement. Backward rebuilds from empty,
   * because a placement cannot be undone: the cell under it is whatever the placement before
   * it left there, and the grid does not keep an undo log. Rebuilding is a few thousand
   * `place` calls and one full draw, which is cheaper than carrying that log.
   */
  seek(position: number): void {
    const target = Math.max(0, Math.min(this.records.length, Math.floor(position)));
    if (target === this.at) return;

    if (target < this.at) {
      this.grid.clear();
      for (let i = 0; i < target; i++) this.apply(this.records[i]!);
      this.scene.drawAll();
    } else {
      for (let i = this.at; i < target; i++) {
        const record = this.records[i]!;
        if (this.apply(record)) this.scene.invalidateCell(record.cx, record.cy);
      }
    }
    this.at = target;
    this.events.onProgress(this.at, this.records.length, this.records[this.at - 1] ?? null);
  }

  play(): void {
    if (this.playing || this.records.length === 0) return;
    // Starting from the end means watching nothing, so a play from the end rewinds first.
    if (this.at >= this.records.length) this.seek(0);
    this.playing = true;

    /* Paced by the clock, not by frames.
     *
     * Stepping a whole number of placements per frame only solves the crowded case: at 60
     * frames a second the floor of one step per frame is 60 placements a second, so a canvas
     * with a hundred of them was over in under two — which is not a replay, it is a flicker.
     * Deriving the position from elapsed time makes a hundred placements and a hundred
     * thousand both take about the length of a look. */
    const from = this.at;
    const remaining = this.records.length - from;
    const duration = TARGET_SECONDS * 1000 * (remaining / this.records.length);
    const startedAt = performance.now();

    const step = (): void => {
      if (!this.playing) return;
      const through = Math.min(1, (performance.now() - startedAt) / duration);
      this.seek(from + remaining * through);
      if (this.at >= this.records.length) {
        this.playing = false;
        this.events.onEnd();
        return;
      }
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  stop(): void {
    this.playing = false;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private apply(record: Record_): boolean {
    try {
      return this.grid.place(record.cx, record.cy, record.step);
    } catch {
      // A record the current build cannot draw — a colour or a cell outside what this
      // version knows. Skipped rather than fatal: a replay missing one pixel is worth more
      // than no replay.
      return false;
    }
  }
}
