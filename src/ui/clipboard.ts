/* Copying text, and saying what actually happened.
 *
 * `navigator.clipboard.writeText` refuses more often than it looks: an insecure context, a
 * denied permission, an embedded view, a browser that requires the page to be focused. The
 * first version of this code chained a `.catch` onto a `window.prompt` and reported nothing
 * either way, so a refused copy was silent — and the two things being copied here are an
 * identity seed and a proof, which are exactly the two things a person must not believe they
 * have when they do not.
 *
 * So the outcome is returned, always, and the caller says it out loud.
 */

export type CopyResult =
  /** In the clipboard. */
  | { readonly kind: "copied" }
  /** Not in the clipboard; shown in a dialog for the person to copy by hand. */
  | { readonly kind: "shown" }
  /** Neither worked. The text is lost unless the caller renders it another way. */
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Put `text` on the clipboard, falling back to a dialog.
 *
 * Never throws: a copy that did not happen is an outcome the interface has to report, not an
 * exception to swallow.
 */
export async function copyText(text: string, prompt: string): Promise<CopyResult> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return { kind: "copied" };
    }
  } catch {
    // Fall through to the dialog: a refusal here is ordinary, not exceptional.
  }
  try {
    window.prompt(prompt, text);
    return { kind: "shown" };
  } catch (error) {
    return {
      kind: "failed",
      reason: error instanceof Error ? error.message : "the browser refused both",
    };
  }
}
