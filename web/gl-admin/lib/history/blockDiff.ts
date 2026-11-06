// Block diff for History's "Highlight changes" (#355): a published version's Block Spec
// doc compared with the working copy's, in the client (no server endpoint). Pure, with
// type-only imports, so the worker (blockDiff.worker.ts) bundles nothing else.
//
// Blocks are matched by block id first. Blocks in both are "moved" when they aren't in the
// longest run of blocks that kept their relative order (an LIS over the working copy's
// positions), so moving one block marks that block, not every block it jumped over. Text
// inside matched blocks is diffed word by word (wordDiff.ts); attributes (heading level,
// image width/caption, a quote's citation, a theme block's declared attrs, ...) are
// compared on their own, so an attribute-only change still shows. List items, nested
// lists included, are matched by their own ids the same way, and so are a container's
// children (#414), at any depth.
//
// The result holds ids, not blocks: the renderer reads the blocks from the docs it already
// has, so the worker sends back little.

import type { Block, BlockDocV1 } from "../blocks-spec"
// The nesting table only: pure, no imports of its own, so the worker stays small.
import { isContainerType } from "../blocks-spec/nesting"
import {
  contentTokens,
  diffTokens,
  hasChanges,
  stableJson,
  tokenize,
  type PMJson,
  type Segment,
  type Token,
} from "./wordDiff"

/**
 * "same": in both, nothing changed (it may still have moved); "changed": in both, its text
 * or attributes differ; "version": only in the version shown; "working": only in the
 * working copy.
 */
export type DiffStatus = "same" | "changed" | "version" | "working"

/** One attribute that differs, as display strings (null: not set). */
export interface AttrChange {
  key: string
  label: string
  version: string | null
  working: string | null
}

export interface ItemDiff {
  /** The list item's block id (null when it has none). */
  id: string | null
  status: DiffStatus
  moved: boolean
  /** The item's own text (its nested lists are in `lists`). */
  text: Segment[]
  lists: ListDiff[]
}

export interface ListDiff {
  /** The version's list type (the working copy's, for a list only there). */
  ordered: boolean
  status: DiffStatus
  attrs: AttrChange[]
  items: ItemDiff[]
}

export interface BlockDiffEntry {
  id: string
  status: DiffStatus
  /** In both documents, at a different place relative to the other blocks. */
  moved: boolean
  /** "changed": the word diff of the block's text (absent for blocks without text). */
  text?: Segment[]
  /** "changed" image: the caption's word diff. */
  caption?: Segment[]
  /** "changed" list: its items. */
  list?: ListDiff
  /** A container in both (#414): its children, matched by id like the top level. */
  children?: BlockDiffEntry[]
  attrs: AttrChange[]
}

export interface DiffSummary {
  changed: number
  versionOnly: number
  workingOnly: number
  moved: number
  same: number
}

export interface BlockDocDiff {
  /** Version blocks in the version's order, working-copy-only blocks after the block they follow there. */
  entries: BlockDiffEntry[]
  summary: DiffSummary
}

type Doc = Pick<BlockDocV1, "blocks_order" | "blocks">

// ---------------------------------------------------------------------------------------
// Ordering

interface Aligned<T> {
  key: string
  version?: T
  working?: T
  moved: boolean
}

/**
 * Aligns two sequences by key. Version items keep their order; an item only in the working
 * copy goes after the nearest item before it there that the version also has (or first),
 * behind the version's own items at that place. Keys must be unique on each side.
 */
