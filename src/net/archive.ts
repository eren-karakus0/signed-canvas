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

export class ArchiveError extends Error {
  override readonly name = "ArchiveError";
}

export interface Cell {
  readonly cx: number;
  readonly cy: number;
  readonly step: number;
  readonly witnessed: boolean;
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
    painted: number;
    signers: number;
    witnessed_count: number;
    lag: number;
  };

  const cellBytes = decode(body.cells, CELL_BYTES);
  const witnessBytes = decode(body.witnessed, WITNESS_BYTES);

  const cells: Cell[] = [];
  for (let index = 0; index < N * N; index++) {
    const byte = cellBytes[index >> 1]!;
    const step = index % 2 === 0 ? byte >> 4 : byte & 0x0f;
    if (step === 0) continue;
    cells.push({
      cx: index % N,
      cy: Math.floor(index / N),
      step,
      witnessed: (witnessBytes[index >> 3]! & (1 << index % 8)) !== 0,
    });
  }

  return {
    seq: Number(body.seq) || 0,
    cells,
    painted: Number(body.painted) || cells.length,
    signers: Number(body.signers) || 0,
    witnessed: Number(body.witnessed_count) || 0,
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
