/* Nonces, which must strictly increase per (key, room).
 *
 * The clock is the obvious source and is almost right: it increases on its own and survives
 * a reload without any bookkeeping. It is wrong in two places, and both produce a 400 the
 * person cannot act on:
 *
 *   - two writes inside one millisecond get the same nonce
 *   - a clock that goes backwards — a correction, a suspend, a different device — reuses a
 *     range already spent
 *
 * So the clock is a floor, not the value: the counter never returns anything it has not
 * already advanced past. The high-water mark is stored per room, and `seed` exists because
 * the authoritative record of what a key has spent is the room itself, not this browser.
 */

const STORAGE_PREFIX = "signed-canvas.nonce.v1:";

export class NonceCounter {
  private highest = 0;

  private readonly room: string;

  constructor(room: string) {
    // Written out rather than declared as a parameter property: Node's type stripping
    // cannot transform those, and every module here has to stay runnable under `node --test`.
    this.room = room;
    this.highest = this.read();
  }

  private get key(): string {
    return `${STORAGE_PREFIX}${this.room}`;
  }

  private read(): number {
    try {
      const raw = localStorage.getItem(this.key);
      const value = raw === null ? 0 : Number(raw);
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  private write(value: number): void {
    try {
      localStorage.setItem(this.key, String(value));
    } catch {
      // Storage is unavailable. The in-memory mark still holds for this session, and the
      // clock floor covers the next one; losing the mark is not worth refusing to write.
    }
  }

  /**
   * Raise the mark to at least `value`.
   *
   * Called with what the room says this key has already spent, which is the only account
   * that matters after a browser change or a cleared profile.
   */
  seed(value: number): void {
    if (Number.isFinite(value) && value > this.highest) {
      this.highest = Math.floor(value);
      this.write(this.highest);
    }
  }

  /** The next nonce, as the decimal string the payload carries. */
  next(): string {
    const now = Date.now();
    this.highest = Math.max(now, this.highest + 1);
    this.write(this.highest);
    return String(this.highest);
  }

  get mark(): number {
    return this.highest;
  }
}
