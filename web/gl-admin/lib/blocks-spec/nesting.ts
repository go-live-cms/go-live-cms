/**
 * How blocks nest in Block Spec v1 (#414, design: `docs/design/block-library.md` 2.2).
 *
 * A **container** is a block whose `children` is an ordered list of block ids, each child
 * a full block in the doc's flat `blocks` map, the representation lists already use. This
 * table says which types are containers and what each may hold. Everything else is
 * derived from it: the TipTap content expressions (`containerContent`), the shared
 * block-id predicate (`isBlockNode`), the bridge (`blockBridge.ts`), the structural checks
 * of `validateBlockDoc` (`nestingIssues`) and, through `nestingVectors.json`, the API's
 * (`api/post_blocks_nesting.go`). A new container (columns, details, …) is a row here plus
 * its own issue.
 *
 * **The table is acyclic on purpose.** No container may hold itself, directly or through
 * another, so the schema bounds the nesting depth and nothing needs a depth counter. A
 * test fails on a cycle (`nesting.test.ts`).
 *
 * Pure data and functions: no ProseMirror, Yjs or Zod, so the collab server, the editor,
 * the public renderer and the tests all read the same table.
 */

/**
 * The core Block Spec types that hold no blocks (design 2.2's `flow`). Lists count as
 * flow: their items are their own business, as before #414. Theme blocks and any type
 * this build doesn't know count as flow too (`isFlowType`): they are one node each.
 */
export const FLOW_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "code_block",
  "divider",
  "image",
  "bullet_list",
  "ordered_list",
  // #419
  "callout",
  "pull_quote",
  "todo_list",
  // #420
  "table",
  // #423
  "video",
  "audio",
  "file",
  // #425
  "embed",
  // #426
  "buttons",
  "spacer",
] as const

/**
 * Flow nodes that are **not in TipTap's `block` group** (#420): they may be a block of the
 * doc or of a container that holds flow, but never part of another block's own content (a
 * quote's `block+`, a list item's `paragraph block*`, a callout, a theme block), where they
 * would be hidden in that block's `pm` and the public renderer, which renders only text
 * there, would drop them. The flow content expressions name them next to `block`.
 */
// The media blocks (#423) and embeds (#425) too: one in a quote's pm would never render.
// Buttons and the spacer (#426) too: the page renders them from their own blocks only.
export const STANDALONE_FLOW_NODE_NAMES = ["tableBlock", "video", "audio", "file", "embed", "buttons", "spacer"] as const

/**
 * The list types: `children` are their items, as before #414. Each list has one item
 * type: `list_item` for the bulleted and numbered lists, `todo_item` (with `checked`) for
 * the to-do list (#419). An item is a block with its own id, never a list's flow child.
 */
export const LIST_TYPES = ["bullet_list", "ordered_list", "todo_list"] as const

/** Each list type's item: its Block Spec type and ProseMirror node. */
export const LIST_ITEMS: Readonly<Record<(typeof LIST_TYPES)[number], { type: string; node: string }>> = {
  bullet_list: { type: "list_item", node: "listItem" },
  ordered_list: { type: "list_item", node: "listItem" },
  todo_list: { type: "todo_item", node: "taskItem" },
}

