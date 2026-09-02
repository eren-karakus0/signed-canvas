/* Wiring only. Everything with a decision in it lives in src/canvas, src/crypto, src/identity
 * and src/net.
 *
 * The order matters and is the product's whole claim: paint optimistically so the canvas
 * feels immediate, then write, then reconcile. A pixel the room refused must not stay on
 * screen looking placed — the canvas is supposed to show what is in the room, and a hopeful
 * pixel is a small lie about exactly the thing this product sells. */

import { Grid } from "./canvas/grid.ts";
import { Scene } from "./canvas/scene.ts";
import { View } from "./canvas/view.ts";
import { EMPTY, PATINA, STEPS } from "./canvas/palette.ts";
import { N } from "./canvas/projection.ts";
import { formatPlacement, parsePlacement } from "./canvas/wire.ts";
import { ARCHIVE_URL, ROOM, hasArchive, relayUrl } from "./config.ts";
import { loadOrCreate } from "./identity/store.ts";
import { IdentityPanel } from "./ui/identity-panel.ts";
import { NonceCounter } from "./net/nonce.ts";
import { lastNonce, place, token } from "./net/room.ts";
import { snapshot } from "./net/archive.ts";
import { type LivePlacement, follow } from "./net/live.ts";
import { type Placement, cellHistory, describeOwner, exportProof } from "./net/proof.ts";
import { copyText } from "./ui/clipboard.ts";

