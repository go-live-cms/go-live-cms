/**
 * Heading anchors and the table of contents (#351). Every heading of a published doc
 * gets an `id` made from its text, so `#how-it-works` links keep working, and themes
 * build "On this page" from the same list. Pure and deterministic: the same doc
 * always gives the same ids, on every render. Tested in headingAnchors.test.ts.
 */
import { createContext } from "react"
import type { Block, BlockDocV1 } from "@gl-admin/lib/blocks-spec"

// Block id → element id for the doc being rendered; BlockRenderer provides it and
// HeadingBlock reads it. Empty outside a BlockRenderer (no ids).
export const HeadingIdsContext = createContext<ReadonlyMap<string, string>>(new Map())

export interface HeadingAnchor {
  blockId: string
  // The element id, unique within the doc (and not one of the reserved ids).
  id: string
  level: number
  text: string
}

export interface TocEntry {
  id: string
  text: string
  // H3s under an H2 (always empty for an H3).
  children: TocEntry[]
}

// Used when a heading's text leaves nothing to slug (empty, or only punctuation).
export const EMPTY_HEADING_SLUG = "section"
// Long headings make unwieldy URLs; the slug keeps this many characters.
const MAX_SLUG_LENGTH = 80
// A table of contents with fewer entries than this isn't worth showing.
export const TOC_MIN_HEADINGS = 3

/**
 * A heading's text as a URL fragment: lower case, Latin accents dropped ("Café" →
 * "cafe"), every run of anything but letters and digits one "-". Other scripts keep
 * their letters ("日本語の見出し" stays as is) rather than collapsing to nothing.
 * Never empty.
 */
export function slugifyHeading(text: string): string {
  const slug = text
    // Split accented letters into letter + combining mark and drop the Latin, Greek and
    // Cyrillic combining marks only: other scripts' vowel signs are marks too and part of
    // the word. NFC then puts back what decomposition took apart (Hangul syllables).
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
  // Cut by code point so a character outside the BMP is never split.
  const cut = Array.from(slug).slice(0, MAX_SLUG_LENGTH).join("").replace(/-+$/, "")
  return cut || EMPTY_HEADING_SLUG
}

type TextNode = { type?: string; text?: string; content?: TextNode[] }

function nodeText(nodes: TextNode[] | undefined): string {
  return (nodes ?? [])
    .map((node) => (typeof node.text === "string" ? node.text : node.type === "hardBreak" ? " " : nodeText(node.content)))
    .join("")
}

// The heading's plain text, as the renderer shows it (ProseMirror content, else attrs.text).
export function headingText(block: Block): string {
  const attrs = (block.attrs ?? {}) as Record<string, unknown>
  const pm = attrs.pm as { content?: TextNode[] } | undefined
  const text = pm?.content ? nodeText(pm.content) : typeof attrs.text === "string" ? attrs.text : ""
  return text.replace(/\s+/g, " ").trim()
}

// The level a heading renders at: attrs.level as a whole number 1-6, else 1. HeadingBlock
// and the table of contents both read it here, so the outline matches the markup.
export function headingLevel(block: Block): number {
  const level = Number((block.attrs as Record<string, unknown> | undefined)?.level)
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level : 1
}

/**
 * Every heading of the doc in reading order with its id. Duplicates get "-2", "-3", …
 * in the order they appear (a later heading never renames an earlier one); `reserved`
 * holds ids the page already uses (e.g. the theme's `content`), which count as taken,
 * and patterns for numbered ones (e.g. `/^nav-sub-\d+$/`).
 */
export function headingAnchors(doc: BlockDocV1 | null | undefined, reserved: Iterable<string | RegExp> = []): HeadingAnchor[] {
  if (!doc?.blocks || !Array.isArray(doc.blocks_order)) return []
  const used = new Set<string>()
  const patterns: RegExp[] = []
  for (const r of reserved) typeof r === "string" ? used.add(r) : patterns.push(r)
  const reservedByPattern = (id: string) => patterns.some((p) => p.test(id))
  const taken = (id: string) => used.has(id) || reservedByPattern(id)
  // "nav-sub-2", "nav-sub-3", … all match /^nav-sub-\d+$/, so a numbered suffix that
  // hits a pattern becomes "-h2" instead (or the loop below would never end).
  const suffixed = (base: string, n: number) => (reservedByPattern(`${base}-${n}`) ? `${base}-h${n}` : `${base}-${n}`)
  const anchors: HeadingAnchor[] = []
  // The same order BlockRenderer renders: blocks_order, each id once.
  for (const blockId of new Set(doc.blocks_order)) {
    const block = doc.blocks[blockId] as Block | undefined
    if (!block || block.type !== "heading") continue
    const text = headingText(block)
    const base = slugifyHeading(text)
    let id = base
    for (let n = 2; taken(id); n++) id = suffixed(base, n)
    used.add(id)
    anchors.push({ blockId, id, level: headingLevel(block), text })
  }
  return anchors
}

/**
 * "On this page": the H2s, each with the H3s that follow it nested. An H3 before the
 * first H2 stands on its own. Other levels and headings without text are left out.
 * Empty when fewer than `minHeadings` entries remain, so a short post shows none.
 */
export function tableOfContents(anchors: HeadingAnchor[], minHeadings = TOC_MIN_HEADINGS): TocEntry[] {
  const entries: TocEntry[] = []
  let count = 0
  let parent: TocEntry | null = null
  for (const anchor of anchors) {
    if (!anchor.text || (anchor.level !== 2 && anchor.level !== 3)) continue
    const entry: TocEntry = { id: anchor.id, text: anchor.text, children: [] }
    count++
    if (anchor.level === 2) {
      entries.push(entry)
      parent = entry
    } else if (parent) {
      parent.children.push(entry)
    } else {
      entries.push(entry)
    }
  }
  return count >= minHeadings ? entries : []
}
