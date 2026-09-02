/* Wiring only. Everything with a decision in it lives in src/canvas, src/crypto, src/identity
 * and src/net.
 *
 * The order matters and is the product's whole claim: paint optimistically so the canvas
 * feels immediate, then write, then reconcile. A pixel the room refused must not stay on
 * screen looking placed — the canvas is supposed to show what is in the room, and a hopeful
 * pixel is a small lie about exactly the thing this product sells. */

import { Grid } from "./canvas/grid.ts";
import { FlatScene } from "./canvas/flat.ts";
import { View } from "./canvas/view.ts";
import { EMPTY, PALETTE, RAMP_END, STEPS } from "./canvas/palette.ts";
import { COLS, ROWS } from "./canvas/projection.ts";
import { formatPlacement, parsePlacement } from "./canvas/wire.ts";
import { ARCHIVE_URL, ROOM, hasArchive, relayUrl } from "./config.ts";
import { loadOrCreate } from "./identity/store.ts";
import { IdentityPanel } from "./ui/identity-panel.ts";
import { NonceCounter } from "./net/nonce.ts";
import { lastNonce, place, token } from "./net/room.ts";
import { since, snapshot } from "./net/archive.ts";
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
/* Straight on by default. The axonometric renderer in `canvas/scene.ts` still exists and the
   tower data still feeds it — elevation is the only thing that shows a cell was fought over —
   but a rhombus is the wrong grid to draw a flag on, and drawing things together is what this
   canvas is for. */
const scene = new FlatScene(grid);
const canvas = need<HTMLCanvasElement>("#canvas");
// The floating panels are absolutely positioned inside the board, so the board is what
// their coordinates are relative to — not the stage, which now also holds the feed.
const stage = need<HTMLElement>(".board");
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
// `#live-feed`, not `#feed`: the latter is four hex digits, so every stylesheet
// auditor reads it as a raw colour literal in the bundle. An id that looks like a
// colour will keep tripping every such check, so it is not one.
const feed = need<HTMLElement>("#live-feed");
const feedEmpty = need<HTMLElement>("#live-empty");

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

const cooldownBox = need<HTMLElement>("#cooldown");
const cooldownText = need<HTMLElement>("#cooldown-text");
const cooldownBar = need<HTMLElement>("#cooldown-bar");
const nudge = need<HTMLElement>("#nudge");
const nudgeSeconds = need<HTMLElement>("#nudge-seconds");
const nudgeWhat = need<HTMLElement>("#nudge-what");
const nudgeBar = need<HTMLElement>("#nudge-bar");

/**
 * Paint the wait, wherever it is shown, from the clock rather than from a schedule.
 *
 * Driven by frames and recomputed from `Date.now()` every one of them. The first version
 * stepped a `setInterval` and handed the bar a ten-second CSS transition, and both drift the
 * moment the tab stops being the front one: browsers clamp background timers and a transition
 * that was started before the tab was hidden finishes while nobody is watching. Coming back
 * to a counter that had stopped is worse than no counter, because it is still a number and
 * still looks like an answer.
 *
 * Frames stop too when the tab is hidden — but they stop *and resume*, and the value is
 * derived, so the first frame back is correct rather than stale.
 */
function paintWait(): void {
  const left = readyToPlaceAt - Date.now();
  if (left <= 0) {
    cooldownBox.hidden = true;
    if (nudge.dataset["reason"] === "cooldown") nudge.hidden = true;
    return;
  }
  const seconds = String(Math.ceil(left / 1000));
  const fraction = Math.max(0, Math.min(1, left / PLACE_COOLDOWN_MS));

  cooldownBox.hidden = false;
  cooldownText.textContent = `next pixel in ${seconds}s`;
  cooldownBar.style.transform = `scaleX(${fraction})`;

  if (!nudge.hidden && nudge.dataset["reason"] === "cooldown") {
    nudgeSeconds.textContent = seconds;
    nudgeBar.style.transform = `scaleX(${fraction})`;
  }
  requestAnimationFrame(paintWait);
}

// A tab that comes back mid-wait has had no frames, so nothing has repainted. Ask for one.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && readyToPlaceAt > Date.now()) paintWait();
});

/**
 * Say why a click did nothing, at the click.
 *
 * The status line said it once, in the corner of the eye — which is not where someone is
 * looking a moment after clicking a cell.
 */
