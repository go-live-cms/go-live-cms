// Shared helpers for the collaboration tests (not used by app code).

// Block attrs are a per-type union, and most tests only care about the text attr, so
// read it without narrowing on the block type first.
export const textOf = (block: { attrs: object } | null | undefined): string | undefined =>
  (block?.attrs as { text?: string } | undefined)?.text

/**
 * jsdom has no layout: Range lacks getClientRects/getBoundingClientRect, which
 * ProseMirror's scrollIntoView calls when an editor focuses itself (mounting, a command's
 * `.focus()`). Call at module level in editor tests; it only fills in what's missing.
 */
export function stubJsdomRangeLayout(): void {
  const emptyRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) })
  Range.prototype.getClientRects ??= function () {
    return Object.assign([], { item: () => null }) as unknown as DOMRectList
  }
  Range.prototype.getBoundingClientRect ??= emptyRect as unknown as () => DOMRect
}
