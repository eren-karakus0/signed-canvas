# 0002. Client render strategy and build stack

- Status: accepted
- Date: 2026-08-28
- Serves: the second open decision in `docs/specs/signed-canvas/design.md`

## Context and problem

The client renders a 64×64 axonometric canvas — 4,096 cells — with pan, zoom and per-cell
hit-testing, and holds an Ed25519 key it signs placements with. NFR-7 asks for 60 fps on a
mid-range laptop.

`design.md` framed this as one question, "which build stack". Measurement showed that is the
smaller half. **The render strategy decides whether the target is met at all; the build stack
does not.** So this ADR settles both, render first.

### Workload profile

| | |
|---|---|
| Scene | 4,096 cells. Worst case — every cell painted, most raised — is ~10,200 filled paths per full redraw. |
| Change rate | the scene is **static between placements**. Pan and zoom change the view, not the content. |
| Signing | `@noble/ed25519` in JS on every engine. `crypto.subtle` is not used: T-1 measured Ed25519 absent in WebKit 26.0. |
| Load | snapshot 2 KB, then a room delta of up to 200 messages / 37.7 KiB. |
| Interaction | one action — click a cell. No routing, no forms, no lists. |
| Team | one person. Design fidelity is the stated top priority. |

## Part 1 — Render strategy

### Options considered

- **R1 · Canvas 2D, full redraw each frame** — the obvious approach.
- **R2 · Canvas 2D, scene cached to an offscreen bitmap, blitted under a transform** — valid
  only because the scene is static between placements.
- **R3 · WebGL, instanced quads** — the approach that cannot run out of headroom.
- **R4 · DOM or SVG, one element per cell** — pan and zoom for free via CSS transforms.

### Measurement, not argument

180 frames of continuous pan and zoom over a fully-painted 4,096-cell scene, headless
Chromium 145, `bench/fps-bench.html`. Target: p95 ≤ 16.7 ms. (That harness was a standalone
copy of the renderer and was removed once `npm run bench` began driving the real build out of
`dist-bench/`; a benchmark measuring its own copy of the code measures the wrong thing.)

| | p50 | p95 | max | verdict |
|---|---|---|---|---|
| **R1** full redraw | 27.8 ms · 36 fps | 47.1 ms · 21 fps | 51.9 ms | **fails** |
| **R2** cached bitmap | 16.7 ms · 60 fps | 18.0 ms · 56 fps | 18.5 ms | **passes** |
| R2 + full invalidation each frame | 37.0 ms · 27 fps | 47.2 ms · 21 fps | 74.5 ms | fails |

Two things follow, and neither was obvious before measuring:

1. **Canvas 2D used naively does not reach the target.** The instinct that "4,096 rectangles
   is nothing" is wrong once each cell is three filled paths.
2. **Re-rendering the whole offscreen bitmap on every placement is as slow as R1.** A full
   scene render costs roughly 25–30 ms. As an occasional event that is one dropped frame; at
   a busy placement rate it is a stutter. **Placement must update a dirty region, not the
   whole scene.** That is a requirement on T-7, discovered here.

### Decision, part 1

**R2.** Render the scene once into an offscreen canvas; pan and zoom blit it under a
transform; a placement repaints only the affected cell's bounding box plus the cells that
overlap it in the axonometric order.

R3 is rejected by the over-engineering check: after R2 there is no measured bottleneck left
to solve, and WebGL would buy shader code, hand-written hit-testing, no free text or
antialiasing, and a class of driver bugs, in exchange for headroom nothing needs. R4 is
rejected because R2 already passes and 4,096 live DOM nodes is a worse memory and restyle
profile for the same result. **R1 is rejected by the measurement above** — it is the option
that would have been chosen by default.

### Caveats on the measurement

- Headless Chromium in this environment is likely **slower** than a real mid-range laptop, so
  this is a conservative floor rather than an optimistic reading. That is the right direction
  for a decision, but it is not a substitute for measuring on real hardware in T-7.
- R2's p50 of exactly 16.7 ms is **vsync-locked**, so its true headroom is unknown — the
  measurement proves it clears the bar, not by how much.
- Firefox and WebKit were not measured. T-1 showed engine differences are real in this
  project, so T-7 must re-run this across the matrix, not assume.

## Part 2 — Build stack

### Decision drivers

Weights fixed before scoring.