/** A container's row in the table. */
export interface ContainerRule {
  /** The ProseMirror node (camelCase; the Block Spec type is snake_case). */
  node: string
  /** What it holds: `"flow"` (every flow type) and/or container types, by Block Spec type. */
  accepts: readonly string[]
  /** Fewest children. The bridge synthesizes up to this many (`synthesize`). */
  min: number
  /** Most children; none = no limit. */
  max?: number
  /** Allowed in `blocks_order` (some containers only exist inside their parent). */
  topLevel: boolean
  /**
   * What the bridge adds when fewer than `min` children are left after drops (design
   * 2.5): the child's Block Spec type and the `role` its deterministic id is made from
   * (`synthesizedChildId`). None on a container that may be empty (`min: 0`).
   */
  synthesize?: { type: string; role: string }
  /** An id-less wrapper node between the container and its children, if any (design 2.4). */
  slot?: string
  /** Child nodes that are parts of the block, not blocks (a summary, a caption): no ids. */
  parts?: readonly string[]
  /** The parts come after the blocks instead of before them (a gallery's caption, under its images). */
  partsLast?: boolean
  /** Stays when its last block is deleted or moved away, with an empty paragraph in it (a column). */
  fillWhenEmptied?: boolean
  /**
   * The ProseMirror content expression doesn't enforce `min` and `max` (a `+` instead): a limit
   * two people can break at once. y-tiptap deletes an element whose children fail the content
   * check, for every peer, so two people adding a fourth column at once would delete the whole
   * row (and the group around it). `min`/`max` still hold everywhere else: the validators
   * (`nestingIssues`), moves, deletes and the commands (`blockTree.ts`'s `withChildren`), and the
   * collab server repairs the fragment before a store (`repairColumnsFragment`), which also
   * covers a paste, the one local change that doesn't go through those.
   */
  countNotInSchema?: boolean
}

/**
 * The containers. Group (#414) is the first, Details (#421) the second, Gallery (#424) the
 * third; columns, column, cover, media & text and footnotes follow in their own issues
 * (#352's build order), each a row here.
 *
 * Details' summary is a **part** (`detailsSummary`, rich text): a child node with no id,
 * always its first child, stored as the block's `attrs.summary` runs, never as a block
 * (design 2.4). There is no slot: our own node holds its blocks right after the summary,
 * so TipTap's Details extension (and its `detailsContent` wrapper) isn't used.
 *
 * A gallery holds image blocks only and may be empty (`min: 0`: every image removed is an
 * editor state, not an error, so nothing is synthesized and nothing dropped for it). Its
 * caption is a part too (`galleryCaption`, `attrs.caption` runs), after the images, where
 * readers see it.
 *
 * Columns (#426) are two rows: `columns` holds 2–4 `column`s and exists at the top level or
 * in a group; a `column` only exists inside its `columns` and holds flow and details. **No
 * group in a column** (design 7's open question, decided by the canvas: it draws a group
 * holding columns, never the reverse), so the table stays acyclic.
 */
export const CONTAINERS = {
  group: {
    node: "group",
    accepts: ["flow", "details", "columns"],
    min: 1,
    topLevel: true,
    synthesize: { type: "paragraph", role: "paragraph" },
  },
  details: {
    node: "details",
    accepts: ["flow"],
    min: 1,
    topLevel: true,
    synthesize: { type: "paragraph", role: "paragraph" },
    parts: ["detailsSummary"],
  },
  gallery: {
    node: "gallery",
    accepts: ["image"],
    min: 0,
    topLevel: true,
    parts: ["galleryCaption"],
    partsLast: true,
  },
  columns: {
    node: "columns",
    accepts: ["column"],
    min: 2,
    max: 4,
    topLevel: true,
    synthesize: { type: "column", role: "column-part" },
    countNotInSchema: true,
  },
  column: {
    node: "column",
    accepts: ["flow", "details"],
    min: 1,
    topLevel: false,
    synthesize: { type: "paragraph", role: "paragraph" },
    fillWhenEmptied: true,
  },
} as const satisfies Record<string, ContainerRule>

export type ContainerType = keyof typeof CONTAINERS

/** Block Spec type → ProseMirror node name, for every core block type. */
export const BLOCK_NODE_NAMES: Readonly<Record<string, string>> = {
  paragraph: "paragraph",
  heading: "heading",
  blockquote: "blockquote",
  code_block: "codeBlock",
  divider: "horizontalRule",
  image: "image",
  bullet_list: "bulletList",
  ordered_list: "orderedList",
  list_item: "listItem",
  callout: "callout",
  pull_quote: "pullQuote",
  todo_list: "taskList",
  todo_item: "taskItem",
  // #420: the block node is the figure (`tableBlock`: the `table` plus its caption).
  table: "tableBlock",
  // #423
  video: "video",
  audio: "audio",
  file: "file",
  // #425
  embed: "embed",
  // #426
  buttons: "buttons",
  spacer: "spacer",
  ...Object.fromEntries(Object.entries(CONTAINERS).map(([type, rule]) => [type, rule.node])),
}