const need = <T extends Element>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing element: ${selector}`);
  return el;
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

const grid = new Grid();
const scene = new Scene(grid);
const canvas = need<HTMLCanvasElement>("#canvas");
const statusLine = need<HTMLElement>("#status");
const provenance = need<HTMLElement>("#provenance");
const cellText = need<HTMLElement>("#r-cell");
const stepText = need<HTMLElement>("#r-step");
const contestText = need<HTMLElement>("#r-contest");
const paintedText = need<HTMLElement>("#r-painted");
const ownerText = need<HTMLElement>("#r-owner");
const basisText = need<HTMLElement>("#r-basis");
const proofButton = need<HTMLButtonElement>("#proof");
const proofHint = need<HTMLElement>("#proof-hint");
const latestLine = need<HTMLElement>("#latest");

let selectedStep = 1;
let roomHead = 0;
/** Cells with a write in flight. A second click would race its own reconcile. */
const inFlight = new Set<number>();

/* One placement at a time, then a pause.
 *
 * Clicking faster than the service answers produced real refusals on the deployed site: 503s
 * from its load shedder, and a `400 nonce … is not greater than …` when an attempt backing
 * off was overtaken by a later placement. The nonce race is fixed at its source in
 * `net/room.ts`, which re-signs every attempt — this is the separate, deliberate choice that
 * a person should not be able to spend their whole write budget in four seconds.
 *
 * Ten seconds is not derived from the rate limit (300 writes/minute would allow far more).
 * It is a pace, chosen so a canvas is composed rather than sprayed. */
const PLACE_COOLDOWN_MS = 10_000;
let readyToPlaceAt = 0;
let cooldownTimer: number | undefined;

const cooldownBox = need<HTMLElement>("#cooldown");
const cooldownText = need<HTMLElement>("#cooldown-text");
const cooldownBar = need<HTMLElement>("#cooldown-bar");

/**
 * Run the visible countdown to the next placement.
 *
 * The number is stepped once a second; the bar is handed the whole duration and left to
 * sweep, so the wait reads as passing rather than as a value being rewritten. Both are
 * outside the `aria-live` status line on purpose — a number that changes every second would
 * be announced every second, and the status line already says the wait once, in words.
 */
function startCooldown(): void {
  window.clearInterval(cooldownTimer);
  cooldownBox.hidden = false;

  // Reset to full, force the style to settle, then let it run: without the reflow the
  // browser coalesces both writes and the bar jumps straight to empty.
  cooldownBar.style.transition = "none";
  cooldownBar.style.transform = "scaleX(1)";
  void cooldownBar.offsetWidth;
  cooldownBar.style.transition = `transform ${PLACE_COOLDOWN_MS}ms linear`;
  cooldownBar.style.transform = "scaleX(0)";

  const tick = (): void => {
    const left = Math.ceil((readyToPlaceAt - Date.now()) / 1000);
    if (left <= 0) {
      window.clearInterval(cooldownTimer);
      cooldownTimer = undefined;
      cooldownBox.hidden = true;
      return;
    }
    cooldownText.textContent = `next pixel in ${left}s`;
  };
  tick();
  cooldownTimer = window.setInterval(tick, 250);
}

function say(message: string, tone: "info" | "ok" | "warn" = "info"): void {
  statusLine.textContent = message;
  statusLine.dataset["tone"] = tone;
}

function showPainted(): void {
  paintedText.textContent = `${grid.painted()} / ${N * N}`;
}

function showCell(cell: number | null): void {
  if (cell === null) {
    cellText.textContent = "—";
    stepText.textContent = "—";
    contestText.textContent = "—";
    return;
  }
  const state = grid.get(cell % N, Math.floor(cell / N));
  if (!state) return;
  cellText.textContent = `${pad2(state.cx)}, ${pad2(state.cy)}`;
  stepText.textContent = state.step === EMPTY ? "empty" : pad2(state.step);
  contestText.textContent = state.contest === 0 ? "never" : `${state.contest}×`;
}

function repaint(cx: number, cy: number): void {
  scene.invalidateCell(cx, cy);
  view.request();
  showPainted();
}

/* ---- identity ---------------------------------------------------------------------- */

const { identity, created } = await loadOrCreate();
let nonces = new NonceCounter(ROOM);

const panel = new IdentityPanel(need("#identity"), need("#gate"), identity, created, {
  onIdentityChanged(next) {
    nonces = new NonceCounter(ROOM);
    void seedNonceFromRoom(next.did);
  },
  onNotice: (message, tone) => say(message, tone),
});

/**
 * Take the room's account of what this key has already spent.
 *
 * This browser's high-water mark is not authoritative: the same key may have written from
 * another device, or this profile may have been cleared. A reused nonce is a 400 the person
 * cannot act on, so the room is asked rather than assumed.
 */
async function seedNonceFromRoom(did: string): Promise<void> {
  try {
    nonces.seed(await lastNonce(ROOM, did));
  } catch {
    // The clock floor still holds. Not worth blocking the canvas over.
  }
}


/* ---- who owns a cell, and on what basis ------------------------------------------- */

/* Ownership needs the DID, and the snapshot carries only colours — 2,048 bytes of palette
   indices cannot hold 4,096 DIDs. So it is fetched per cell, debounced, and cached: hovering
   across the canvas must not become one request per pixel crossed. */
const HOVER_SETTLE_MS = 280;
const owners = new Map<number, Placement | null>();
let hoverTimer: number | undefined;
let inspecting: { cell: number; top: Placement } | null = null;

function clearOwner(message: string): void {
  ownerText.textContent = "—";
  basisText.textContent = "—";
  delete basisText.dataset["basis"];
  proofButton.disabled = true;
  proofHint.textContent = message;
  inspecting = null;
}

function showOwner(cell: number, top: Placement | null): void {
  if (top === null) {
    clearOwner("nothing placed here yet");
    return;
  }
  ownerText.textContent = describeOwner(top).split(" · ")[0] ?? "—";
  basisText.textContent = top.witnessed ? "witnessed" : "attested";
  basisText.dataset["basis"] = top.witnessed ? "witnessed" : "attested";
  proofButton.disabled = false;
  // Name the cell the export is for. The inspection is pinned rather than following the
  // pointer, so without this the button would be about an unstated cell.
  proofHint.textContent =
    `for ${pad2(cell % N)},${pad2(Math.floor(cell / N))} · ` +
    (top.witnessed
      ? "signature held, the export can be checked by anyone"
      : "no signature held, and the export says so rather than pretending");
  inspecting = { cell, top };
}

function inspectCell(cell: number | null): void {
  window.clearTimeout(hoverTimer);

  // Leaving the canvas must not clear the inspection. Moving the pointer towards the proof
  // button leaves the canvas, which fired pointerleave, which disabled the button before it
  // could be clicked — the feature was unreachable for a person, not only for the test that
  // found it. The last painted cell stays pinned until another one replaces it.
  if (cell === null) return;

  if (grid.step[cell] === EMPTY) {
    if (inspecting === null) clearOwner("hover a painted cell");
    return;
  }
  const cached = owners.get(cell);
  if (cached !== undefined) {
    showOwner(cell, cached);
    return;
  }
  proofHint.textContent = "reading the record…";
  hoverTimer = window.setTimeout(() => {
    if (!hasArchive()) {
      clearOwner("no archive configured — ownership cannot be shown");
      return;
    }
    const cx = cell % N;
    const cy = Math.floor(cell / N);
    void cellHistory(ARCHIVE_URL, cx, cy)
      .then((record) => {
        const top = record.placements.at(-1) ?? null;
        owners.set(cell, top);
        // The pointer may have moved on while this was in flight; only paint if it did not.
        if (view.hoveredCell === cell) showOwner(cell, top);
      })
      .catch(() => {
        proofHint.textContent = "the record could not be read";
      });
  }, HOVER_SETTLE_MS);
}

proofButton.addEventListener("click", () => {
  if (inspecting === null) return;
  const { cell, top } = inspecting;
  const text = exportProof(cell % N, Math.floor(cell / N), top);
  const what = top.witnessed
    ? "proof — it verifies without this site"
    : "record — this pixel is attested, so there is no signature to check";

  void copyText(text, "Copy the proof for this pixel:").then((result) => {
    if (result.kind === "copied") say(`${what} copied`, top.witnessed ? "ok" : "info");
    else if (result.kind === "shown") say(`clipboard refused — the ${what} is in the dialog`);
    else say(`could not copy: ${result.reason}`, "warn");
  });
});

/* ---- the canvas -------------------------------------------------------------------- */

const view = new View(canvas, scene, {
  onHover(cell) {
    showCell(cell);
    inspectCell(cell);
  },
  onActivate(cell) {
    void placePixel(cell % N, Math.floor(cell / N));
  },
});

async function placePixel(cx: number, cy: number): Promise<void> {
  if (!panel.ready) {
    say("read the notice first — it is about a key nobody can give back", "warn");
    return;
  }
  // No gate here any more. Until 2026-08-31 there was one: technocore.chat sent no
  // access-control-allow-origin, so a browser could send a write and never learn whether it
  // was accepted, and placing was refused rather than showing a mark that might not exist.
  // The service now answers every origin, so the room is reachable directly and a missing
  // relay costs a round trip, not the feature.
  // One at a time. Concurrent placements each take a nonce, and the one that answers last is
  // holding the lower number — handled correctly now, but there is no reason to create the
  // race, and a person clicking into a queue cannot tell which click did what.
  if (inFlight.size > 0) {
    say("one pixel at a time — the last one is still being written", "warn");
    return;
  }
  const waitMs = readyToPlaceAt - Date.now();
  if (waitMs > 0) {
    say(`${Math.ceil(waitMs / 1000)}s before the next pixel`, "warn");
    return;
  }

  const relay = relayUrl();
  const index = cy * N + cx;
  if (inFlight.has(index)) return;

  // Build the line before painting anything. If the format refuses it, nothing has been
  // shown yet — painting first and failing after leaves a pixel on screen that was never
  // written and never will be.
  let text: string;
  try {
    text = formatPlacement(cx, cy, selectedStep, token());
  } catch (error) {
    say(`refused before signing: ${error instanceof Error ? error.message : "unknown"}`, "warn");
    return;
  }

  const previousStep = grid.step[index]!;
  const previousContest = grid.contest[index]!;
  if (!grid.place(cx, cy, selectedStep)) return;

  inFlight.add(index);
  repaint(cx, cy);
  say(`signing ${pad2(cx)},${pad2(cy)}…`);
  const outcome = await place({
    identity: panel.current,
    room: ROOM,
    text,
    // Handed as a function so every retry takes a fresh one. A nonce is spent when it is
    // issued, and a placement that lands while an earlier attempt is backing off leaves that
    // attempt holding a number the service will no longer accept.
    nextNonce: () => nonces.next(),
    sinceSeq: roomHead,
    ...(relay === undefined ? {} : { relayUrl: relay }),
    onRetry: (attempt, reason) => say(`${reason} — retry ${attempt}`),
  });

  inFlight.delete(index);

  if (outcome.kind === "placed") {
    // Record it locally instead of waiting for the archive to catch up. The ingest loop
    // polls, so for a few seconds after a placement the archive still says the cell is
    // empty — and telling someone their own pixel does not exist, a second after they
    // placed it, is worse than a stale read. We also hold better material than the archive
    // does here: we computed this signature, so the proof is exportable immediately.
    owners.set(index, {
      seq: outcome.seq,
      ts: new Date().toISOString(),
      did: panel.current.did,
      step: selectedStep,
      witnessed: true,
      payload: `${ROOM}|${outcome.nonce}|${outcome.text}`,
      sig: outcome.signature,
    });
    // Both halves of the readout, not just the ownership half. The pointer has not moved, so
    // nothing else will refresh the step and the contest count, and the row would go on
    // reading "step empty" beside the owner of a pixel that is plainly on screen.
    if (view.hoveredCell === index) {
      showCell(index);
      inspectCell(index);
    }
    roomHead = Math.max(roomHead, outcome.seq);
    readyToPlaceAt = Date.now() + PLACE_COOLDOWN_MS;
    startCooldown();
    // Name the lane when it was not the relay. The pixel is equally placed and equally
    // provable either way — we hold the signature — but it says why the archive has not
    // caught up yet, which is otherwise an unexplained few seconds.
    const how = outcome.via === "room" ? " straight to the room" : "";
    say(
      `placed${how} at seq ${outcome.seq}, signed by ${panel.current.did.slice(0, 12)}…`,
      "ok",
    );
    return;
  }

  grid.step[index] = previousStep;
  grid.contest[index] = previousContest;
  repaint(cx, cy);

  if (outcome.kind === "refused") {
    const wait = outcome.retryAfter === undefined ? "" : ` — wait ${outcome.retryAfter}s`;
    say(`not placed: ${outcome.reason}${wait}`, "warn");
  } else {
    // "unknown" is not "failed". Saying either would be a guess, and a wrong guess here
    // either loses a pixel or places a second one.
    say(`not placed, and not certain: ${outcome.reason}. Reload before trying again.`, "warn");
  }
}

/* ---- loading ----------------------------------------------------------------------- */

/**
 * The canvas comes from the archive, not from the room.
 *
 * This is the read half of the CORS finding: technocore.chat sends no
 * `access-control-allow-origin`, so a browser cannot read the room at all. Reading the room
 * directly was the first implementation and it failed with "Failed to fetch" on every load —
 * the page came up with an empty grid and a warning.
 *
 * FR-8 always specified snapshot-then-delta. What changed is that it is now the only way a
 * browser can see the canvas, so an unreachable archive is stated plainly instead of being
 * shown as an empty canvas somebody might start drawing on.
 */
async function loadCanvas(base: string): Promise<void> {
  const state = await snapshot(base);
  // `restore`, not `place`: the snapshot carries each cell's whole column, and replaying it
  // one placement at a time would rebuild the tower from the top colour alone — which is how
  // every reload used to flatten the canvas.
  for (const cell of state.cells) {
    grid.restore(cell.cx, cell.cy, cell.step, cell.tower ?? []);
  }
  roomHead = state.seq;
  scene.drawAll();
  view.fit();
  showPainted();

  const stale = state.lag > 0 ? ` · ${state.lag} behind the room` : "";
  const proven =
    state.witnessed === 0
      ? "none witnessed yet"
      : `${state.witnessed} of ${state.painted} witnessed`;
  provenance.textContent = `archive · seq ${state.seq} · ${state.signers} signers · ${proven}${stale}`;
}

/* ---- the room, as it happens ------------------------------------------------------- */

/**
 * Draw a placement that arrived from the room.
 *
 * Idempotent for our own pixels: they are painted optimistically on click and come back
 * through the follower a moment later, and `Grid.place` reports no change when the colour is
 * already there — so a cell is not counted as contested against itself.
 */
function applyIncoming(placement: LivePlacement): void {
  const { cx, cy, step } = placement;
  if (grid.place(cx, cy, step)) {
    repaint(cx, cy);
    // A cell whose owner was cached now has a different one. Dropping the entry is cheaper
    // than refetching it, and the next hover asks again.
    owners.delete(cy * N + cx);
    if (view.hoveredCell === cy * N + cx) {
      showCell(cy * N + cx);
      inspectCell(cy * N + cx);
    }
  }
  showLatest(placement);
}

/** Who painted the last pixel, and whether this browser checked the signature itself. */
function showLatest(placement: LivePlacement): void {
  const who =
    placement.did === ""
      ? "someone"
      : `${placement.did.slice(0, 12)}…${placement.did.slice(-4)}`;
  const mark = placement.verified ? "verified here" : "not re-verifiable";
  latestLine.hidden = false;
  latestLine.dataset["verified"] = String(placement.verified);
  latestLine.innerHTML = "";
  latestLine.append(
    document.createTextNode(`${who} → ${pad2(placement.cx)},${pad2(placement.cy)} · `),
  );
  const span = document.createElement("span");
  span.className = "latest__mark";
  span.textContent = mark;
  latestLine.append(span);
}

/* The network never blocks the interface. The ramp and the readout are built below, and a
   load that fails must not take the controls with it. */
function startLoading(): void {
  if (!hasArchive()) {
    provenance.textContent = "no archive configured";
    say(
      "the canvas cannot be shown: a browser cannot read technocore.chat cross-origin, and " +
        "no archive is configured. See server/deploy/TUNNEL.md.",
      "warn",
    );
    return;
  }

  provenance.textContent = "loading the archive…";
  void loadCanvas(ARCHIVE_URL)
    .then(() => {
      say("");
      // Only after the snapshot: following from a sequence the canvas has not reached yet
      // would paint the newest pixels onto a canvas missing the older ones.
      follow(ROOM, roomHead, ARCHIVE_URL, {
        onPlacement: applyIncoming,
        onSeq: (seq) => {
          roomHead = Math.max(roomHead, seq);
        },
        onStatus: (live, detail) => {
          if (!live) say(`live updates paused — ${detail}`, "warn");
        },
      });
    })
    .catch((error: unknown) => {
      provenance.textContent = "the archive could not be read";
      say(
        `the canvas could not be loaded: ${error instanceof Error ? error.message : "unknown"}. ` +
          "Nothing is shown rather than an empty canvas that is not the real one.",
        "warn",
      );
    });

  void seedNonceFromRoom(panel.current.did);
}

/* ---- the ramp ---------------------------------------------------------------------- */

const ramp = need<HTMLElement>("#ramp");
const buttons: HTMLButtonElement[] = STEPS.map((step) => {
  const button = document.createElement("button");
  button.type = "button";
  button.role = "radio";
  button.style.background = PATINA[step]!;
  button.setAttribute("aria-label", `step ${pad2(step)}`);
  button.setAttribute("aria-checked", String(step === selectedStep));
  button.tabIndex = step === selectedStep ? 0 : -1;
  button.addEventListener("click", () => selectStep(step));
  ramp.append(button);
  return button;
});

function selectStep(step: number): void {
  selectedStep = step;
  buttons.forEach((button, i) => {
    const isSelected = STEPS[i] === step;
    button.setAttribute("aria-checked", String(isSelected));
    button.tabIndex = isSelected ? 0 : -1;
  });
}

ramp.addEventListener("keydown", (event) => {
  const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (delta === 0) return;
  event.preventDefault();
  const next = Math.min(15, Math.max(1, selectedStep + delta));
  selectStep(next);
  buttons[next - 1]?.focus();
});

need<HTMLButtonElement>("#reset").addEventListener("click", () => view.fit());
showPainted();
startLoading();

/* Measurement handle — `bench/run-matrix.mjs` reads paint work and the pick invariant off
   these, and there is no way to measure either from the outside. `__BENCH__` is defined by
   `build.mjs` and is a literal `false` in the shipped build, so esbuild removes this block
   rather than shipping a debug surface on `window`. */
declare const __BENCH__: boolean;
if (__BENCH__) {
  (globalThis as unknown as { __canvas: unknown }).__canvas = { view, scene, grid };
}