function showNudge(
  clientX: number,
  clientY: number,
  reason: "cooldown" | "inflight" | "same",
): void {
  const box = stage.getBoundingClientRect();
  nudge.style.left = `${clientX - box.left}px`;
  nudge.style.top = `${clientY - box.top}px`;
  nudge.dataset["reason"] = reason;
  nudge.hidden = false;

  if (reason !== "cooldown") {
    nudgeSeconds.textContent = reason === "same" ? "=" : "…";
    nudgeWhat.textContent =
      reason === "same"
        ? "already this colour"
        : "the last pixel is still being written";
    nudgeBar.style.transform = "scaleX(1)";
    window.setTimeout(() => {
      if (nudge.dataset["reason"] === reason) nudge.hidden = true;
    }, 1800);
    return;
  }
  nudgeWhat.textContent = "before the next pixel";
  paintWait();
}

function say(message: string, tone: "info" | "ok" | "warn" = "info"): void {
  statusLine.textContent = message;
  statusLine.dataset["tone"] = tone;
}

function showPainted(): void {
  paintedText.textContent = `${grid.painted()} / ${COLS * ROWS}`;
}

function showCell(cell: number | null): void {
  if (cell === null) {
    cellText.textContent = "—";
    stepText.textContent = "—";
    contestText.textContent = "—";
    return;
  }
  const state = grid.get(cell % COLS, Math.floor(cell / COLS));
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


/* ---- what is under the pointer, at the pointer ------------------------------------- */

const canvasHelp = need<HTMLElement>("#canvas-help");
const tip = need<HTMLElement>("#tip");
const tipCell = need<HTMLElement>("#tip-cell");
const tipStep = need<HTMLElement>("#tip-step");
const tipContest = need<HTMLElement>("#tip-contest");
const tipOwner = need<HTMLElement>("#tip-owner");
const tipBasis = need<HTMLElement>("#tip-basis");

/** Where the pointer last was, in client coordinates. Both floating panels are placed by it. */
const lastPointer = { x: 0, y: 0 };

const TIP_OFFSET = 18;

/** Put the tooltip beside the pointer, flipped near an edge so it never leaves the stage. */
function positionTip(clientX: number, clientY: number): void {
  const box = stage.getBoundingClientRect();
  const size = tip.getBoundingClientRect();
  let x = clientX - box.left + TIP_OFFSET;
  let y = clientY - box.top + TIP_OFFSET;
  if (x + size.width > box.width - 4) x = clientX - box.left - size.width - TIP_OFFSET;
  if (y + size.height > box.height - 4) y = clientY - box.top - size.height - TIP_OFFSET;
  tip.style.left = `${Math.max(4, x)}px`;
  tip.style.top = `${Math.max(4, y)}px`;
}

/** Fill the tooltip for a cell, or hide it when there is nothing under the pointer. */
function showTip(cell: number | null): void {
  if (cell === null || grid.step[cell] === EMPTY) {
    tip.hidden = true;
    return;
  }
  const state = grid.get(cell % COLS, Math.floor(cell / COLS));
  if (!state) return;
  tip.hidden = false;
  tipCell.textContent = `${pad2(state.cx)}, ${pad2(state.cy)}`;
  tipStep.textContent = pad2(state.step);
  tipContest.textContent = state.contest === 0 ? "never" : `${state.contest}×`;

  // Ownership is fetched per cell and cached, so it is here immediately for a cell already
  // looked at and a moment later for one that is not. Saying "reading…" rather than "—"
  // distinguishes "we do not know yet" from "nobody".
  const known = owners.get(cell);
  if (known === undefined) {
    tipOwner.textContent = "reading…";
    tipBasis.textContent = "—";
    delete tipBasis.dataset["basis"];
    return;
  }
  if (known === null) {
    tipOwner.textContent = "unclaimed";
    tipBasis.textContent = "—";
    delete tipBasis.dataset["basis"];
    return;
  }
  tipOwner.textContent = `${known.did.slice(8, 20)}…`;
  tipBasis.textContent = known.witnessed ? "witnessed" : "attested";
  tipBasis.dataset["basis"] = known.witnessed ? "witnessed" : "attested";
}

/**
 * Say where the cursor is, for a reader that cannot see the crosshair.
 *
 * Announced on the cell rather than on every pointer pixel: this is an `aria-live` region and
 * a mouse crossing the canvas would otherwise narrate a hundred cells nobody asked about. The
 * pointer moves within a cell without changing it, so this only speaks when the cell does.
 */
function announceCursor(cell: number | null): void {
  if (cell === null) {
    canvasHelp.textContent = "";
    return;
  }
  const cx = cell % COLS;
  const cy = Math.floor(cell / COLS);
  const step = grid.step[cell] ?? EMPTY;
  canvasHelp.textContent =
    step === EMPTY
      ? `${cx}, ${cy}. Empty.`
      : `${cx}, ${cy}. Colour ${step}, contested ${grid.contest[cell] ?? 0} times.`;
}

canvas.addEventListener("pointermove", (event) => {
  lastPointer.x = event.clientX;
  lastPointer.y = event.clientY;
  if (!tip.hidden) positionTip(event.clientX, event.clientY);
});

canvas.addEventListener("pointerleave", () => {
  tip.hidden = true;
});

/* ---- who owns a cell, and on what basis ------------------------------------------- */

/* Ownership needs the DID, and the snapshot carries only colours — 2,048 bytes of palette
   indices cannot hold 4,096 DIDs. So it is fetched per cell, debounced, and cached: hovering
   across the canvas must not become one request per pixel crossed. */
const HOVER_SETTLE_MS = 280;
const owners = new Map<number, Placement | null>();
let hoverTimer: number | undefined;
let inspecting: { cell: number; top: Placement } | null = null;

function clearOwner(message: string): void {
  showCell(null);
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
  // Every field in the row describes this one cell, including the ones the pointer used to
  // drive.
  showCell(cell);
  ownerText.textContent = describeOwner(top).split(" · ")[0] ?? "—";
  basisText.textContent = top.witnessed ? "witnessed" : "attested";
  basisText.dataset["basis"] = top.witnessed ? "witnessed" : "attested";
  proofButton.disabled = false;
  // Name the cell the export is for. The inspection is pinned rather than following the
  // pointer, so without this the button would be about an unstated cell.
  proofHint.textContent =
    `for ${pad2(cell % COLS)},${pad2(Math.floor(cell / COLS))} · ` +
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
    const cx = cell % COLS;
    const cy = Math.floor(cell / COLS);
    void cellHistory(ARCHIVE_URL, cx, cy)
      .then((record) => {
        const top = record.placements.at(-1) ?? null;
        owners.set(cell, top);
        // The pointer may have moved on while this was in flight; only paint if it did not.
        if (view.hoveredCell === cell) {
          showOwner(cell, top);
          // The tooltip said "reading…" while this was in flight. It is not reading now.
          showTip(cell);
        }
      })
      .catch(() => {
        proofHint.textContent = "the record could not be read";
      });
  }, HOVER_SETTLE_MS);
}