const CORE_TYPES = new Set(Object.keys(BLOCK_NODE_NAMES))
const FLOW = new Set<string>(FLOW_TYPES)
const LISTS = new Set<string>(LIST_TYPES)
/** The ProseMirror node names of the list types. */
export const LIST_NODE_NAMES: ReadonlySet<string> = new Set(LIST_TYPES.map((type) => BLOCK_NODE_NAMES[type]))
/** List node → its item node ("bulletList" → "listItem", "taskList" → "taskItem"). */
const ITEM_NODE_OF_LIST = new Map<string, string>(LIST_TYPES.map((type) => [BLOCK_NODE_NAMES[type], LIST_ITEMS[type].node]))
/** The ProseMirror node names of the list items. */
export const LIST_ITEM_NODE_NAMES: ReadonlySet<string> = new Set(ITEM_NODE_OF_LIST.values())

/** The item node a list node holds, or undefined for a node that isn't a list. */
export function listItemNodeOf(listNodeName: unknown): string | undefined {
  return typeof listNodeName === "string" ? ITEM_NODE_OF_LIST.get(listNodeName) : undefined
}

/** The list type's item, or undefined for a type that isn't a list. */
export function listItemOf(type: unknown): { type: string; node: string } | undefined {
  return isListType(type) ? LIST_ITEMS[type as (typeof LIST_TYPES)[number]] : undefined
}
const CONTAINER_RULES: Readonly<Record<string, ContainerRule>> = CONTAINERS
const CONTAINER_BY_NODE = new Map(Object.entries(CONTAINER_RULES).map(([type, rule]) => [rule.node, { type, ...rule }]))
const SLOTS = new Map(
  Object.values(CONTAINER_RULES)
    .filter((rule) => rule.slot)
    .map((rule) => [rule.slot as string, rule]),
)

export function isContainerType(type: unknown): type is ContainerType {
  return typeof type === "string" && Object.prototype.hasOwnProperty.call(CONTAINERS, type)
}

export function containerRule(type: unknown): ContainerRule | undefined {
  return isContainerType(type) ? CONTAINER_RULES[type] : undefined
}

/** The container a ProseMirror node name is, with its Block Spec type. */
export function containerOfNode(nodeName: unknown): (ContainerRule & { type: string }) | undefined {
  return typeof nodeName === "string" ? CONTAINER_BY_NODE.get(nodeName) : undefined
}

export function isListType(type: unknown): boolean {
  return typeof type === "string" && LISTS.has(type)
}

/** A known core type (paragraph, …, list_item, the containers). */
export function isCoreBlockType(type: unknown): boolean {
  return typeof type === "string" && CORE_TYPES.has(type)
}

/**
 * Flow: a core flow type, or a type that isn't a core type at all (a theme block, a
 * type from a newer build kept by a stand-in), which is one node holding no blocks.
 */
export function isFlowType(type: unknown): boolean {
  return typeof type === "string" && type !== "" && (FLOW.has(type) || !CORE_TYPES.has(type))
}

/** Whether a `containerType` block may have a child of `childType`. */
export function acceptsChild(containerType: string, childType: unknown): boolean {
  const rule = containerRule(containerType)
  if (!rule || typeof childType !== "string") return false
  return rule.accepts.includes(childType) || (rule.accepts.includes("flow") && isFlowType(childType))
}

/** Whether `type` (Block Spec) is a flow block that can't be part of another block's content. */
export function isStandaloneFlowType(type: unknown): boolean {
  return typeof type === "string" && (STANDALONE_FLOW_NODE_NAMES as readonly string[]).includes(BLOCK_NODE_NAMES[type] ?? "")
}

/** The content-expression names of flow: TipTap's `block` group plus the standalone flow nodes. */
const FLOW_NAMES: readonly string[] = ["block", ...STANDALONE_FLOW_NODE_NAMES]