export function align<T>(version: T[], working: T[], keyOf: (item: T) => string): Aligned<T>[] {
  const wIndex = new Map<string, number>()
  working.forEach((item, i) => wIndex.set(keyOf(item), i))
  const vKeys = new Set(version.map(keyOf))

  // The common items, in version order, as positions in the working copy; those outside
  // the longest increasing run moved.
  const common: number[] = []
  const commonKeys: string[] = []
  for (const item of version) {
    const key = keyOf(item)
    const wi = wIndex.get(key)
    if (wi !== undefined) {
      common.push(wi)
      commonKeys.push(key)
    }
  }
  const stable = new Set(longestIncreasing(common).map((i) => commonKeys[i]))

  // Working-only items grouped by the item they follow ("" = at the start).
  const after = new Map<string, T[]>()
  let anchor = ""
  for (const item of working) {
    const key = keyOf(item)
    if (vKeys.has(key)) {
      anchor = key
      continue
    }
    const group = after.get(anchor)
    if (group) group.push(item)
    else after.set(anchor, [item])
  }

  // A group goes in just before the next item both sides have, so at one place the
  // version's own items come first, then the working copy's (as a diff reads: what this
  // version has, then what it doesn't).
  const out: Aligned<T>[] = []
  let pending = ""
  const flush = () => {
    for (const item of after.get(pending) ?? []) out.push({ key: keyOf(item), working: item, moved: false })
  }
  for (const item of version) {
    const key = keyOf(item)
    const wi = wIndex.get(key)
    if (wi === undefined) {
      out.push({ key, version: item, moved: false })
      continue
    }
    flush()
    out.push({ key, version: item, working: working[wi], moved: !stable.has(key) })
    pending = key
  }
  flush()
  return out
}

