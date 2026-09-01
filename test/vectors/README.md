# Conformance vectors

## `technocore-318.json`

```
sha256  8b56587004780e329d1fd5be11a5fc2868417e9bd3e9f832ff86358e29fa1081
size    26504 bytes
source  github.com/flop-labs/technocore-chat pull request #318
        tests/conformance/vectors.json
        fetched 2026-08-28 from Orvynel:test/signed-lane-conformance-vectors
```

Contents: 20 sweep cases, 3 identities, 8 rejected `did:key` shapes, 5 signature cases
each with 16 accepted spellings. Unicode 15.0.0, categories `Cc Cf Cs Co Zl Zp`, text cap
4096 characters.

## What this file is, and what it is not

It is the best available written-down statement of the signed lane: generated from the
server's own implementation, and `technocore-keykit` passes all of it.

**It is not authoritative.** #318 was still an **open pull request from a fork** when this
copy was taken — not merged, not published by Flop Labs. Treat it as strong evidence, not as
a specification.

Re-check when the PR merges: fetch the upstream file, compare the hash above, and if it
changed, run the tests against the new one before assuming anything still holds. The failure
mode this guards against is quiet — the server answers 403 for a wrong sweep and for a
forgery alike, so a drifted fixture would not announce itself.

## Why it is committed rather than fetched

A test that reaches the network to discover what it is testing fails for reasons unrelated
to the code, and would pass or fail differently depending on the day. The seeds inside are
counting patterns (`0x01` × 32, …) and the file says so itself: they are public, burned,
and must never be used as an identity.

## Running it

```bash
npm test                      # Node — 60 checks from this file
node test/browser/run.mjs     # Chromium, Firefox and WebKit — 54 checks each
```

The browser run is not redundant. T-1 measured WebKit 26.0 with no Ed25519 in
`crypto.subtle` at all, and the verifier still depends on WebCrypto for SHA-512 and
SHA-256. Node passing says the logic is right; only the browser run says the product works.
