/* The verifier against the published vectors — the whole point of T-4.
 *
 * The fixture is `test/vectors/technocore-318.json`, taken from flop-labs/technocore-chat#318
 * and committed here rather than fetched. A test that reaches the network to find out what it
 * is testing fails for reasons that have nothing to do with the code.
 *
 * PROVENANCE, and it matters: #318 is still an OPEN pull request from a fork. These vectors
 * are generated from the server's implementation by their author, and `technocore-keykit`
 * passes all of them, but they are not upstream and carry no guarantee. They are the best
 * available written-down statement of the signed lane, not an authority. Re-check when the
 * PR merges — `test/vectors/README.md` records the hash to compare against.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { SweepError, swept } from "../src/crypto/sweep.ts";
import { DID_PATTERN, DidError, fingerprintOf, publicKeyOf } from "../src/crypto/did.ts";
import { messagePayload } from "../src/crypto/canonical.ts";
import { verifyPayload } from "../src/crypto/verify.ts";

interface SweepCase {
  name: string;
  in_cp: number[];
  out_cp: number[];
  raises_empty: boolean;
  version_sensitive: boolean;
}
interface Identity {
  seed_hex: string;
  did: string;
  fingerprint: string;
}
interface DidInvalid {
  did: string;
  why: string;
}
interface SignatureCase {
  name: string;
  did: string;
  room: string;
  nonce: number;
  text_raw_cp: number[];
  text_swept_cp: number[];
  payload_display: string;
  payload_utf8_hex: string;
  sig_canonical: string;
  sig_accepted_spellings: string[];
}
interface Vectors {
  provenance: { unicode_version: string; max_text_chars: number; invisible_categories: string[] };
  sweep_cases: SweepCase[];
  identities: Identity[];
  did_invalid: DidInvalid[];
  signature_cases: SignatureCase[];
}

const vectors = JSON.parse(
  readFileSync(new URL("./vectors/technocore-318.json", import.meta.url), "utf8"),
) as Vectors;

const fromCodePoints = (points: number[]): string => String.fromCodePoint(...points);
const toCodePoints = (text: string): number[] => Array.from(text, (c) => c.codePointAt(0)!);
const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));

describe(`sweep · ${vectors.sweep_cases.length} vectors`, () => {
  for (const vector of vectors.sweep_cases) {
    it(vector.name, () => {
      const input = fromCodePoints(vector.in_cp);
      if (vector.raises_empty) {
        assert.throws(() => swept(input, vectors.provenance.max_text_chars), SweepError);
        return;
      }
      assert.deepEqual(
        toCodePoints(swept(input, vectors.provenance.max_text_chars)),
        vector.out_cp,
      );
    });
  }

  it("gives each swept character its own space rather than collapsing runs", () => {
    // Stated separately from the vectors because it is the mistake that looks like an
    // improvement, and a future edit is more likely to reintroduce it than to break a vector.
    assert.equal(swept("a\r\nc"), "a  c");
  });
});

describe(`did:key · ${vectors.identities.length} identities`, () => {
  for (const identity of vectors.identities) {
    it(`${identity.did.slice(0, 20)}… matches the published shape and key`, () => {
      assert.ok(DID_PATTERN.test(identity.did), "did should match the published pattern");
      assert.equal(publicKeyOf(identity.did).length, 32);
    });

    it(`${identity.did.slice(0, 20)}… fingerprints to ${identity.fingerprint}`, async () => {
      assert.equal(await fingerprintOf(identity.did), identity.fingerprint);
    });
  }
});

describe(`did:key · ${vectors.did_invalid.length} rejected shapes`, () => {
  for (const vector of vectors.did_invalid) {
    it(vector.why, () => {
      assert.throws(() => publicKeyOf(vector.did), DidError);
    });
  }
});

describe(`signatures · ${vectors.signature_cases.length} cases`, () => {
  for (const vector of vectors.signature_cases) {
    it(`${vector.name} · builds the published payload bytes`, () => {
      const payload = messagePayload({
        room: vector.room,
        nonce: vector.nonce,
        text: fromCodePoints(vector.text_raw_cp),
      });
      assert.equal(payload, vector.payload_display);
      assert.deepEqual(
        Array.from(new TextEncoder().encode(payload)),
        Array.from(fromHex(vector.payload_utf8_hex)),
      );
    });

    it(`${vector.name} · verifies the canonical signature`, async () => {
      assert.equal(
        await verifyPayload(vector.did, vector.sig_canonical, vector.payload_display),
        true,
      );
    });

    it(`${vector.name} · accepts all ${vector.sig_accepted_spellings.length} spellings`, async () => {
      for (const spelling of vector.sig_accepted_spellings) {
        assert.equal(
          await verifyPayload(vector.did, spelling, vector.payload_display),
          true,
          `spelling ending ${spelling.slice(-4)} should verify`,
        );
      }
    });

    it(`${vector.name} · refuses the payload with one byte changed`, async () => {
      // The vectors say what must pass. What must fail is ours to assert, and it is the half
      // that matters: a verifier that returns true for everything passes every positive test.
      const tampered = `${vector.payload_display}x`;
      assert.equal(await verifyPayload(vector.did, vector.sig_canonical, tampered), false);
    });

    it(`${vector.name} · refuses a signature from another identity`, async () => {
      const other = vectors.signature_cases.find((c) => c.did !== vector.did);
      if (!other) return;
      assert.equal(
        await verifyPayload(other.did, vector.sig_canonical, vector.payload_display),
        false,
      );
    });
  }
});
