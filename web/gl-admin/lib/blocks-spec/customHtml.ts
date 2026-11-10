/**
 * The custom HTML block (#428, design: `docs/design/block-library.md` 5).
 *
 * **The markup is not in the Yjs doc.** The block holds a `snippetId`; the markup is a
 * `post_html_snippets` row written only through admin-only API routes, so no Yjs update
 * from anyone can create or change markup. Publish copies the sanitized markup into the
 * published document (`attrs.html`), which is what versions and the public page read: that
 * attr exists only there, and the bridge never carries it into the editor or back.
 *
 * Pure data: no ProseMirror or DOM, so the collab server reads it too.
 */

export const HTML_BLOCK_VERSION = 1

/** What the API's snippet ids look like (a lower-case UUID; `customhtml.ValidSnippetID`). */
const SNIPPET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isSnippetId(value: unknown): value is string {
  return typeof value === "string" && SNIPPET_ID_PATTERN.test(value)
}

/** A valid snippet id, or null. Everything that reads one from a doc goes through this. */
export function normalizeSnippetId(value: unknown): string | null {
  return isSnippetId(value) ? value : null
}

/** The locked preview's line (the canvas's "as an editor or contributor sees it"). */
export const HTML_LOCKED_NOTE = "Only admins can edit this block"