proofButton.addEventListener("click", () => {
  if (inspecting === null) return;
  const { cell, top } = inspecting;
  const text = exportProof(cell % COLS, Math.floor(cell / COLS), top);
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
  onHover(cell, source) {
    announceCursor(cell);
    // The footer row is deliberately not updated here. It follows the *pinned* inspection,
    // and the tooltip follows the pointer — mixing them put the hovered cell's number beside
    // the pinned cell's owner, so the row read "cell 45,24 · step empty · owner …" about two
    // different cells at once.
    inspectCell(cell);
    showTip(cell);
    if (cell !== null) {
      // A keyboard cursor is nowhere near the mouse. Placing the tooltip by the pointer
      // would put it wherever the mouse happened to be left, which for someone who never
      // touched the mouse is the top-left corner.
      const at = source === "keyboard" ? view.cellToClient(cell) : lastPointer;
      positionTip(at.x, at.y);
    }
  },
  onActivate(cell) {
    void placePixel(cell % COLS, Math.floor(cell / COLS));
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
    showNudge(lastPointer.x, lastPointer.y, "inflight");
    return;
  }
  if (readyToPlaceAt > Date.now()) {
    showNudge(lastPointer.x, lastPointer.y, "cooldown");
    return;
  }

  const relay = relayUrl();
  const index = cy * COLS + cx;
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
  if (!grid.place(cx, cy, selectedStep)) {
    // The cell already holds this colour, so the write would be a no-op — and the room's
    // duplicate filter would likely refuse it anyway. Silence here was its own small bug:
    // a click that does nothing and says nothing is indistinguishable from one that broke.
    showNudge(lastPointer.x, lastPointer.y, "same");
    return;
  }

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
    paintWait();
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

  /* Seed the feed from what already happened. An empty panel on a fresh load is the same
     "nothing is here" the layout was rearranged to avoid, and the archive holds the answer —
     the feed used to start empty only because the client discarded the fields it needed. */
  void since(base, Math.max(0, state.seq - FEED_MAX))
    .then((delta) => {
      for (const record of delta.placements) {
        addToFeed({
          seq: record.seq,
          ts: record.ts,
          did: record.did,
          cx: record.cx,
          cy: record.cy,
          step: record.step,
          // From the archive, which states its own verdict rather than handing over the
          // bytes. The tick means "checked in this browser", so these do not get one.
          verified: false,
        });
      }
    })
    .catch(() => {
      // A feed that failed to seed is a quiet loss, not a broken canvas.
    });

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
    owners.delete(cy * COLS + cx);
    if (view.hoveredCell === cy * COLS + cx) {
      showCell(cy * COLS + cx);
      inspectCell(cy * COLS + cx);
    }
  }
  showLatest(placement);
  addToFeed(placement);
}