/**
 * A container's ProseMirror content expression, derived from the table. `flow` is
 * TipTap's `block` group plus the standalone flow nodes (the table, #420): no container is
 * in either, so they hold exactly the nodes that hold no blocks (core flow nodes, theme
 * blocks, stand-ins). Containers are named. Its parts come first, each exactly once
 * (details: `detailsSummary (block | tableBlock)+`, #421), or last with `partsLast`
 * (gallery: `image* galleryCaption`, #424).
 */
export function containerContent(type: ContainerType): string {
  const rule: ContainerRule = CONTAINERS[type]
  const names = rule.accepts.flatMap((accepted) => (accepted === "flow" ? FLOW_NAMES : [BLOCK_NODE_NAMES[accepted]]))
  const choice = names.length === 1 ? names[0] : `(${names.join(" | ")})`
  let blocks: string
  if (rule.countNotInSchema) blocks = `${choice}+`
  else if (rule.max !== undefined) blocks = `${choice}{${rule.min},${rule.max}}`
  else blocks = rule.min === 0 ? `${choice}*` : rule.min === 1 ? `${choice}+` : `${choice}{${rule.min},}`
  const parts = rule.parts ?? []
  return (rule.partsLast ? [blocks, ...parts] : [...parts, blocks]).join(" ")
}

/** The ProseMirror node names that are a container's parts (a summary): never blocks, never ids. */
export const CONTAINER_PART_NODE_NAMES: ReadonlySet<string> = new Set(Object.values(CONTAINER_RULES).flatMap((rule) => [...(rule.parts ?? [])]))

/**
 * The text nodes that are part of a block, not blocks (#346, #420, #421, #424): an image's,
 * a table's or a gallery's caption, a details summary and a button's label (#426, plain text).
 * One line with bold, italic and link at most: no block menu, no Turn into and no "Type /" hint in them.
 */
export const TEXT_PART_NODE_NAMES: ReadonlySet<string> = new Set(["imageCaption", "tableCaption", "button", ...CONTAINER_PART_NODE_NAMES])

/** The doc's content expression: flow (`block` and the standalone flow nodes) plus every container allowed at the top. */
export function topLevelContent(): string {
  const containers = Object.values(CONTAINER_RULES)
    .filter((rule) => rule.topLevel)
    .map((rule) => rule.node)
  const names = [...FLOW_NAMES, ...containers]
  return names.length === 1 ? "block+" : `(${names.join(" | ")})+`
}

/**
 * **The block predicate** (design 2.6, #315's identity contract): a node is a block, and
 * gets a `data-block-id`, when its parent is the doc, a container or a container's slot,
 * or when it is a list's item (a `listItem` of a bulleted or numbered list, a `taskItem`
 * of a to-do list, #419). Parts (summary, captions) and slots are never blocks.
 * `parentName` is null (or `"doc"`) at the top level. Used by `BlockIdExtension`,
 * `stampFragmentBlockIds` and `pmToBlockDoc`: one rule, so the editor, the server's
 * stamping and the stored doc agree on which nodes have ids.
 */
export function isBlockNode(nodeName: string, parentName: string | null): boolean {
  if (parentName === null || parentName === "doc") return true
  if (LIST_ITEM_NODE_NAMES.has(nodeName)) return ITEM_NODE_OF_LIST.get(parentName) === nodeName
  const container = CONTAINER_BY_NODE.get(parentName)
  if (container) return nodeName !== container.slot && !(container.parts ?? []).includes(nodeName)
  const slotOf = SLOTS.get(parentName)
  return slotOf !== undefined && !(slotOf.parts ?? []).includes(nodeName)
}

/** The ProseMirror node names that are containers (BlockIdExtension gives them the id attribute). */
export const CONTAINER_NODE_NAMES: readonly string[] = Object.values(CONTAINER_RULES).map((rule) => rule.node)