/** Indices (into `seq`) of one longest strictly increasing subsequence, O(n log n). */
export function longestIncreasing(seq: number[]): number[] {
  const tails: number[] = [] // index into seq of the smallest tail of each length
  const prev = new Array<number>(seq.length).fill(-1)
  for (let i = 0; i < seq.length; i++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (seq[tails[mid]] < seq[i]) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[i] = tails[lo - 1]
    tails[lo] = i
  }
  const out: number[] = []
  for (let i = tails.length > 0 ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.push(i)
  return out.reverse()
}

/** Unique keys: a repeated id (a malformed doc) gets a suffix instead of collapsing two items. */
function uniqueKeys(ids: (string | null)[]): string[] {
  const seen = new Map<string, number>()
  return ids.map((id, i) => {
    const base = id ?? `#${i}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n === 0 ? base : `${base}#${n}`
  })
}

// ---------------------------------------------------------------------------------------
// Block text and attributes

const pmOf = (block: Block): PMJson | undefined => (block.attrs as { pm?: PMJson } | undefined)?.pm
const attrsOf = (block: Block): Record<string, unknown> => (block.attrs ?? {}) as Record<string, unknown>

/** A block's text as tokens: its stored ProseMirror content, else its plain `text`. */
function blockTokens(block: Block): Token[] {
  if (block.type === "code_block") return tokenize(String(attrsOf(block).code ?? ""))
  const pm = pmOf(block)
  if (pm && Array.isArray(pm.content)) return contentTokens(pm.content)
  const text = attrsOf(block).text
  return typeof text === "string" ? tokenize(text) : []
}

function captionTokens(block: Block): Token[] {
  const caption = attrsOf(block).caption
  return Array.isArray(caption) ? contentTokens(caption as PMJson[]) : []
}

const TYPE_LABELS: Record<string, string> = {
  paragraph: "Paragraph",
  heading: "Heading",
  blockquote: "Quote",
  code_block: "Code",
  divider: "Divider",
  image: "Image",
  bullet_list: "Bulleted list",
  ordered_list: "Numbered list",
  list_item: "List item",
  group: "Group",
}

/** "Heading", "Bulleted list", or a theme block's name ("theme:example/alert" → "Alert"). */
export function blockTypeLabel(type: string): string {
  if (TYPE_LABELS[type]) return TYPE_LABELS[type]
  const name = type.includes("/") ? type.slice(type.lastIndexOf("/") + 1) : type.replace(/^theme:/, "")
  const words = name.replace(/[-_]+/g, " ").trim()
  return words ? words[0].toUpperCase() + words.slice(1) : type
}

const ALIGN_LABELS: Record<string, string> = { left: "Left", center: "Center", right: "Right", justify: "Justify" }
const WIDTH_LABELS: Record<string, string> = { inline: "Inline", wide: "Wide", full: "Full width" }
const GROUP_WIDTH_LABELS: Record<string, string> = { content: "Content", wide: "Wide", full: "Full width" }
const GROUP_STYLE_LABELS: Record<string, string> = { none: "None", tinted: "Tinted" }

function display(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return stableJson(value)
}

function fileName(src: unknown): string | null {
  if (typeof src !== "string" || src === "") return null
  const path = src.split(/[?#]/)[0]
  const name = path.slice(path.lastIndexOf("/") + 1)
  try {
    return decodeURIComponent(name) || src
  } catch {
    // A stray "%" (not an escape): the name as stored, never a failed comparison.
    return name || src
  }
}

/** The attributes of two blocks of the same type that differ. */
function attrChanges(v: Block, w: Block): AttrChange[] {
  const out: AttrChange[] = []
  const add = (key: string, label: string, version: string | null, working: string | null) => {
    if (version !== working) out.push({ key, label, version, working })
  }
  const va = attrsOf(v)
  const wa = attrsOf(w)
  const textAlign = (b: Block) => {
    const align = (pmOf(b)?.attrs as { textAlign?: unknown } | undefined)?.textAlign
    return typeof align === "string" && align !== "left" ? (ALIGN_LABELS[align] ?? align) : "Left"
  }

  switch (v.type) {
    case "paragraph":
      add("textAlign", "Alignment", textAlign(v), textAlign(w))
      break
    case "heading":
      add("level", "Heading level", `H${display(va.level) ?? "1"}`, `H${display(wa.level) ?? "1"}`)
      add("textAlign", "Alignment", textAlign(v), textAlign(w))
      break
    case "blockquote":
      add("cite", "Citation", display(va.cite), display(wa.cite))
      break
    case "code_block":
      add("language", "Language", display(va.language), display(wa.language))
      break
    case "image": {
      const file = (a: Record<string, unknown>) =>
        typeof a.mediaId === "number" ? `${fileName(a.src) ?? "Media"} (#${a.mediaId})` : fileName(a.src)
      add("file", "Image", file(va), file(wa))
      add("alt", "Alt text", display(va.alt), display(wa.alt))
      add("title", "Title", display(va.title), display(wa.title))
      const width = (a: Record<string, unknown>) => WIDTH_LABELS[String(a.align ?? "inline")] ?? WIDTH_LABELS.inline
      add("align", "Width", width(va), width(wa))
      break
    }
    case "group": {
      const width = (a: Record<string, unknown>) => GROUP_WIDTH_LABELS[String(a.align ?? "content")] ?? GROUP_WIDTH_LABELS.content
      const style = (a: Record<string, unknown>) => GROUP_STYLE_LABELS[String(a.style ?? "none")] ?? GROUP_STYLE_LABELS.none
      add("align", "Width", width(va), width(wa))
      add("style", "Background", style(va), style(wa))
      break
    }
    case "divider":
    case "list_item":
      break
    default: {
      // Theme blocks (#376) keep their declared attrs on `attrs`; older custom blocks keep
      // their node attrs there too. Everything but the content is an attribute.
      const keys = new Set([...Object.keys(va), ...Object.keys(wa)])
      for (const key of [...keys].sort()) {
        if (key === "pm" || key === "text") continue
        add(key, key, display(va[key]), display(wa[key]))
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------
// Lists

interface ItemNode {
  id: string | null
  tokens: Token[]
  lists: ListNode[]
}

interface ListNode {
  ordered: boolean
  items: ItemNode[]
}

const isListNode = (node: PMJson) => node.type === "bulletList" || node.type === "orderedList"

function itemFromPM(pm: PMJson | undefined, id: string | null, fallbackText?: unknown): ItemNode {
  if (!pm || !Array.isArray(pm.content)) {
    return { id, tokens: typeof fallbackText === "string" ? tokenize(fallbackText) : [], lists: [] }
  }
  return {
    id,
    tokens: contentTokens(pm.content, isListNode),
    lists: pm.content.filter((n) => n && isListNode(n)).map(listFromPM),
  }
}

function listFromPM(pm: PMJson): ListNode {
  return {
    ordered: pm.type === "orderedList",
    items: (pm.content ?? [])
      .filter((n) => n?.type === "listItem")
      .map((n) => {
        const id = n.attrs?.["data-block-id"]
        return itemFromPM(n, typeof id === "string" && id !== "" ? id : null)
      }),
  }
}

function listFromBlock(block: Block, doc: Doc): ListNode {
  return {
    ordered: block.type === "ordered_list",
    items: (block.children ?? [])
      .map((childId) => doc.blocks[childId])
      .filter((child): child is Block => !!child)
      .map((child) =>
        // A paragraph child is shown as an item (the bridge wraps it); without its pm, its
        // plain text.
        child.type === "paragraph"
          ? itemFromPM(pmOf(child) ? { content: [pmOf(child)!] } : undefined, child.id, attrsOf(child).text)
          : itemFromPM(pmOf(child), child.id, attrsOf(child).text)
      ),
  }
}

function oneSidedList(list: ListNode, status: "version" | "working"): ListDiff {
  return { ordered: list.ordered, status, attrs: [], items: list.items.map((item) => oneSidedItem(item, status)) }
}

function oneSidedItem(item: ItemNode, status: "version" | "working"): ItemDiff {
  return {
    id: item.id,
    status,
    moved: false,
    text: diffTokens(status === "working" ? item.tokens : [], status === "version" ? item.tokens : []),
    lists: item.lists.map((l) => oneSidedList(l, status)),
  }
}

function diffItem(v: ItemNode, w: ItemNode, moved: boolean): ItemDiff {
  const text = diffTokens(w.tokens, v.tokens)
  const lists: ListDiff[] = []
  const n = Math.max(v.lists.length, w.lists.length)
  // Nested lists have no ids of their own: the n-th list of the item is the n-th.
  for (let i = 0; i < n; i++) {
    const vl = v.lists[i]
    const wl = w.lists[i]
    lists.push(vl && wl ? diffList(vl, wl) : vl ? oneSidedList(vl, "version") : oneSidedList(wl, "working"))
  }
  const changed = hasChanges(text) || lists.some((l) => l.status !== "same")
  return { id: v.id, status: changed ? "changed" : "same", moved, text, lists }
}

function diffList(v: ListNode, w: ListNode): ListDiff {
  const vKeys = uniqueKeys(v.items.map((i) => i.id))
  const wKeys = uniqueKeys(w.items.map((i) => i.id))
  const keyed = (items: ItemNode[], keys: string[]) => items.map((item, i) => ({ item, key: keys[i] }))
  const items = align(keyed(v.items, vKeys), keyed(w.items, wKeys), (x) => x.key).map((a): ItemDiff => {
    if (a.version && a.working) return diffItem(a.version.item, a.working.item, a.moved)
    return a.version ? oneSidedItem(a.version.item, "version") : oneSidedItem(a.working!.item, "working")
  })
  const attrs: AttrChange[] = []
  if (v.ordered !== w.ordered) {
    attrs.push({
      key: "listType",
      label: "List type",
      version: v.ordered ? "Numbered" : "Bulleted",
      working: w.ordered ? "Numbered" : "Bulleted",
    })
  }
  const changed = attrs.length > 0 || items.some((i) => i.status !== "same" || i.moved)
  return { ordered: v.ordered, status: changed ? "changed" : "same", attrs, items }
}

// ---------------------------------------------------------------------------------------
// Blocks

const isList = (block: Block) => block.type === "bullet_list" || block.type === "ordered_list"

function diffBlock(id: string, v: Block, w: Block, vDoc: Doc, wDoc: Doc, moved: boolean): BlockDiffEntry {
  if (isList(v) && isList(w)) {
    const list = diffList(listFromBlock(v, vDoc), listFromBlock(w, wDoc))
    return { id, status: list.status === "same" ? "same" : "changed", moved, list, attrs: list.attrs }
  }

  if (v.type !== w.type) {
    // Turned into another type (same id): the text diff, and the type as an attribute.
    const vTokens = isList(v) ? listTokens(listFromBlock(v, vDoc)) : blockTokens(v)
    const wTokens = isList(w) ? listTokens(listFromBlock(w, wDoc)) : blockTokens(w)
    return {
      id,
      status: "changed",
      moved,
      text: diffTokens(wTokens, vTokens),
      attrs: [{ key: "type", label: "Block type", version: blockTypeLabel(v.type), working: blockTypeLabel(w.type) }],
    }
  }

  if (isContainerType(v.type)) {
    // Same container type: its attributes, and its children by id at any depth.
    const attrs = attrChanges(v, w)
    const children = diffEntries(childIds(v, vDoc), childIds(w, wDoc), vDoc, wDoc)
    const changed = attrs.length > 0 || children.some((child) => child.status !== "same" || child.moved)
    return { id, status: changed ? "changed" : "same", moved, children, attrs }
  }

  const attrs = attrChanges(v, w)
  const text = v.type === "image" || v.type === "divider" ? undefined : diffTokens(blockTokens(w), blockTokens(v))
  const caption = v.type === "image" ? diffTokens(captionTokens(w), captionTokens(v)) : undefined
  const changed = attrs.length > 0 || (text ? hasChanges(text) : false) || (caption ? hasChanges(caption) : false)
  return {
    id,
    status: changed ? "changed" : "same",
    moved,
    ...(changed && text ? { text } : {}),
    ...(changed && caption ? { caption } : {}),
    attrs,
  }
}

/** A list's text flattened (only for a list turned into another type). */
function listTokens(list: ListNode): Token[] {
  const out: Token[] = []
  const walk = (l: ListNode) => {
    for (const item of l.items) {
      if (out.length > 0) out.push({ text: "\n\n", kind: "para", key: "\u0000para" })
      out.push(...item.tokens)
      item.lists.forEach(walk)
    }
  }
  walk(list)
  return out
}

function isBlankParagraph(block: Block | undefined): boolean {
  if (!block || block.type !== "paragraph") return false
  // Breaks and whitespace show nothing; an inline node does.
  return blockTokens(block).every((t) => t.kind === "break" || t.kind === "para" || (!t.kind && !t.text.trim()))
}

/**
 * The top-level ids worth comparing: each once, existing, without the blank paragraphs at
 * the end (TipTap's trailing node; the public renderer leaves them out too).
 */
function orderOf(doc: Doc | null | undefined): string[] {
  if (!doc || !Array.isArray(doc.blocks_order) || !doc.blocks) return []
  const ids = [...new Set(doc.blocks_order)].filter((id) => !!doc.blocks[id])
  while (ids.length > 0 && isBlankParagraph(doc.blocks[ids[ids.length - 1]])) ids.pop()
  return ids
}

const EMPTY: Doc = { blocks_order: [], blocks: {} }

/** A container's children worth comparing: each once, existing. */
function childIds(block: Block, doc: Doc): string[] {
  return [...new Set(block.children ?? [])].filter((id) => !!doc.blocks[id])
}

/** One entry per id of either side, aligned as at the top level. */
function entryFor(a: Aligned<string>, vDoc: Doc, wDoc: Doc): BlockDiffEntry {
  if (a.version && a.working) return diffBlock(a.key, vDoc.blocks[a.key], wDoc.blocks[a.key], vDoc, wDoc, a.moved)
  return { id: a.key, status: a.version ? "version" : "working", moved: false, attrs: [] }
}

function diffEntries(vIds: string[], wIds: string[], vDoc: Doc, wDoc: Doc): BlockDiffEntry[] {
  return align(vIds, wIds, (id) => id).map((a) => entryFor(a, vDoc, wDoc))
}

/**
 * The diff, one step per block: a generator so the main-thread fallback can yield between
 * slices (diffBlockDocsAsync). `diffBlockDocs` runs it to the end.
 */
export function* diffBlockDocsSteps(
  version: Doc | null | undefined,
  working: Doc | null | undefined
): Generator<void, BlockDocDiff> {
  const vDoc = version && version.blocks ? version : EMPTY
  const wDoc = working && working.blocks ? working : EMPTY
  const aligned = align(orderOf(vDoc), orderOf(wDoc), (id) => id)
  const entries: BlockDiffEntry[] = []
  const summary: DiffSummary = { changed: 0, versionOnly: 0, workingOnly: 0, moved: 0, same: 0 }
  for (const a of aligned) {
    const entry = entryFor(a, vDoc, wDoc)
    entries.push(entry)
    if (entry.status === "changed") summary.changed++
    else if (entry.status === "version") summary.versionOnly++
    else if (entry.status === "working") summary.workingOnly++
    else if (!entry.moved) summary.same++
    if (entry.moved) summary.moved++
    yield
  }
  return { entries, summary }
}

/** Compares a version's doc with the working copy's. Synchronous: the worker runs this. */
export function diffBlockDocs(version: Doc | null | undefined, working: Doc | null | undefined): BlockDocDiff {
  const steps = diffBlockDocsSteps(version, working)
  for (;;) {
    const next = steps.next()
    if (next.done) return next.value
  }
}

/** Whether the two docs have the same content (nothing to highlight). */
export function isIdentical(diff: BlockDocDiff): boolean {
  const { changed, versionOnly, workingOnly, moved } = diff.summary
  return changed + versionOnly + workingOnly + moved === 0
}

export type { Segment } from "./wordDiff"
