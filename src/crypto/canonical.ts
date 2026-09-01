/* The exact bytes that get signed. The third thing a client must reproduce byte-exactly.
 *
 * There is no negotiation and no versioning here: the server builds this string its own way
 * and compares signatures. A pipe in the wrong place is indistinguishable from a forgery.
 */

import { MAX_TEXT_CHARS, swept } from "./sweep.ts";

export class CanonicalError extends Error {
  override readonly name = "CanonicalError";
}

/** Room and namespace names the server accepts. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Nonces are decimal, and must strictly increase per (key, room). */
const NONCE_PATTERN = /^[0-9]{1,19}$/;

function requireName(value: string, label: string): string {
  const text = String(value).trim();
  if (!NAME_PATTERN.test(text)) {
    throw new CanonicalError(`${label} must match ${NAME_PATTERN.source} — got ${JSON.stringify(text)}`);
  }
  return text;
}

function requireNonce(value: number | string): string {
  const text = typeof value === "number" ? String(value) : String(value).trim();
  if (!NONCE_PATTERN.test(text)) {
    throw new CanonicalError(`nonce must be 1-19 decimal digits — got ${JSON.stringify(value)}`);
  }
  return text;
}

export interface MessagePayload {
  readonly room: string;
  readonly nonce: number | string;
  readonly text: string;
}

/**
 * `<room>|<nonce>|<swept text>` — what a signed room message signs.
 *
 * @throws CanonicalError for a bad room name or nonce; SweepError if the text would not
 * survive the sweep.
 */
export function messagePayload({ room, nonce, text }: MessagePayload, limit = MAX_TEXT_CHARS): string {
  return `${requireName(room, "room")}|${requireNonce(nonce)}|${swept(text, limit)}`;
}

export interface NotePayload {
  readonly namespace: string;
  readonly key: string;
  readonly nonce: number | string;
  readonly value: string;
}

/**
 * `<ns>|<key>|<nonce>|<swept value>` — what a signed note write signs.
 *
 * The server accepts signed note writes only for `room-owners` and `room-allow`; every other
 * namespace is world-writable and a signature there proves authorship of nothing, because
 * anyone can overwrite the note afterwards. That is why canvas state is not kept in a note.
 *
 * @throws CanonicalError for a bad namespace, key or nonce; SweepError for an unwritable value.
 */
export function notePayload(
  { namespace, key, nonce, value }: NotePayload,
  limit = MAX_TEXT_CHARS,
): string {
  return [
    requireName(namespace, "namespace"),
    requireName(key, "key"),
    requireNonce(nonce),
    swept(value, limit),
  ].join("|");
}
