// Shared helpers for the collaboration tests (not used by app code).

// Block attrs are a per-type union, and most tests only care about the text attr, so
// read it without narrowing on the block type first.
export const textOf = (block: { attrs: object } | null | undefined): string | undefined =>
  (block?.attrs as { text?: string } | undefined)?.text