/**
 * Id of a child the bridge synthesizes into a container left with too few children
 * (design 2.5). Derived from the container id, never random, so the same doc gives the
 * same id on every load and the store sees no change. Every role in the table is at
 * least 9 characters (`nesting.test.ts`), so the suffix with its dash is at least 10 and
 * the id passes the length check however short the container id is. Lists use the same
 * rule (`synthesizedItemId`: `<listId>-list-item`).
 */
export function synthesizedChildId(containerId: string, role: string): string {
  return `${containerId}-${role}`
}

/**
 * The ids of the blocks the public page renders, in reading order (#414, design 2.10):
 * `blocks_order`, and each container's children depth first, each block once. List items
 * are not visited (their list renders them). The public renderer's helpers read only
 * this: `headingAnchors`, `isFirstImageBlock`, `firstParagraphText`, so a heading, an
 * image or a first paragraph inside a group counts like a top-level one.
 */
export function blocksInReadingOrder(doc: DocLike | null | undefined): string[] {
  const blocks = (doc?.blocks && typeof doc.blocks === "object" ? doc.blocks : {}) as Record<string, any>
  const order = Array.isArray(doc?.blocks_order) ? doc.blocks_order : []
  const out: string[] = []
  const seen = new Set<string>()
  const visit = (id: unknown) => {
    if (typeof id !== "string" || seen.has(id)) return
    const block = Object.prototype.hasOwnProperty.call(blocks, id) ? blocks[id] : undefined
    if (!block || typeof block !== "object") return
    seen.add(id)
    out.push(id)
    if (isContainerType(block.type) && Array.isArray(block.children)) block.children.forEach(visit)
  }
  order.forEach(visit)
  return out
}

// ── Structure (design 2.3) ──────────────────────────────────────────────────────────

interface DocLike {
  blocks_order?: unknown
  blocks?: unknown
}

const dedupe = (ids: unknown[]): unknown[] => {
  const seen = new Set<unknown>()
  return ids.filter((id) => (seen.has(id) ? false : (seen.add(id), true)))
}

/**
 * `doc` with repeats removed **within** `blocks_order` and within each block's
 * `children` (first occurrence kept), as the API's `deduplicateBlocks` does before its
 * checks. Such docs exist (a block id listed twice in one list), so this runs before
 * `validateBlockDoc` in the collab store and never makes a stored post start failing.
 * An id under two different parents is not touched: that is an error (`nestingIssues`).
 * Returns `doc` itself when nothing repeats; otherwise a copy (the input is not mutated).
 */
export function dedupeBlockRefs<T>(doc: T): T {
  const source = doc as DocLike
  if (!source || typeof source !== "object") return doc
  let changed = false
  let order = source.blocks_order
  if (Array.isArray(order)) {
    const unique = dedupe(order)
    if (unique.length !== order.length) {
      order = unique
      changed = true
    }
  }
  let blocks = source.blocks
  if (blocks && typeof blocks === "object" && !Array.isArray(blocks)) {
    let copied: Record<string, unknown> | null = null
    for (const [id, block] of Object.entries(blocks as Record<string, unknown>)) {
      const children = (block as { children?: unknown } | null)?.children
      if (!Array.isArray(children)) continue
      const unique = dedupe(children)
      if (unique.length === children.length) continue
      copied ??= { ...(blocks as Record<string, unknown>) }
      copied[id] = { ...(block as object), children: unique }
    }
    if (copied) {
      blocks = copied
      changed = true
    }
  }
  return changed ? ({ ...(doc as object), blocks_order: order, blocks } as T) : doc
}

export interface NestingIssue {
  path: (string | number)[]
  message: string
}

/**
 * The structural problems of a block doc (design 2.3), in a stable order; empty when it
 * is fine. Run after `dedupeBlockRefs`. The API runs the same checks
 * (`checkBlockNesting`); `nestingVectors.json` pins that both agree.
 *
 * 1. Every id in `blocks_order` or any `children` is a block in `blocks`.
 * 2. Each block is referenced at most once across `blocks_order` and every `children`.
 * 3. No cycles (a block can't be its own descendant).
 * 4. A container's children are of the types and in the count the table allows; a core
 *    block that is neither a container nor a list has no `children`; a container that only
 *    exists inside its parent (a `column`, #426) isn't in `blocks_order`.
 * An unreferenced block is not an error (restores and dropped blocks pass through such
 * states). `children` that isn't an array of strings is an error. Theme and unknown types
 * may have children (as before #414); rules 1–3 apply to them too.
 */
