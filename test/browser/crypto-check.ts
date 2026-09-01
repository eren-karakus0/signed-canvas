/* The same conformance vectors, run inside a real browser engine.
 *
 * Node passing proves the logic. It does not prove the product: T-1 measured WebKit 26.0
 * with no Ed25519 in crypto.subtle at all, and the verifier depends on WebCrypto for SHA-512
 * and SHA-256 even though the curve arithmetic is JS. An engine that cannot digest is an
 * engine where nothing verifies, and finding that out from a user is too late.
 */

import { swept } from "../../src/crypto/sweep.ts";
import { fingerprintOf, publicKeyOf } from "../../src/crypto/did.ts";
import { messagePayload } from "../../src/crypto/canonical.ts";
import { verifyPayload } from "../../src/crypto/verify.ts";

interface Result {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

declare global {
  interface Window {
    __cryptoCheck?: { done: boolean; results: Result[]; passed: number; failed: number };
  }
}

const fromCodePoints = (points: number[]): string => String.fromCodePoint(...points);
const toCodePoints = (text: string): number[] => Array.from(text, (c) => c.codePointAt(0)!);

async function run(): Promise<void> {
  const results: Result[] = [];
  const record = (name: string, ok: boolean, detail = ""): void => {
    results.push({ name, ok, detail });
  };

  const vectors = await (await fetch("./vectors.json")).json();

  for (const vector of vectors.sweep_cases) {
    const input = fromCodePoints(vector.in_cp);
    try {
      const out = toCodePoints(swept(input, vectors.provenance.max_text_chars));
      record(
        `sweep ${vector.name}`,
        !vector.raises_empty && JSON.stringify(out) === JSON.stringify(vector.out_cp),
        JSON.stringify(out),
      );
    } catch (error) {
      record(`sweep ${vector.name}`, vector.raises_empty === true, String(error));
    }
  }

  for (const identity of vectors.identities) {
    try {
      record(
        `fingerprint ${identity.fingerprint}`,
        (await fingerprintOf(identity.did)) === identity.fingerprint,
      );
      record(`publicKey ${identity.fingerprint}`, publicKeyOf(identity.did).length === 32);
    } catch (error) {
      record(`fingerprint ${identity.fingerprint}`, false, String(error));
    }
  }

  for (const vector of vectors.did_invalid) {
    let threw = false;
    try {
      publicKeyOf(vector.did);
    } catch {
      threw = true;
    }
    record(`reject ${vector.why}`, threw);
  }

  for (const vector of vectors.signature_cases) {
    try {
      const payload = messagePayload({
        room: vector.room,
        nonce: vector.nonce,
        text: fromCodePoints(vector.text_raw_cp),
      });
      record(`payload ${vector.name}`, payload === vector.payload_display, payload);
      record(
        `verify ${vector.name}`,
        await verifyPayload(vector.did, vector.sig_canonical, vector.payload_display),
      );
      let allSpellings = true;
      for (const spelling of vector.sig_accepted_spellings) {
        if (!(await verifyPayload(vector.did, spelling, vector.payload_display))) {
          allSpellings = false;
          break;
        }
      }
      record(`spellings ${vector.name}`, allSpellings);
      record(
        `tamper ${vector.name}`,
        (await verifyPayload(vector.did, vector.sig_canonical, `${vector.payload_display}x`)) === false,
      );
    } catch (error) {
      record(`signature ${vector.name}`, false, String(error));
    }
  }

  const failed = results.filter((r) => !r.ok);
  window.__cryptoCheck = {
    done: true,
    results,
    passed: results.length - failed.length,
    failed: failed.length,
  };
  document.title = "DONE";
}

run().catch((error) => {
  window.__cryptoCheck = {
    done: true,
    results: [{ name: "runner", ok: false, detail: String(error) }],
    passed: 0,
    failed: 1,
  };
  document.title = "DONE";
});
