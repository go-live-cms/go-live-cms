// Footnotes (#422, design `docs/design/block-library.md` 2.2, 2.9, 4). Three pieces:
//
// - `footnoteRef`: an inline atom in a text block's `pm`, `{footnoteId}`. Holds nothing else.
// - `footnotes`: the post's one list of notes (a container, `nesting.ts`), at the top level,
//   after every other block.
// - `footnote`: one note, a child of the list, rich inline text. **Its block id is the
//   `footnoteId` its references carry**, so a note and its references are joined by an id
//   every copy path already keeps straight.
//
// **Numbers are never stored.** A note's number is the order of the first reference to it
// (`footnoteIndex` here for the public page, `footnoteUses` in the editor's decorations), so
// two people adding references at once can't disagree about one and nothing rewrites the
// doc to renumber it (rule 7 in `collaboration/CLAUDE.md`).
//
// **"One list, last" can't be in the ProseMirror schema.** y-tiptap's `_forceRerender` fits
// the fragment into the doc, so a second list (two people adding the first footnote at once)
// would be dropped for every peer. The schema allows any number anywhere; `nestingIssues` and
// the API refuse them in a stored doc, the commands keep the rule locally, and the collab
// server's store merges and moves them first (`repairFootnotesFragment`).
//
// Pure data and functions: the collab server, the editor and the public renderer share them.

import type { DocLike } from "./nesting"

export const FOOTNOTE_REF_NODE = "footnoteRef"
export const FOOTNOTE_NODE = "footnote"
export const FOOTNOTES_NODE = "footnotes"

/** The Block Spec types. */
export const FOOTNOTE_TYPE = "footnote"
export const FOOTNOTES_TYPE = "footnotes"

/** What a note may hold: text and the inline nodes, never a reference (a note can't cite a note). */
export const FOOTNOTE_CONTENT = "(text | hardBreak | mention | contentLink | dateChip)*"

const FOOTNOTE_ID = /^[A-Za-z0-9_-]{10,128}$/

/** A reference's target as stored: a block id (10–128 letters, digits, `-`, `_`), else null. */
export function normalizeFootnoteId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const id = value.trim()
  return FOOTNOTE_ID.test(id) ? id : null
}

/** A `footnoteRef` node's attrs as stored, or null when it has no valid target. */
export function footnoteRefAttrs(attrs: Record<string, unknown> | null | undefined): { footnoteId: string } | null {
  const footnoteId = normalizeFootnoteId(attrs?.footnoteId)
  return footnoteId === null ? null : { footnoteId }
}

interface PMJson {
  type?: unknown
  attrs?: Record<string, unknown>
  content?: unknown
  text?: unknown
}

type AnyBlock = { id?: string; type?: unknown; attrs?: Record<string, unknown>; children?: unknown }

/** Every `footnoteRef` under `pm` (a block's stored ProseMirror JSON), in document order. */
export function walkFootnoteRefs(pm: unknown, visit: (node: PMJson) => void): void {
  const node = pm as PMJson | null | undefined
  if (!node || typeof node !== "object") return
  if (node.type === FOOTNOTE_REF_NODE) {
    visit(node)
    return
  }
  if (Array.isArray(node.content)) node.content.forEach((child) => walkFootnoteRefs(child, visit))
}

/** A note that shows nothing: no content, or only whitespace. */
function isBlankNote(block: AnyBlock): boolean {
  const pm = block.attrs?.pm as PMJson | undefined
  if (pm && Array.isArray(pm.content)) {
    return pm.content.every((node: PMJson) => node?.type === "text" && !String(node.text ?? "").trim())
  }
  return !String(block.attrs?.text ?? "").trim()
}

/** One reference as the page shows it: its note's number, and which use of that note it is (1 = the first). */
export interface FootnoteRefUse {
  id: string
  number: number
  occurrence: number | null
}

/** A note the page lists: its block, its number and how many references point at it. */
export interface FootnoteEntry {
  id: string
  number: number
  uses: number
  block: AnyBlock
}

export interface FootnoteIndex {
  /** The notes to list, in number order. A note nothing refers to, or with no text, isn't here. */
  notes: readonly FootnoteEntry[]
  /** The reference `node` (by identity, its stored JSON), or null when it has nothing to point at. */
  useOf(node: unknown): FootnoteRefUse | null
}

export const EMPTY_FOOTNOTE_INDEX: FootnoteIndex = { notes: [], useOf: () => null }