export function nestingIssues(doc: unknown): NestingIssue[] {
  const source = doc as DocLike
  const issues: NestingIssue[] = []
  const blocks = (source?.blocks && typeof source.blocks === "object" ? source.blocks : {}) as Record<string, any>
  const order = Array.isArray(source?.blocks_order) ? source.blocks_order : []
  const has = (id: unknown) => typeof id === "string" && Object.prototype.hasOwnProperty.call(blocks, id) && blocks[id]
  const referencedBy = new Map<string, string | null>()

  const reference = (id: unknown, parent: string | null, path: (string | number)[]) => {
    if (typeof id !== "string") return
    if (!has(id)) {
      issues.push({ path, message: `block ${id} is not in blocks` })
      return
    }
    if (referencedBy.has(id)) {
      issues.push({ path, message: `block ${id} is referenced more than once` })
      return
    }
    referencedBy.set(id, parent)
  }

  order.forEach((id, index) => {
    reference(id, null, ["blocks_order", index])
    // A `column` (#426) only exists inside its `columns`.
    const rule = has(id) ? containerRule(blocks[id as string].type) : undefined
    if (rule && !rule.topLevel) issues.push({ path: ["blocks_order", index], message: `a ${String(blocks[id as string].type)} can't be at the top level` })
  })

  const keys = Object.keys(blocks).sort()
  for (const key of keys) {
    const block = blocks[key]
    if (!block || typeof block !== "object") continue
    const type = block.type
    const hasChildren = Object.prototype.hasOwnProperty.call(block, "children") && block.children !== undefined
    const children: unknown = block.children
    if (hasChildren && (!Array.isArray(children) || children.some((id) => typeof id !== "string"))) {
      issues.push({ path: ["blocks", key, "children"], message: "children must be an array of block ids" })
      continue
    }
    const list = hasChildren ? (children as string[]) : []
    const rule = containerRule(type)
    if (rule) {
      if (list.length < rule.min) issues.push({ path: ["blocks", key, "children"], message: `a ${type} needs at least ${rule.min} block(s)` })
      if (rule.max !== undefined && list.length > rule.max) {
        issues.push({ path: ["blocks", key, "children"], message: `a ${type} holds at most ${rule.max} blocks` })
      }
      list.forEach((id, index) => {
        if (has(id) && !acceptsChild(type, blocks[id].type)) {
          issues.push({ path: ["blocks", key, "children", index], message: `a ${type} can't hold a ${String(blocks[id].type)}` })
        }
      })
    } else if (hasChildren && isCoreBlockType(type) && !isListType(type)) {
      issues.push({ path: ["blocks", key, "children"], message: `a ${String(type)} has no children` })
    }
    list.forEach((id, index) => reference(id, key, ["blocks", key, "children", index]))
  }

  // Rule 3. With rule 2 every block has at most one parent, so walking up from each one
  // either reaches the top (or an unreferenced block) or comes back around.
  const inCycle = new Set<string>()
  for (const start of referencedBy.keys()) {
    const path = new Set<string>()
    let at: string | null | undefined = start
    while (at !== null && at !== undefined && !path.has(at) && !inCycle.has(at)) {
      path.add(at)
      at = referencedBy.get(at)
    }
    if (at !== null && at !== undefined && path.has(at)) {
      // `at` is on the cycle; report it once, at the block that closes it.
      let node: string = at
      const members: string[] = []
      do {
        members.push(node)
        inCycle.add(node)
        node = referencedBy.get(node) as string
      } while (node !== at)
      const first = members.sort()[0]
      issues.push({ path: ["blocks", first, "children"], message: `block ${first} contains itself` })
    }
  }
  return issues
}
