/* did:key for Ed25519 — parsing, the public key inside it, and the fingerprint it is filed
 * under. The second of the three things a client must reproduce byte-exactly.
 */

export class DidError extends Error {
  override readonly name = "DidError";
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** An Ed25519 did:key is always this shape: multicodec 0xed01 + 32 key bytes, base58btc. */
export const DID_PATTERN = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;

const MULTICODEC_ED25519_PUB = [0xed, 0x01] as const;
const PUBLIC_KEY_BYTES = 32;
const FINGERPRINT_HEX_CHARS = 16;

export const isDid = (did: string): boolean => DID_PATTERN.test(did);

function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const ch of text) {
    const digit = BASE58.indexOf(ch);
    if (digit < 0) throw new DidError(`'${ch}' is not a base58btc character`);
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  // Leading '1's are leading zero bytes, and base58 cannot represent them any other way.
  for (const ch of text) {
    if (ch !== BASE58[0]) break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/**
 * The 32-byte Ed25519 public key a did:key carries.
 *
 * @throws DidError if the string is not an Ed25519 did:key. The shape is checked before the
 * decode so that a wrong multicodec and a wrong length are distinguishable in the message —
 * the server's own 403 says nothing, so the client's error has to.
 */
export function publicKeyOf(did: string): Uint8Array {
  if (!DID_PATTERN.test(did)) {
    throw new DidError(`bad did:key: expected did:key:z6Mk + 44 base58btc characters, got ${JSON.stringify(did)}`);
  }
  const decoded = base58Decode(did.slice("did:key:z".length));
  if (decoded.length !== MULTICODEC_ED25519_PUB.length + PUBLIC_KEY_BYTES) {
    throw new DidError(`bad did:key: decodes to ${decoded.length} bytes, expected 34`);
  }
  if (decoded[0] !== MULTICODEC_ED25519_PUB[0] || decoded[1] !== MULTICODEC_ED25519_PUB[1]) {
    throw new DidError("bad did:key: only ed25519-pub (0xed01) is accepted");
  }
  return decoded.slice(MULTICODEC_ED25519_PUB.length);
}

const HEX = "0123456789abcdef";

const toHex = (bytes: Uint8Array): string => {
  let out = "";
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 15]!;
  return out;
};

/**
 * The 16-hex handle a did:key is filed under.
 *
 * It is SHA-256 of the **did string**, not of the key bytes. Hashing the key instead
 * produces a plausible-looking handle that indexes nothing.
 *
 * @throws DidError if the string is not an Ed25519 did:key.
 */
export async function fingerprintOf(did: string): Promise<string> {
  if (!DID_PATTERN.test(did)) {
    throw new DidError(`not an Ed25519 did:key: ${JSON.stringify(did)}`);
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(did));
  return toHex(new Uint8Array(digest)).slice(0, FINGERPRINT_HEX_CHARS);
}
