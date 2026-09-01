/* Signature verification — the only authority in this product.
 *
 * A message paints a pixel if and only if this returns true. No other field grants anything:
 * not the DID it claims, not the sequence number the server assigned, not the fact that our
 * own archive stored it.
 *
 * `crypto.subtle` is not used for Ed25519. T-1 measured it absent in WebKit 26.0 —
 * NotSupportedError for Ed25519 and X25519 while ECDSA and RSA work, so a missing algorithm
 * rather than a flag. One JS path on every engine beats two paths where one is untested.
 */

import { verifyAsync } from "@noble/ed25519";

import { DidError, publicKeyOf } from "./did.ts";
import { messagePayload, notePayload } from "./canonical.ts";
import type { MessagePayload, NotePayload } from "./canonical.ts";

/** 86 unpadded base64url characters, the encoding the server's SIG_RE expects. */
export const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;

const SIGNATURE_BYTES = 64;
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Decode 86 base64url characters to 64 bytes.
 *
 * The last character carries only two significant bits — 86 characters hold 516 bits and a
 * signature is 512 — so sixteen spellings decode to the same signature and the server accepts
 * all of them. The surplus bits are discarded rather than rejected, which is what makes those
 * spellings equivalent here too.
 */
function decodeSignature(signature: string): Uint8Array {
  if (!SIGNATURE_PATTERN.test(signature)) {
    throw new VerifyError(`signature must be 86 base64url characters, got ${signature.length}`);
  }
  const out = new Uint8Array(SIGNATURE_BYTES);
  let acc = 0;
  let bits = 0;
  let written = 0;
  for (const ch of signature) {
    acc = (acc << 6) | B64URL.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (written < SIGNATURE_BYTES) out[written++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

export class VerifyError extends Error {
  override readonly name = "VerifyError";
}

/**
 * Does `signature` prove that the holder of `did` signed `payload`?
 *
 * Returns false for a signature that does not verify. Throws only when the *inputs* are
 * malformed — a DID that is not a did:key, a signature that is not 86 base64url characters —
 * because those are caller bugs and silently returning false would hide them.
 *
 * @throws DidError for a malformed DID, VerifyError for a malformed signature.
 */
export async function verifyPayload(
  did: string,
  signature: string,
  payload: string,
): Promise<boolean> {
  const publicKey = publicKeyOf(did);
  const sig = decodeSignature(signature);
  const message = new TextEncoder().encode(payload);
  try {
    return await verifyAsync(sig, message, publicKey);
  } catch {
    // noble throws on a signature that is well-formed base64 but not a valid curve point.
    // That is a failed verification, not a caller bug.
    return false;
  }
}

/** Verify a signed room message. Returns false if it does not verify. */
export async function verifyMessage(
  did: string,
  signature: string,
  payload: MessagePayload,
): Promise<boolean> {
  return verifyPayload(did, signature, messagePayload(payload));
}

/** Verify a signed note write. Returns false if it does not verify. */
export async function verifyNote(
  did: string,
  signature: string,
  payload: NotePayload,
): Promise<boolean> {
  return verifyPayload(did, signature, notePayload(payload));
}

export { DidError };
