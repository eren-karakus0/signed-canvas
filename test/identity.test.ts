/* The signer, the store and the nonce counter.
 *
 * The signing tests are the strong ones: the fixture carries both a seed and the signature
 * the server's own implementation produced for a known payload, so "our signer agrees with
 * the server" is checkable rather than assumed. A verifier that accepts our own signatures
 * proves only that we are self-consistent.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";

import { DID_PATTERN } from "../src/crypto/did.ts";
import { verifyPayload } from "../src/crypto/verify.ts";
import { messagePayload } from "../src/crypto/canonical.ts";
import { KeyError, didFromSeed, fromSeedHex, generate, seedToHex, sign } from "../src/identity/key.ts";
import { NonceCounter } from "../src/net/nonce.ts";
import { token } from "../src/net/room.ts";

interface Vectors {
  identities: { seed_hex: string; did: string }[];
  signature_cases: {
    name: string;
    seed_hex: string;
    did: string;
    room: string;
    nonce: number;
    text_raw_cp: number[];
    payload_display: string;
    sig_canonical: string;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("./vectors/technocore-318.json", import.meta.url), "utf8"),
) as Vectors;

/* A minimal localStorage. Node 22 hides the real one behind a flag, and the counter's whole
   job is surviving a reload, which a stub can model exactly. */
class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

describe("did:key derivation", () => {
  for (const identity of vectors.identities) {
    it(`derives ${identity.did.slice(0, 22)}… from its published seed`, async () => {
      assert.equal(await didFromSeed(Buffer.from(identity.seed_hex, "hex")), identity.did);
    });
  }

  it("generates a DID matching the published shape", async () => {
    const identity = await generate();
    assert.ok(DID_PATTERN.test(identity.did), identity.did);
    assert.equal(identity.seed.length, 32);
  });

  it("gives a different key every time", async () => {
    const [a, b] = await Promise.all([generate(), generate()]);
    assert.notEqual(seedToHex(a.seed), seedToHex(b.seed));
  });

  it("round-trips through the exported seed", async () => {
    const original = await generate();
    const restored = await fromSeedHex(seedToHex(original.seed));
    assert.equal(restored.did, original.did);
  });

  it("refuses a malformed or wrong-length seed rather than deriving a plausible identity", async () => {
    for (const bad of ["", "zz", "00".repeat(31), "00".repeat(33), "0".repeat(63)]) {
      await assert.rejects(() => fromSeedHex(bad), KeyError, `should reject ${bad.slice(0, 8)}…`);
    }
  });
});

describe("signing", () => {
  for (const vector of vectors.signature_cases) {
    it(`${vector.name} · reproduces the server's own signature byte for byte`, async () => {
      const identity = await fromSeedHex(vector.seed_hex);
      assert.equal(identity.did, vector.did);
      const signature = await sign(identity, vector.payload_display);
      assert.equal(signature, vector.sig_canonical);
    });

    it(`${vector.name} · signs the payload built from the raw text`, async () => {
      const identity = await fromSeedHex(vector.seed_hex);
      const payload = messagePayload({
        room: vector.room,
        nonce: vector.nonce,
        text: String.fromCodePoint(...vector.text_raw_cp),
      });
      const signature = await sign(identity, payload);
      assert.equal(await verifyPayload(identity.did, signature, payload), true);
      assert.equal(signature, vector.sig_canonical);
    });
  }

  it("produces 86 base64url characters", async () => {
    const identity = await generate();
    const signature = await sign(identity, "lobby|1|hello");
    assert.match(signature, /^[A-Za-z0-9_-]{86}$/);
  });
});

describe("placement token", () => {
  it("is six base36 characters", () => {
    for (let i = 0; i < 50; i++) assert.match(token(), /^[0-9a-z]{6}$/);
  });

  it("does not repeat across many draws", () => {
    const seen = new Set(Array.from({ length: 2000 }, () => token()));
    // Birthday bound on 36^6 ≈ 2.2e9: a handful of collisions in 2,000 draws would be
    // extraordinary, and a generator stuck on one value would show up as a tiny set.
    assert.ok(seen.size > 1990, `only ${seen.size} distinct tokens in 2000 draws`);
  });
});

describe("nonce counter", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  });

  it("strictly increases even when called faster than the clock ticks", () => {
    const counter = new NonceCounter("lobby");
    const values = Array.from({ length: 500 }, () => Number(counter.next()));
    for (let i = 1; i < values.length; i++) {
      assert.ok(values[i]! > values[i - 1]!, `nonce ${values[i]} did not exceed ${values[i - 1]}`);
    }
  });

  it("survives a reload without reusing a nonce", () => {
    const first = new NonceCounter("lobby");
    const last = Number(first.next());
    const second = new NonceCounter("lobby");
    assert.ok(Number(second.next()) > last);
  });

  it("keeps separate marks per room", () => {
    const lobby = new NonceCounter("lobby");
    const canvas = new NonceCounter("canvas");
    lobby.seed(9_000_000_000_000);
    assert.ok(canvas.mark < 9_000_000_000_000);
  });

  it("never goes backwards when the clock does", () => {
    const counter = new NonceCounter("lobby");
    counter.seed(Date.now() + 10_000_000);
    const mark = counter.mark;
    // next() takes the larger of the clock and the mark, so a clock behind the mark cannot
    // hand back a nonce the room has already seen.
    assert.ok(Number(counter.next()) > mark);
  });

  it("takes the room's account when it is ahead of this browser", () => {
    const counter = new NonceCounter("lobby");
    const fromRoom = Date.now() + 5_000_000;
    counter.seed(fromRoom);
    assert.ok(Number(counter.next()) > fromRoom);
  });

  it("ignores a seed that is behind, junk or negative", () => {
    const counter = new NonceCounter("lobby");
    const before = Number(counter.next());
    counter.seed(1);
    counter.seed(Number.NaN);
    counter.seed(-5);
    assert.ok(Number(counter.next()) > before);
  });
});
