/* Reading the canvas from our own archive.
 *
 * This is the read half of the CORS finding. technocore.chat sends no
 * `access-control-allow-origin`, so a browser cannot read the room at all — not just the
 * write response. The archive can: it is ours, and it sets the header.
 *
 * That makes the archive the only way a browser sees a canvas older than nothing, which is
 * what FR-8 asked for anyway. The difference is that it is now a requirement rather than an
 * optimisation, and when it is unreachable the interface says the canvas is unavailable
 * instead of quietly showing an empty grid.
 */

const CELL_BYTES = 2048;
const WITNESS_BYTES = 512;
const N = 64;
/* Levels a tower carries beneath its top. Mirrors `MAX_CONTEST` in projection.ts and
   `MAX_STACK` in snapshot.py — three names for one number, because the plane is laid out on
   the server, decoded here and drawn there, and a disagreement between any two of them draws
   a tower out of the wrong colours. */
const MAX_CONTEST = 8;
const STACK_BYTES = (N * N * MAX_CONTEST) / 2;

export class ArchiveError extends Error {
  override readonly name = "ArchiveError";
}

export interface Cell {
  readonly cx: number;
  readonly cy: number;
  readonly step: number;
  readonly witnessed: boolean;
  /**
   * The colours under `step`, bottom first, at most `MAX_CONTEST` of them.
   *
   * Empty for a cell placed once, and for every cell when the archive is older than the
   * stack plane. A delta placement carries no tower: the client already holds the column it
   * is landing on, and `Grid.place` pushes onto it.
   */
  readonly tower?: readonly number[];
}

export interface Snapshot {
  readonly seq: number;
  readonly cells: Cell[];
  readonly painted: number;
  readonly signers: number;
  readonly witnessed: number;
  /** How far the archive is behind the room. Non-zero means the canvas is slightly stale. */
  readonly lag: number;
}

function decode(text: string, expected: number): Uint8Array {
  const padded = text + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  if (binary.length !== expected) {
    throw new ArchiveError(`plane decodes to ${binary.length} bytes, expected ${expected}`);
  }
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function getJson(url: string, timeoutMs = 20_000): Promise<unknown> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: abort.signal });
    if (!response.ok) throw new ArchiveError(`${response.status} from ${url}`);
    return await response.json();
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError(error instanceof Error ? error.message : "unreachable");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The whole canvas in one request.
 *
 * @throws ArchiveError if the archive is unreachable or answers with planes of the wrong
 * size — a short plane would paint a canvas that is silently missing its tail.
 */
export async function snapshot(baseUrl: string): Promise<Snapshot> {
  const body = (await getJson(`${baseUrl}/snapshot`)) as {
    seq: number;
    cells: string;
    witnessed: string;
    stack?: string;
    painted: number;
    signers: number;
    witnessed_count: number;
    lag: number;
  };

  const cellBytes = decode(body.cells, CELL_BYTES);
  const witnessBytes = decode(body.witnessed, WITNESS_BYTES);

  // Optional so an archive that predates the plane still loads; those canvases simply come
  // back flat, which is what they did before it existed.
  const stackBytes =
    typeof body.stack === "string" ? decode(body.stack, STACK_BYTES) : undefined;

  const cells: Cell[] = [];
  for (let index = 0; index < N * N; index++) {
    const byte = cellBytes[index >> 1]!;
    const step = index % 2 === 0 ? byte >> 4 : byte & 0x0f;
    if (step === 0) continue;

    const tower: number[] = [];
    if (stackBytes) {
      for (let level = 0; level < MAX_CONTEST; level++) {
        const nibble = index * MAX_CONTEST + level;
        const packed = stackBytes[nibble >> 1]!;
        const colour = nibble % 2 === 0 ? packed >> 4 : packed & 0x0f;
        // 0 terminates. Reading past it would build a tower with a hole in it.
        if (colour === 0) break;
        tower.push(colour);
      }
    }

    cells.push({
      cx: index % N,
      cy: Math.floor(index / N),
      step,
      witnessed: (witnessBytes[index >> 3]! & (1 << index % 8)) !== 0,
      tower,
    });
  }

  /* Both counted from the plane that was just decoded, so they describe the same thing.
     The archive's own `witnessed_count` counts witnessed *placements* while `painted` counts
     occupied *cells*, and rendering one against the other put "44 OF 39 WITNESSED" in the
     header — a ratio above one, which is not a rounding error but a category error. */
  return {
    seq: Number(body.seq) || 0,
    cells,
    painted: cells.length,
    signers: Number(body.signers) || 0,
    witnessed: cells.reduce((n, cell) => n + (cell.witnessed ? 1 : 0), 0),
    lag: Number(body.lag) || 0,
  };
}

export interface Delta {
  readonly seq: number;
  readonly truncated: boolean;
  readonly placements: Cell[];
}

/**
 * Placements newer than `seq`, oldest first.
 *
 * `truncated` is carried through rather than hidden: a client that ignored it would paint a
 * canvas missing the middle of its own history and have no way to know.
 */
export async function since(baseUrl: string, seq: number): Promise<Delta> {
  const body = (await getJson(`${baseUrl}/since/${seq}`)) as {
    seq: number;
    truncated: boolean;
    placements: { cx: number; cy: number; step: number; witnessed: boolean }[];
  };
  return {
    seq: Number(body.seq) || seq,
    truncated: Boolean(body.truncated),
    placements: (body.placements ?? []).map((p) => ({
      cx: Number(p.cx),
      cy: Number(p.cy),
      step: Number(p.step),
      witnessed: Boolean(p.witnessed),
    })),
  };
}
