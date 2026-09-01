/* Where the key lives between visits, and what that costs.
 *
 * `localStorage`, in plain text, on this device only. Every honest description of that is
 * uncomfortable and all of them are true:
 *
 *   - Anyone who can run JavaScript on this origin can read the seed. That is the same set of
 *     people who could sign with it anyway, so storage is not what creates the exposure —
 *     but it does mean "close the tab" is not a defence.
 *   - Clearing site data destroys the identity. There is no recovery, no email, no support.
 *     Every pixel signed with it stays in the room forever, attributed to a key nobody holds.
 *   - It does not follow the person to another browser or another device unless they export
 *     it themselves.
 *
 * The interface has to say this before the first write, not in a settings page afterwards.
 * FR-2 asks for local generation; the warning is what makes that honest rather than merely
 * convenient.
 */

import { type Identity, KeyError, fromSeedHex, generate, seedToHex } from "./key.ts";

const STORAGE_KEY = "signed-canvas.identity.v1";

export class StoreError extends Error {
  override readonly name = "StoreError";
}

interface Stored {
  readonly v: 1;
  readonly seed: string;
  readonly did: string;
  readonly created: string;
}

/**
 * Whether this browser will keep an identity at all.
 *
 * Private windows, blocked site data and some embedded views make `localStorage` throw on
 * access rather than return empty. A canvas that assumed storage works would generate a key,
 * let someone place pixels with it, and lose it on reload with no explanation.
 */
export function isPersistent(): boolean {
  try {
    const probe = `${STORAGE_KEY}.probe`;
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * The stored identity, or null if there is none.
 *
 * @throws StoreError if something is stored but cannot be read as an identity — silently
 * discarding it would replace a key whose pixels are already in the room.
 */
export async function load(): Promise<Identity | null> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // storage unavailable; treat as no identity, not as corruption
  }
  if (raw === null) return null;

  let parsed: Stored;
  try {
    parsed = JSON.parse(raw) as Stored;
  } catch {
    throw new StoreError("the stored identity is not readable JSON — export it before clearing");
  }
  try {
    const identity = await fromSeedHex(parsed.seed);
    if (parsed.did && parsed.did !== identity.did) {
      // The seed is authoritative; a mismatch means the record was edited or truncated.
      throw new StoreError(
        `the stored seed derives ${identity.did}, not the recorded ${parsed.did}`,
      );
    }
    return identity;
  } catch (error) {
    if (error instanceof KeyError) throw new StoreError(`stored seed is unusable: ${error.message}`);
    throw error;
  }
}

/**
 * Persist an identity.
 *
 * @throws StoreError if storage refuses the write, so the caller can tell the person their
 * key will not survive this tab rather than letting them find out on reload.
 */
export function save(identity: Identity): void {
  const record: Stored = {
    v: 1,
    seed: seedToHex(identity.seed),
    did: identity.did,
    created: new Date().toISOString(),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch (error) {
    throw new StoreError(
      `this browser will not store the key (${error instanceof Error ? error.message : "unknown"}) — ` +
        "it will be lost when the tab closes",
    );
  }
}

/** Load the stored identity, or make and store a new one. */
export async function loadOrCreate(): Promise<{ identity: Identity; created: boolean }> {
  const existing = await load();
  if (existing) return { identity: existing, created: false };
  const identity = await generate();
  save(identity);
  return { identity, created: true };
}

/** The seed as 64 hex characters — the whole identity, in a form a person can keep. */
export const exportSeed = (identity: Identity): string => seedToHex(identity.seed);

/**
 * Replace the stored identity with one rebuilt from an exported seed.
 *
 * @throws KeyError if the seed is malformed; StoreError if it cannot be stored.
 */
export async function importSeed(hex: string): Promise<Identity> {
  const identity = await fromSeedHex(hex);
  save(identity);
  return identity;
}

/** Forget the identity on this device. Irreversible without an exported seed. */
export function clear(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do: if storage cannot be written it holds nothing to remove either.
  }
}