/* The feed: what is happening, as it happens.
 *
 * r/place was not compelling because of the picture — it was compelling because you could
 * watch it being fought over. We already receive every placement live and verify it here;
 * until now none of that reached the screen except as one line in the header.
 *
 * Bounded, because it runs forever. Old entries are removed rather than left to grow a list
 * nobody scrolls to the bottom of on a page that may be open for hours. */
const FEED_MAX = 40;

function addToFeed(placement: LivePlacement): void {
  feedEmpty.hidden = true;
  const row = document.createElement("li");
  row.tabIndex = 0;
  row.title = placement.did === "" ? "" : placement.did;

  const chip = document.createElement("span");
  chip.className = "feed__chip";
  chip.style.background = PALETTE[placement.step] ?? "";
  const at = document.createElement("span");
  at.className = "feed__at";
  at.textContent = `${pad2(placement.cx)},${pad2(placement.cy)}`;
  const who = document.createElement("span");
  who.className = "feed__who";
  who.textContent =
    placement.did === "" ? "via the archive" : `${placement.did.slice(8, 20)}…`;
  row.append(chip, at, who);

  if (placement.verified) {
    const ok = document.createElement("span");
    ok.className = "feed__ok";
    // The tick is the claim, so it is only drawn when this browser did the checking.
    ok.textContent = "✓";
    ok.title = "signature verified in this browser";
    row.append(ok);
  }

  const jump = (): void => {
    view.centreOn(placement.cy * COLS + placement.cx);
  };
  row.addEventListener("click", jump);
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      jump();
    }
  });

  feed.prepend(row);
  while (feed.childElementCount > FEED_MAX) feed.lastElementChild?.remove();
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
          // Clearing on recovery matters as much as saying it: the old version only ever
          // wrote the warning, so a single blip left "live updates paused" on screen for the
          // rest of the session while updates were in fact arriving.
          say(live ? "" : `live updates paused — ${detail}`, live ? "info" : "warn");
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
const hues = need<HTMLElement>("#hues");
const buttons: HTMLButtonElement[] = STEPS.map((step) => {
  const button = document.createElement("button");
  button.type = "button";
  button.role = "radio";
  button.style.background = PALETTE[step]!;
  button.setAttribute("aria-label", `step ${pad2(step)}`);
  button.setAttribute("aria-checked", String(step === selectedStep));
  button.tabIndex = step === selectedStep ? 0 : -1;
  button.addEventListener("click", () => selectStep(step));
  // The ramp and the hues are separate groups, not one long strip that happens to wrap:
  // thirty-five swatches in a row is wider than the viewport, and a break that lands
  // wherever the width puts it would split the ramp mid-walk.
  (step <= RAMP_END ? ramp : hues).append(button);
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
  // `cols`/`rows` travel with it: the benchmark used to restate the geometry and its copy
  // kept describing a projection the product had stopped using.
  (globalThis as unknown as { __canvas: unknown }).__canvas = {
    view,
    scene,
    grid,
    cols: COLS,
    rows: ROWS,
  };
}
