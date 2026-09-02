/* Pan and zoom, and the one loop that paints.
 *
 * The scene bitmap is the only thing blitted, so a frame costs one drawImage plus the
 * hover mark. Frames are requested on change rather than continuously: the identity asks
 * for roughly a quarter of the time at rest, and a canvas that repaints while nobody is
 * touching it is a canvas that drains a laptop for no reason.
 */

import { COLS, PAD, ROWS } from "./projection.ts";
import type { Surface } from "./surface.ts";

const MIN_SCALE = 0.35;
const MAX_SCALE = 3;
/** Pointer travel, in CSS pixels, above which a press is a drag and not a click. */
const DRAG_SLOP = 4;

/** Where a hover came from. A keyboard cursor is nowhere near the mouse, and anything that
 *  positions itself by the pointer has to know that. */
export type HoverSource = "pointer" | "keyboard";

export interface ViewEvents {
  onHover(cell: number | null, source: HoverSource): void;
  onActivate(cell: number): void;
}

export class View {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private scale = 1;
  private tx = 0;
  private ty = 0;
  /** The CSS box the current tx/ty were computed against, so a resize can re-centre. */
  private boxW = 0;
  private boxH = 0;
  private hovered: number | null = null;
  private frameQueued = false;
  /** Set while the pointer is down and past the slop threshold. */
  private dragging = false;
  private pressed = false;
  private pressX = 0;
  private pressY = 0;
  /** Once the player has framed the canvas themselves, a resize must not undo it. */
  private userFramed = false;
  private accentColour = "#0B8FA8";

  private readonly canvas: HTMLCanvasElement;
  private readonly scene: Surface;
  private readonly events: ViewEvents;

  constructor(canvas: HTMLCanvasElement, scene: Surface, events: ViewEvents) {
    this.canvas = canvas;
    this.scene = scene;
    this.events = events;
    const g = canvas.getContext("2d", { alpha: false });
    if (!g) throw new Error("2D canvas context unavailable");
    this.ctx = g;

    this.readAccent();
    this.resize();
    this.fit();
    this.bind();
  }

