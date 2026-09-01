/* The key, and everything derived from it.
 *
 * It is generated here and it never leaves here. There is no account, no server-side
 * identity and nothing to recover: possession of these 32 bytes *is* the identity, which is
 * the whole point and also the whole risk. `store.ts` is where that risk is stated to the
 * person carrying it.
 */

import { getPublicKeyAsync, signAsync } from "@noble/ed25519";

import { DID_PATTERN } from "../crypto/did.ts";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MULTICODEC_ED25519_PUB = Uint8Array.of(0xed, 0x01);
export const SEED_BYTES = 32;

export class KeyError extends Error {
  override readonly name = "KeyError";
}

export interface Identity {
  /** The private seed. Never send this anywhere. */
  readonly seed: Uint8Array;
  readonly did: string;
}

function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  // A leading zero byte carries no value, so base58 cannot encode it as a digit; each one is
  // written as a leading '1' by convention. Dropping them silently shortens the DID.
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = BASE58[0]! + out;
  }
  return out || BASE58[0]!;
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const fromHex = (hex: string): Uint8Array => {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    throw new KeyError("seed must be an even-length hex string");
  }
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
};

export { toHex as seedToHex };

/**
 * The `did:key` for a seed.
 *
 * @throws KeyError if the seed is the wrong length, or if the derived DID does not match the
 * published shape — a check that costs nothing and catches an encoder bug before it becomes
 * an identity nobody can write as.
 */
export async function didFromSeed(seed: Uint8Array): Promise<string> {
  if (seed.length !== SEED_BYTES) {
    throw new KeyError(`seed must be ${SEED_BYTES} bytes, got ${seed.length}`);
  }
  const publicKey = await getPublicKeyAsync(seed);
  const prefixed = new Uint8Array(MULTICODEC_ED25519_PUB.length + publicKey.length);
  prefixed.set(MULTICODEC_ED25519_PUB, 0);
  prefixed.set(publicKey, MULTICODEC_ED25519_PUB.length);
  const did = `did:key:z${base58Encode(prefixed)}`;
  if (!DID_PATTERN.test(did)) {
    throw new KeyError(`derived a malformed did:key: ${did}`);
  }
  return did;
}

/** A new identity from the platform CSPRNG. */
export async function generate(): Promise<Identity> {
  const seed = crypto.getRandomValues(new Uint8Array(SEED_BYTES));
  return { seed, did: await didFromSeed(seed) };
}

/**
 * Rebuild an identity from an exported seed.
 *
 * @throws KeyError if the hex is malformed or the wrong length.
 */
export async function fromSeedHex(hex: string): Promise<Identity> {
  const seed = fromHex(hex.trim());
  if (seed.length !== SEED_BYTES) {
    throw new KeyError(`seed must be ${SEED_BYTES} bytes (${SEED_BYTES * 2} hex characters)`);
  }
  return { seed, did: await didFromSeed(seed) };
}

/** 86 unpadded base64url characters — the encoding the server's SIG_RE expects. */
export async function sign(identity: Identity, payload: string): Promise<string> {
  const signature = await signAsync(new TextEncoder().encode(payload), identity.seed);
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
