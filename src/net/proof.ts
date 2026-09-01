/* What a pixel's ownership actually rests on, and what a person can take away with them.
 *
 * FR-6 asks the interface to show who owns a cell. FR-7 asks it to hand over material that
 * can be re-verified somewhere else — the point being that this product's claim is checkable
 * by a stranger with no reason to trust us.
 *
 * The T-5 finding split that in two, and this module keeps the split visible rather than
 * papering over it:
 *
 *   witnessed  we hold the signature. The export is a real proof: canonical string,
 *              signature and DID, verifiable by anyone, offline, forever.
 *   attested   we do not. technocore.chat verified a signature when the write happened and
 *              told us so by showing a did:key sender, and that is all anyone has. The export
 *              says exactly that, in words, and carries no signature field to be mistaken
 *              for one.
 *
 * A proof-shaped object that cannot be checked is worse than no export at all, because it
 * looks like the thing it is not.
 */

export interface Placement {
  readonly seq: number;
  readonly ts: string;
  readonly did: string;
  readonly step: number;
  readonly witnessed: boolean;
  /** `<room>|<nonce>|<swept text>` — the exact bytes that were signed. */
  readonly payload: string;
  /** 86 base64url characters, or null for an attested placement. */
  readonly sig: string | null;
}

export interface CellRecord {
  readonly cx: number;
  readonly cy: number;
  readonly placements: Placement[];
}

export class ProofError extends Error {
  override readonly name = "ProofError";
}

/**
 * Every placement in one cell, oldest first.
 *
 * @throws ProofError if the archive is unreachable or answers with something that is not a
 * cell record. A silent empty result would read as "nobody has ever painted here".
 */
export async function cellHistory(
  baseUrl: string,
  cx: number,
  cy: number,
  timeoutMs = 15_000,
): Promise<CellRecord> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/cell/${cx}/${cy}`, { signal: abort.signal });
    if (!response.ok) throw new ProofError(`${response.status} asking for cell ${cx},${cy}`);
    const body = (await response.json()) as { placements?: Placement[] };
    if (!Array.isArray(body.placements)) {
      throw new ProofError(`the archive did not return a cell record for ${cx},${cy}`);
    }
    return { cx, cy, placements: body.placements };
  } catch (error) {
    if (error instanceof ProofError) throw error;
    throw new ProofError(error instanceof Error ? error.message : "archive unreachable");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The text a person copies.
 *
 * For a witnessed placement this is everything needed to check the signature offline, in any
 * Ed25519 implementation, with no reference to this product. For an attested one it is a
 * plain statement of what is and is not known — deliberately not shaped like a proof.
 */
export function exportProof(cx: number, cy: number, placement: Placement): string {
  const lines = [
    `# Signed Canvas — pixel ${cx},${cy}`,
    `seq        ${placement.seq}`,
    `time       ${placement.ts}`,
    `did        ${placement.did}`,
    `step       ${placement.step}`,
    "",
  ];

  if (placement.witnessed && placement.sig !== null) {
    lines.push(
      "This pixel is WITNESSED: the signature below was verified against the payload,",
      "for a message that is in the room. Check it yourself — nothing here asks you to",
      "trust the canvas, the archive, or technocore.chat.",
      "",
      `payload    ${placement.payload}`,
      `signature  ${placement.sig}`,
      "",
      "Verify with Ed25519: the public key is the 32 bytes inside the did:key above",
      "(multibase 'z', multicodec 0xed01), the message is the payload as UTF-8, and the",
      "signature is 86 base64url characters.",
    );
  } else {
    lines.push(
      "This pixel is ATTESTED, not witnessed. technocore.chat verified a signature when",
      "the write happened and reports the did:key above as the sender. THE SIGNATURE",
      "ITSELF WAS NEVER PUBLISHED: the room read API does not return it, so nobody —",
      "including this archive — can re-check it. What follows is the payload that was",
      "signed, which you can rebuild but not verify.",
      "",
      `payload    ${placement.payload}`,
      "signature  (not held)",
      "",
      "A pixel becomes witnessed when whoever placed it hands the signature to the",
      "archive. Pixels placed through this client do that automatically.",
    );
  }

  return lines.join("\n");
}

/** One line for the interface: who holds this cell, and on what basis. */
export function describeOwner(placement: Placement | undefined): string {
  if (placement === undefined) return "unclaimed";
  const who = `${placement.did.slice(0, 14)}…${placement.did.slice(-4)}`;
  return `${who} · ${placement.witnessed ? "witnessed" : "attested"}`;
}
