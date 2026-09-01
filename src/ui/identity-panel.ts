/* The identity, and the warning that has to come before the first pixel.
 *
 * FR-2 asks for a key generated locally. That is easy and it is not the hard part. The hard
 * part is that a key held in one browser, with no account behind it, is one cleared cache
 * away from gone — and every pixel signed with it stays in the room forever, attributed to a
 * key nobody holds any more.
 *
 * So the warning is not a settings page and not a footnote. On the visit where the key is
 * created it blocks placement until it has been acknowledged. That is friction, deliberately,
 * once: the alternative is someone finding out by losing something.
 */

import type { Identity } from "../identity/key.ts";
import { clear, exportSeed, importSeed, isPersistent } from "../identity/store.ts";
import { copyText } from "./clipboard.ts";

const ACK_KEY = "signed-canvas.identity.acknowledged.v1";

export interface IdentityPanelEvents {
  /** A different key is now in use; the caller must re-read nonces and repaint attribution. */
  onIdentityChanged(identity: Identity): void;
  onNotice(message: string, tone: "info" | "warn"): void;
}

const short = (did: string): string => `${did.slice(0, 12)}…${did.slice(-4)}`;

function acknowledged(): boolean {
  try {
    return localStorage.getItem(ACK_KEY) === "1";
  } catch {
    return false;
  }
}

function acknowledge(): void {
  try {
    localStorage.setItem(ACK_KEY, "1");
  } catch {
    // If storage will not hold the acknowledgement it will not hold the key either, and the
    // banner below already says so. Blocking placement over it would be punishing the person
    // for their browser settings.
  }
}

export class IdentityPanel {
  private identity: Identity;
  private readonly events: IdentityPanelEvents;
  private readonly root: HTMLElement;
  private readonly gate: HTMLElement;
  private readonly didText: HTMLElement;

  constructor(
    root: HTMLElement,
    gate: HTMLElement,
    identity: Identity,
    freshlyCreated: boolean,
    events: IdentityPanelEvents,
  ) {
    this.root = root;
    this.gate = gate;
    this.identity = identity;
    this.events = events;
    this.didText = root.querySelector<HTMLElement>("[data-did]")!;

    this.render();
    this.bind();

    if (freshlyCreated || !acknowledged()) this.showGate();
    if (!isPersistent()) {
      this.events.onNotice(
        "this browser will not store the key — it is gone when the tab closes. Export it.",
        "warn",
      );
    }
  }

  /** Placement is blocked until the person has seen what holding a key means. */
  get ready(): boolean {
    return this.gate.hidden;
  }

  get current(): Identity {
    return this.identity;
  }

  private render(): void {
    this.didText.textContent = short(this.identity.did);
    this.didText.title = this.identity.did;
  }

  private showGate(): void {
    this.gate.hidden = false;
  }

  private bind(): void {
    this.gate.querySelector("[data-ack]")!.addEventListener("click", () => {
      acknowledge();
      this.gate.hidden = true;
    });

    this.gate.querySelector("[data-ack-export]")!.addEventListener("click", () => {
      this.copySeed();
      acknowledge();
      this.gate.hidden = true;
    });

    this.root.querySelector("[data-export]")!.addEventListener("click", () => this.copySeed());

    this.root.querySelector("[data-import]")!.addEventListener("click", () => {
      const hex = window.prompt(
        "Paste a 64-character seed. This replaces the key in this browser; the current one is " +
          "lost unless you exported it.",
      );
      if (hex === null) return;
      void importSeed(hex.trim())
        .then((identity) => {
          this.identity = identity;
          this.render();
          this.events.onIdentityChanged(identity);
          this.events.onNotice(`now signing as ${short(identity.did)}`, "info");
        })
        .catch((error: unknown) => {
          this.events.onNotice(
            `that seed was not usable: ${error instanceof Error ? error.message : "unknown"}`,
            "warn",
          );
        });
    });

    this.root.querySelector("[data-forget]")!.addEventListener("click", () => {
      const sure = window.confirm(
        "Forget this key? Pixels already placed with it stay in the room forever, attributed " +
          "to a key nobody will hold. This cannot be undone without the exported seed.",
      );
      if (!sure) return;
      clear();
      this.events.onNotice("key forgotten — reload to start a new identity", "warn");
    });
  }

  /* A refused copy must never look like a successful one. This is the only copy of an
     identity that will ever exist, and someone who believes they have it and does not will
     find out at the worst possible moment. */
  private copySeed(): void {
    const seed = exportSeed(this.identity);
    void copyText(seed, "Copy this seed and keep it safe:").then((result) => {
      if (result.kind === "copied") {
        this.events.onNotice("seed copied — store it somewhere you trust", "info");
      } else if (result.kind === "shown") {
        this.events.onNotice("clipboard refused — copy the seed from the dialog", "warn");
      } else {
        this.events.onNotice(`could not show the seed: ${result.reason}`, "warn");
      }
    });
  }
}
