# Vendored, not authored here

`tclk1-frames.schema.json` is copied verbatim from
[`flop-labs/tclk`](https://github.com/flop-labs/tclk/blob/main/schema/tclk1-frames.schema.json).

| | |
|---|---|
| commit | `5cc4ab93efbc` |
| committed | 2026-09-03 |
| fetched | 2026-09-13 |

It is here as a **test fixture**, so the frames this project builds are checked against
the artifact the protocol's own decoder uses rather than against our reading of the prose.
Nothing at runtime imports it.

Re-fetch it when tclk publishes a schema change, and record the new commit above. A
vendored copy nobody refreshes is how two conforming implementations drift apart.