  /* The crosshair is the identity's shape signature and must come from the token, not from
     a literal — the render is canvas, so `var()` cannot be used directly. */
  private readAccent(): void {
    const v = getComputedStyle(document.body).getPropertyValue("--current-color-40").trim();
    if (v) this.accentColour = v;
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));

    // A scale computed for the old box leaves the canvas cropped in the new one. Re-framing
    // is only safe while the player has not framed it themselves.
    if (!this.userFramed) {
      this.fit();
      this.boxW = r.width;
      this.boxH = r.height;
      return;
    }

    /* Keep whatever was in the middle in the middle.
     *
     * `tx`/`ty` place the buffer's origin against the box's top-left, so leaving them alone
     * across a resize pins the content to that corner and everything else slides. Browser
     * zoom resizes the box on every notch, which turned ctrl+scroll into the canvas walking
     * off toward the corner — a lot of drift for what should be a scale change. */
    if (this.boxW > 0 && this.boxH > 0) {
      const bx = (this.boxW / 2 - this.tx) / this.scale;
      const by = (this.boxH / 2 - this.ty) / this.scale;
      this.tx = r.width / 2 - bx * this.scale;
      this.ty = r.height / 2 - by * this.scale;
    }
    this.boxW = r.width;
    this.boxH = r.height;
    this.request();
  }

  /** Frame the whole canvas with a margin, and centre it. */
  fit(): void {
    const r = this.canvas.getBoundingClientRect();
    // Fit to the drawn content, which is the buffer inset by PAD on every side — fitting to
    // the buffer itself wastes 40px of scale on padding that is never painted.
    const bw = this.scene.bufferWidth;
    const bh = this.scene.bufferHeight;
    const s = Math.min(r.width / (bw - PAD), r.height / (bh - PAD));
    this.setScale(s, r.width / 2, r.height / 2, true);
    this.tx = (r.width - bw * this.scale) / 2;
    this.ty = (r.height - bh * this.scale) / 2;
    this.boxW = r.width;
    this.boxH = r.height;
    this.userFramed = false;
    this.request();
  }

  private setScale(next: number, anchorX: number, anchorY: number, silent = false): void {
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    if (clamped === this.scale) return;
    // Keep the buffer point under the anchor fixed, so zoom follows the cursor.
    const bx = (anchorX - this.tx) / this.scale;
    const by = (anchorY - this.ty) / this.scale;
    this.scale = clamped;
    this.tx = anchorX - bx * clamped;
    this.ty = anchorY - by * clamped;
    if (!silent) this.request();
  }

  screenToBuffer(clientX: number, clientY: number): { bx: number; by: number } {
    const r = this.canvas.getBoundingClientRect();
    return {
      bx: (clientX - r.left - this.tx) / this.scale,
      by: (clientY - r.top - this.ty) / this.scale,
    };
  }

  private bind(): void {
    const c = this.canvas;

    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      this.pressed = true;
      this.dragging = false;
      this.pressX = e.clientX;
      this.pressY = e.clientY;
    });

    c.addEventListener("pointermove", (e) => {
      if (this.pressed) {
        const dx = e.clientX - this.pressX;
        const dy = e.clientY - this.pressY;
        if (!this.dragging && Math.hypot(dx, dy) > DRAG_SLOP) this.dragging = true;
        if (this.dragging) {
          this.userFramed = true;
          this.tx += e.movementX;
          this.ty += e.movementY;
          this.request();
          return;
        }
      }
      const { bx, by } = this.screenToBuffer(e.clientX, e.clientY);
      const cell = this.scene.pick(bx, by);
      if (cell !== this.hovered) {
        this.hovered = cell;
        this.events.onHover(cell, "pointer");
        this.request();
      }
    });

    const release = (e: PointerEvent): void => {
      if (!this.pressed) return;
      this.pressed = false;
      if (this.dragging) {
        this.dragging = false;
        return;
      }
      const { bx, by } = this.screenToBuffer(e.clientX, e.clientY);
      const cell = this.scene.pick(bx, by);
      if (cell !== null) this.events.onActivate(cell);
    };
    c.addEventListener("pointerup", release);
    c.addEventListener("pointercancel", () => {
      this.pressed = false;
      this.dragging = false;
    });

    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        const factor = Math.exp(-e.deltaY * 0.0015);
        this.userFramed = true;
        this.setScale(this.scale * factor, e.clientX - r.left, e.clientY - r.top);
      },
      { passive: false },
    );

    c.addEventListener("pointerleave", () => {
      // A keyboard cursor must survive the mouse leaving: they are the same cursor, and
      // taking the pointer off the canvas is not a reason to lose your place in it.
      if (this.hovered !== null && document.activeElement !== c) {
        this.hovered = null;
        this.events.onHover(null, "pointer");
        this.request();
      }
    });

    /* Keyboard. The canvas is a control, not a picture, and until now it could only be
       operated by pointing at it — which excludes anyone using a keyboard, a switch, or a
       screen reader, and it is the same people the identity gate is careful with.

       Arrows walk the grid's own axes rather than the screen's diagonals. The projection
       turns "up" into up-and-right, and a control whose arrow keys do not go the way the
       arrow points is worse than one with no arrow keys. */
    c.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 8 : 1;
      let dx = 0;
      let dy = 0;
      if (e.key === "ArrowLeft") dx = -step;
      else if (e.key === "ArrowRight") dx = step;
      else if (e.key === "ArrowUp") dy = -step;
      else if (e.key === "ArrowDown") dy = step;
      else if (e.key === "Enter" || e.key === " ") {
        if (this.hovered !== null) {
          e.preventDefault();
          this.events.onActivate(this.hovered);
        }
        return;
      } else if (e.key === "Home") {
        e.preventDefault();
        this.focusCellAt(0, 0);
        return;
      } else if (e.key === "End") {
        e.preventDefault();
        this.focusCellAt(COLS - 1, ROWS - 1);
        return;
      } else {
        return;
      }

      e.preventDefault();
      // Starting in the middle rather than at 0,0: a cursor that appears in a far corner of
      // an axonometric projection is a cursor nobody finds.
      const from = this.hovered ?? Math.floor(ROWS / 2) * COLS + Math.floor(COLS / 2);
      this.focusCellAt(
        Math.min(COLS - 1, Math.max(0, (from % COLS) + dx)),
        Math.min(ROWS - 1, Math.max(0, Math.floor(from / COLS) + dy)),
      );
    });

    // The scene can change size without the window doing so — a font landing, a breakpoint,
    // a rotated phone — so observe the element rather than the window.
    new ResizeObserver(() => this.resize()).observe(this.canvas);
  }

  request(): void {
    if (this.frameQueued) return;
    this.frameQueued = true;
    requestAnimationFrame(() => {
      this.frameQueued = false;
      this.paint();
    });
  }

  /** One blit plus the hover mark. Exposed so the benchmark can drive frames directly. */
  paint(): void {
    const g = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = getComputedStyle(document.body).getPropertyValue("--current-color-20") || "#FBFDFD";
    g.fillRect(0, 0, w, h);

    const s = this.scale * this.dpr;
    g.setTransform(s, 0, 0, s, this.tx * this.dpr, this.ty * this.dpr);
    g.drawImage(this.scene.bitmap, 0, 0, this.scene.bufferWidth, this.scene.bufferHeight);

    // The mark's geometry belongs to the projection: a rhombus in one, a square in the other.
    if (this.hovered !== null) {
      this.scene.drawMark(g, this.hovered, this.accentColour, this.scale);
    }
  }

  /** The cell under the pointer, or null. Read after an async lookup to check the pointer
   *  has not moved on — painting a stale record would attribute the wrong cell. */
  /**
   * Put the keyboard cursor on a cell, exactly as the pointer would.
   *
   * Reuses `hovered` rather than adding a second cursor: the mark, the readout, the tooltip
   * and the ownership fetch all already follow it, and two cursors would be two things to
   * keep in agreement for no gain.
   */
  private focusCellAt(cx: number, cy: number): void {
    const cell = cy * COLS + cx;
    if (cell === this.hovered) return;
    this.hovered = cell;
    this.events.onHover(cell, "keyboard");
    this.request();
  }

  /**
   * Bring a cell to the middle of the view, without changing the zoom.
   *
   * Used by the feed: a line that says where a pixel landed and cannot take you there is a
   * line of trivia. The scale is left alone on purpose — jumping *and* zooming loses the
   * reader's place twice.
   */
  centreOn(cell: number): void {
    const r = this.canvas.getBoundingClientRect();
    const { x, y } = this.scene.cellOrigin(cell);
    this.userFramed = true;
    this.tx = r.width / 2 - x * this.scale;
    this.ty = r.height / 2 - y * this.scale;
    this.boxW = r.width;
    this.boxH = r.height;
    this.request();
  }

  /** Where a cell sits on screen, in client coordinates. */
  cellToClient(cell: number): { x: number; y: number } {
    const { x: bx, y: by } = this.scene.cellOrigin(cell);
    const r = this.canvas.getBoundingClientRect();
    return {
      x: r.left + this.tx + bx * this.scale,
      y: r.top + this.ty + by * this.scale,
    };
  }

  get hoveredCell(): number | null {
    return this.hovered;
  }

  get currentScale(): number {
    return this.scale;
  }

  /** Benchmark hook: drive pan and zoom without synthesising pointer events. */
  setViewport(scale: number, tx: number, ty: number): void {
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    this.tx = tx;
    this.ty = ty;
  }
}