/** The list a doc shows: the one in `blocks_order`. */
function footnotesListOf(doc: DocLike): AnyBlock | null {
  const blocks = (doc.blocks ?? {}) as Record<string, AnyBlock>
  const order = Array.isArray(doc.blocks_order) ? (doc.blocks_order as string[]) : []
  for (const id of order) {
    const block = Object.prototype.hasOwnProperty.call(blocks, id) ? blocks[id] : undefined
    if (block?.type === FOOTNOTES_TYPE) return block
  }
  return null
}

/**
 * What the public page renders (#422): numbers from the order of the references, in reading
 * order at any depth (list items, table cells and containers included).
 *
 * The awkward states all land here, and none can produce a broken link:
 * - a **reference with no note** (the note was deleted, or the id is stale) renders nothing;
 * - a **note with no reference** isn't listed: it has no number and no place in the text
 *   (the editor shows it as unreferenced, with Remove);
 * - a **note with no text** is left out with its references (a "1." with nothing after it
 *   helps no reader);
 * - **two references to one note** (a duplicated block, a pasted copy) share its number, and
 *   the note gets a back link for each.
 *
 * Pure: `useOf` answers by the node object, so rendering in any order, or twice, gives the
 * same anchors.
 */
export function footnoteIndex(doc: DocLike | null | undefined): FootnoteIndex {
  if (!doc?.blocks) return EMPTY_FOOTNOTE_INDEX
  const list = footnotesListOf(doc)
  if (!list || !Array.isArray(list.children)) return EMPTY_FOOTNOTE_INDEX
  const blocks = doc.blocks as Record<string, AnyBlock>
  const has = (id: string) => Object.prototype.hasOwnProperty.call(blocks, id)
  const listed = new Map<string, AnyBlock>()
  for (const id of list.children as string[]) {
    if (typeof id === "string" && has(id) && blocks[id]?.type === FOOTNOTE_TYPE && !isBlankNote(blocks[id])) listed.set(id, blocks[id])
  }
  if (listed.size === 0) return EMPTY_FOOTNOTE_INDEX

  const numbers = new Map<string, FootnoteEntry>()
  const uses = new WeakMap<object, FootnoteRefUse>()
  const seen = new Set<string>()
  const visitBlock = (id: unknown) => {
    if (typeof id !== "string" || seen.has(id) || !has(id)) return
    seen.add(id)
    const block = blocks[id]
    if (!block || typeof block !== "object" || block.type === FOOTNOTES_TYPE) return
    walkFootnoteRefs(block.attrs?.pm, (node) => {
      const target = normalizeFootnoteId(node.attrs?.footnoteId)
      const note = target === null ? undefined : listed.get(target)
      if (target === null || !note) return
      let entry = numbers.get(target)
      if (!entry) {
        entry = { id: target, number: numbers.size + 1, uses: 0, block: note }
        numbers.set(target, entry)
      }
      entry.uses += 1
      uses.set(node, { id: target, number: entry.number, occurrence: entry.uses })
    })
    if (Array.isArray(block.children)) block.children.forEach(visitBlock)
  }
  ;(doc.blocks_order as unknown[]).forEach(visitBlock)
  if (numbers.size === 0) return EMPTY_FOOTNOTE_INDEX

  return {
    notes: [...numbers.values()],
    useOf(node) {
      if (!node || typeof node !== "object") return null
      const use = uses.get(node)
      if (use) return use
      // Not the node the index saw (a renderer that copied it): the number still holds, but
      // not which use it is, so it gets no anchor of its own.
      const target = normalizeFootnoteId((node as PMJson).attrs?.footnoteId)
      const entry = target === null ? undefined : numbers.get(target)
      return entry ? { id: entry.id, number: entry.number, occurrence: null } : null
    },
  }
}

/** The element id of note `number`. */
export const footnoteAnchorId = (number: number): string => `fn-${number}`

/** The element id of a reference: `ref-1`, and for a note's later uses `ref-1-2`, `ref-1-3`. */
export const footnoteRefAnchorId = (number: number, occurrence: number): string => (occurrence > 1 ? `ref-${number}-${occurrence}` : `ref-${number}`)

/** The `h2` that labels the section. */
export const FOOTNOTES_TITLE_ID = "fn-title"

/**
 * `order` with a footnotes list moved to the end, for anything that adds to the top level
 * after the list (a hidden block going back, #213: "at the end if its anchor is gone").
 * Returns `order` itself when nothing moves.
 */
export function withFootnotesLast(order: string[], blocks: Record<string, { type?: unknown } | undefined>): string[] {
  const lists = order.filter((id) => blocks[id]?.type === FOOTNOTES_TYPE)
  if (lists.length === 0 || (lists.length === 1 && order[order.length - 1] === lists[0])) return order
  return [...order.filter((id) => blocks[id]?.type !== FOOTNOTES_TYPE), ...lists]
}