| Criterion | Weight | Why |
|---|---|---|
| Direct control of the identity and CSS | 5 | Design fidelity is the explicitly stated priority, and `.design/identity.md` is written as plain CSS custom properties. |
| Supply-chain surface | 5 | The product's whole claim is cryptographic. Every package sitting next to the signing path is a place that claim can be quietly broken. |
| Maintenance load | 4 | One person, six-plus months, alongside other work. |
| Development loop speed | 3 | Design iteration here is a Playwright screenshot loop, not HMR. |
| Deployment simplicity | 3 | Static files behind Cloudflare. |
| Does not obstruct the measured 60 fps | 3 | None of the four does; the criterion is listed to be visibly non-discriminating rather than silently dropped. |

### Options considered

- **B1 · No build** — plain ES modules, `@noble/ed25519` vendored as a pinned ESM file.
- **B2 · esbuild only** — one dev dependency, one command, TypeScript supported.
- **B3 · Vite, vanilla TS** — dev server with HMR and a production bundle.
- **B4 · Svelte or Preact + Vite** — a component model for the chrome.

Package existence and maintenance were verified against the npm registry on 2026-08-28:
`esbuild` 0.28.2 (2026-08-08, MIT) · `vite` 8.2.2 (2026-08-20, MIT) ·
`@noble/ed25519` 3.2.0 (2026-08-27, MIT). All current, all MIT.

### Scoring

| Criterion | W | B1 no build | B2 esbuild | B3 Vite | B4 framework |
|---|---|---|---|---|---|
| CSS / identity control | 5 | **5** | **5** | 4 | 3 |
| Supply-chain surface | 5 | **5** | 4 | 3 | 2 |
| Maintenance load | 4 | 4 | **5** | 3 | 2 |
| Development loop | 3 | 3 | 4 | **5** | **5** |
| Deployment simplicity | 3 | **5** | **5** | 4 | 4 |
| 60 fps not obstructed | 3 | 3 | 3 | 3 | 3 |
| **Total** | | 99 | **101** | 83 | 69 |

**B1 supply chain 5** — no npm tree at all; one audited, pinned file.
**B1 maintenance 4, not 5** — fewest moving parts, but no TypeScript, and the URL-building
and canonical-string code is exactly where a silent type slip becomes a bad signature.
**B2 supply chain 4** — one dev dependency that never ships to the browser, plus `@noble`
pinned from npm rather than vendored.
**B3 supply chain 3** — Vite 8 pulls a substantial transitive tree, and major-version
upgrades become recurring work over the project's life.
**B4 CSS control 3** — a component abstraction and scoped CSS sit between the identity and
the page, and the canvas itself is imperative anyway, so the component model earns nothing
where the complexity actually is.

### Decision, part 2

**B2 · esbuild**, at 101 against B1's 99 — inside the 10% band, so the tie is broken on
another axis and the reason is recorded here rather than left to the arithmetic.

The tie-breaker is **exit cost against correctness value**. The largest correctness risk in
this client is a byte-level mismatch in the canonical signed string. Types do not prevent
that — the conformance fixtures do — but they do prevent the adjacent class of bug where a
number reaches a string parameter in the URL builder and the server signs something the
client never meant. That is worth one pinned, MIT, never-shipped dev dependency. And if it
proves not to be, retreating from B2 to B1 is deleting a bundle step, not a rewrite.

### Consequences

**Good**
- CSS stays hand-written against `.design/identity.md`; no framework re-interprets the design.
- One dependency ships to the browser (`@noble/ed25519`, 18.8 KB) and it is the one the
  product cannot exist without.
- Output is static files: deployable anywhere, including beside the archiver behind the
  tunnel.

**Bad, and accepted**
- No HMR. Accepted: the page is small, reload is effectively instant, and the design loop is
  screenshot-based.
- A `package.json` and a lockfile now exist in a project that had none. That is the surface
  being bought, and it is bounded at one dev dependency — a second one is a decision, not a
  detail.
- R2's cached-bitmap strategy makes placement rendering more complex than a full redraw
  would be. This is the price of the measurement and it lands on T-7.

### Validation

- **T-7 re-runs the frame benchmark on real hardware and across Chromium, Firefox and
  WebKit.** If p95 exceeds 16.7 ms on any of them, R2 is insufficient and R3 returns to the
  table with a measurement behind it.
- **Placement latency**: repainting a dirty region after a placement must stay under 16.7 ms.
  If it approaches the ~25–30 ms full-scene cost, the dirty-region logic is not working.
- **Shipped JS**, excluding the snapshot, must stay under **60 KB** uncompressed. Crossing it
  means dependencies arrived without a decision.
- If a second production dependency is ever proposed, this ADR is the thing to argue with.
