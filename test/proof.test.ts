/* What a person walks away with.
 *
 * The export is a pure function of one record, so it belongs here rather than in a browser
 * test: the thing worth checking is the *text*, and the strongest assertion is that a
 * witnessed export actually verifies with an independent implementation.
 *
 * The attested case gets as much attention as the witnessed one. It is the case where a
 * dishonest export would be invisible — a proof-shaped block with a payload and no signature
 * reads like a proof to anyone not looking closely, and this product cannot afford that.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { exportProof, describeOwner, type Placement } from "../src/net/proof.ts";
import { fromSeedHex, sign } from "../src/identity/key.ts";
import { verifyPayload } from "../src/crypto/verify.ts";

const SEED = "01".repeat(32);
const PAYLOAD = "fplace|1788000000000|px 12,47 3 k8f2a1";

async function witnessed(): Promise<Placement> {
  const identity = await fromSeedHex(SEED);
  return {
    seq: 471,
    ts: "2026-08-29T10:00:00.000000Z",
    did: identity.did,
    step: 3,
    witnessed: true,
    payload: PAYLOAD,
    sig: await sign(identity, PAYLOAD),
  };
}

async function attested(): Promise<Placement> {
  const identity = await fromSeedHex(SEED);
  return {
    seq: 472,
    ts: "2026-08-29T10:00:01.000000Z",
    did: identity.did,
    step: 3,
    witnessed: false,
    payload: PAYLOAD,
    sig: null,
  };
}

describe("a witnessed export", () => {
  it("carries the three things needed to check it, and nothing that must be trusted", async () => {
    const placement = await witnessed();
    const text = exportProof(12, 47, placement);
    assert.match(text, /WITNESSED/);
    assert.ok(text.includes(placement.did), "the DID must be in the export");
    assert.ok(text.includes(placement.payload), "the signed bytes must be in the export");
    assert.ok(text.includes(placement.sig!), "the signature must be in the export");
  });

  it("verifies when checked independently, which is the whole point", async () => {
    // Read the payload and signature back out of the exported text, the way a stranger
    // would, and check them. An export nobody can act on is decoration.
    const placement = await witnessed();
    const text = exportProof(12, 47, placement);

    const did = /^did\s+(\S+)$/m.exec(text)?.[1];
    const payload = /^payload\s+(.+)$/m.exec(text)?.[1];
    const signature = /^signature\s+(\S+)$/m.exec(text)?.[1];

    assert.ok(did && payload && signature, "all three fields must be parseable from the text");
    assert.equal(await verifyPayload(did!, signature!, payload!), true);
  });

  it("does not verify once a byte of the payload is changed", async () => {
    const placement = await witnessed();
    const text = exportProof(12, 47, placement);
    const did = /^did\s+(\S+)$/m.exec(text)?.[1];
    const signature = /^signature\s+(\S+)$/m.exec(text)?.[1];
    assert.equal(await verifyPayload(did!, signature!, `${PAYLOAD} `), false);
  });

  it("names the cell it is about", async () => {
    assert.match(exportProof(12, 47, await witnessed()), /pixel 12,47/);
  });
});

describe("an attested export", () => {
  it("says plainly that no signature exists", async () => {
    const text = exportProof(12, 47, await attested());
    assert.match(text, /ATTESTED, not witnessed/);
    assert.match(text, /SIGNATURE\s+ITSELF WAS NEVER PUBLISHED|NEVER PUBLISHED/);
    assert.match(text, /signature {2}\(not held\)/);
  });

  it("never contains a signature field that could be mistaken for one", async () => {
    const text = exportProof(12, 47, await attested());
    // Nothing in the text may look like an 86-character base64url signature.
    assert.equal(/[A-Za-z0-9_-]{86}/.test(text.replace(/did:key:\S+/g, "")), false);
  });

  it("still carries the payload, because rebuilding it is honest and useful", async () => {
    const text = exportProof(12, 47, await attested());
    assert.ok(text.includes(PAYLOAD));
    assert.match(text, /rebuild but not verify/);
  });

  it("does not use the word witnessed to describe itself", async () => {
    const text = exportProof(12, 47, await attested());
    const firstLineOfClaim = /This pixel is (\w+)/.exec(text)?.[1];
    assert.equal(firstLineOfClaim, "ATTESTED");
  });
});

describe("describeOwner", () => {
  it("says unclaimed for an empty cell", () => {
    assert.equal(describeOwner(undefined), "unclaimed");
  });

  it("abbreviates the DID and names the basis", async () => {
    const placement = await witnessed();
    const line = describeOwner(placement);
    // 14 leading characters, an ellipsis, then the last four — short enough to fit the
    // readout, long enough that two identities are not confusable at a glance.
    assert.match(line, /^did:key:z6Mk\w{2}…[1-9A-HJ-NP-Za-km-z]{4} · witnessed$/);
  });

  it("distinguishes attested from witnessed", async () => {
    assert.match(describeOwner(await attested()), /· attested$/);
  });
});
