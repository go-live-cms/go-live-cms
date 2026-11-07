import { Node as PMNode, Schema, type ContentMatch } from "prosemirror-model"
import {
  BLOCKQUOTE_BLOCK_VERSION,
  captionRuns,
  clampTableSpan,
  tableRows,
  IMAGE_BLOCK_VERSION,
  isImageAlign,
  normalizeBlockColor,
  normalizeCalloutTone,
  normalizeCite,
  normalizeFileLabel,
  AUDIO_BLOCK_VERSION,
  FILE_BLOCK_VERSION,
  VIDEO_BLOCK_VERSION,
  type BlockColor,
  type BlockDocV1,
  type Block,
  type BlockID,
  type CaptionText,
} from "../blocks-spec"
import { attrProblem, isThemeBlockType, themeBlockSpecOf, type ThemeBlockSpec } from "../blocks-spec/themeBlocks"
import {
  acceptsChild,
  BLOCK_NODE_NAMES,
  containerOfNode,
  containerRule,
  isBlockNode,
  isGroupAlign,
  isGroupStyle,
  LIST_NODE_NAMES,
  listItemOf,
  synthesizedChildId,
  type ContainerRule,
} from "../blocks-spec"
import type { Editor } from "@tiptap/core"
import { BLOCK_COLOR_NODE_TYPES } from "../../components/editor/extensions/BlockColor"

// Simple block id generator
let idCounter = 0
function generateId(): string {
  // Add counter to ensure uniqueness even if called multiple times in same millisecond
  idCounter++
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 9)

  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID()
  }

  return `${random}-${timestamp}-${idCounter}`
}

/**
 * Ensure a ProseMirror node has a stable block ID
 * Returns existing ID or generates new one
 */
export function ensureBlockId(node: PMNode): BlockID {
  const existingId = node.attrs["data-block-id"]
  if (existingId && typeof existingId === "string" && existingId.length >= 10) {
    return existingId
  }

  return generateId()
}

/**
 * Convert ProseMirror document to Block Spec v1
 */
export function pmToBlockDoc(pmDoc: PMNode): BlockDocV1 {
  const blocks: Record<BlockID, Block> = {}
  const blocksOrder: BlockID[] = []
  const seenIds = new Set<BlockID>() // Track IDs to detect duplicates

  // One block per node that is a block (`isBlockNode`), in document order, at any depth
  // (#414): a container becomes its block plus one block per child, with `children` set.
  // Duplicate and invalid ids are regenerated across the whole doc.
  const convert = (node: PMNode): BlockID | null => {
    const isList = LIST_NODE_NAMES.has(node.type.name)
    const container = containerOfNode(node.type.name)
    const childNodes = container ? containerChildNodes(node) : []

    // A list with no items, or a container with no blocks, can only come from an already
    // schema-invalid PM node (nodeFromJSON doesn't enforce content). It holds no content,
    // so skip it rather than persist a childless list or container block (#213).
    if (isList && node.childCount === 0) return null
    if (container && childNodes.length === 0) return null

    const block = pmNodeToBlock(node, blocks, seenIds)
    if (!block) return null
    // Before the children, so none of them can take the parent's id.
    seenIds.add(block.id)

    if (isList) {
      const children: BlockID[] = []
      for (let j = 0; j < node.childCount; j++) {
        const listItemBlock = pmNodeToBlock(node.child(j), blocks, seenIds)
        if (listItemBlock) {
          blocks[listItemBlock.id] = listItemBlock
          children.push(listItemBlock.id)
          seenIds.add(listItemBlock.id)
        }
      }
      blocks[block.id] = { ...block, children }
    } else if (container) {
      const children = childNodes.map(convert).filter((id): id is BlockID => id !== null)
      blocks[block.id] = { ...block, children }
    } else {
      blocks[block.id] = block
    }
    return block.id
  }

  for (let i = 0; i < pmDoc.content.childCount; i++) {
    const id = convert(pmDoc.content.child(i))
    if (id !== null) blocksOrder.push(id)
  }

  return {
    doc_version: 1,
    blocks_order: blocksOrder,
    blocks,
  }
}


/**
 * A container node's child blocks, in order: its children that are blocks, and a slot's
 * (an id-less wrapper, design 2.4) flattened in. Parts (a summary, a caption) are left
 * out: they are attrs of the container's block.
 */
function containerChildNodes(node: PMNode): PMNode[] {
  const out: PMNode[] = []
  node.forEach((child) => {
    if (isBlockNode(child.type.name, node.type.name)) out.push(child)
    else if (containerOfNode(node.type.name)?.slot === child.type.name) {
      child.forEach((grandchild) => {
        if (isBlockNode(grandchild.type.name, child.type.name)) out.push(grandchild)
      })
    }
  })
  return out
}

/**
 * Convert individual ProseMirror node to Block
 */
function pmNodeToBlock(node: PMNode, allBlocks: Record<BlockID, Block>, seenIds: Set<BlockID>): Block | null {
  // Get existing ID, but generate new one if duplicate
  let id = node.attrs["data-block-id"]
  if (!id || typeof id !== "string" || id.length < 10 || seenIds.has(id)) {
    // No ID, invalid ID, or duplicate ID - generate new one
    id = generateId()
  }

  const themeSpec = themeBlockSpecOf(node.type)
  if (themeSpec) return themeNodeToBlock(node, id, themeSpec)

  switch (node.type.name) {
    case "paragraph":
      return {
        id,
        type: "paragraph",
        version: 1,
        attrs: {
          pm: pmJSON(node, "blockColor"),
          text: node.textContent || undefined,
          ...blockColorOf(node),
        },
      }

    case "heading":
      return {
        id,
        type: "heading",
        version: 1,
        attrs: {
          level: node.attrs.level as 1 | 2 | 3 | 4 | 5 | 6,
          pm: pmJSON(node, "blockColor"),
          text: node.textContent || undefined,
          ...blockColorOf(node),
        },
      }

    case "blockquote": {
      // `cite` is the block's attr, not the pm node's: the stored pm stays what it was
      // before #346, and a pm `cite` can't disagree with it. Same for `blockColor` (#356).
      const pm = pmJSON(node, "cite", "blockColor")
      return {
        id,
        type: "blockquote",
        version: BLOCKQUOTE_BLOCK_VERSION,
        attrs: {
          pm,
          text: node.textContent || undefined,
          cite: normalizeCite(node.attrs.cite) ?? undefined,
          ...blockColorOf(node),
        },
      }
    }

    case "codeBlock":
      return {
        id,
        type: "code_block",
        version: 1,
        attrs: {
          language: node.attrs.language || undefined,
          code: node.textContent || "",
        },
      }

    case "horizontalRule":
      return {
        id,
        type: "divider",
        version: 1,
        attrs: {},
      }

    case "image":
      return {
        id,
        type: "image",
        version: IMAGE_BLOCK_VERSION,
        attrs: {
          src: node.attrs.src || undefined,
          alt: node.attrs.alt || undefined,
          title: node.attrs.title || undefined,
          mediaId: mediaIdOf(node.attrs.mediaId),
          // Defaults are left out (#346), so an image nobody captioned or widened
          // stores what it stored before.
          caption: captionOf(node),
          align: node.attrs.align !== "inline" && isImageAlign(node.attrs.align) ? node.attrs.align : undefined,
        },
      }

    case "bulletList":
      return {
        id,
        type: "bullet_list",
        version: 1,
        attrs: { ...blockColorOf(node) },
        // children will be set by caller
      }

    case "orderedList":
      return {
        id,
        type: "ordered_list",
        version: 1,
        attrs: { ...blockColorOf(node) },
        // children will be set by caller
      }

    case "listItem":
      return {
        id,
        type: "list_item",
        version: 1,
        attrs: {
          pm: pmJSON(node),
          text: node.textContent || undefined,
        },
      }

    case "group":
      // Defaults left out, so an untouched group stores only its children.
      return {
        id,
        type: "group",
        version: 1,
        attrs: {
          ...(isGroupStyle(node.attrs.style) && node.attrs.style !== "none" ? { style: node.attrs.style } : {}),
          ...(isGroupAlign(node.attrs.align) && node.attrs.align !== "content" ? { align: node.attrs.align } : {}),
        },
        // children are set by the caller
      }

    // #421. The summary is a part: its runs and text are the block's attrs, never a block.
    // Defaults left out, so an untouched, closed details stores only its children.
    case "details":
      return {
        id,
        type: "details",
        version: 1,
        attrs: {
          ...summaryOf(node),
          ...(node.attrs.open === true ? { open: true as const } : {}),
        },
        // children are set by the caller
      }

    // #419. Like a quote's `cite`, each one's own attr is canonical on the block and
    // left out of its `pm`, so the two can never disagree.
    case "callout":
      return {
        id,
        type: "callout",
        version: 1,
        attrs: {
          pm: pmJSON(node, "tone"),
          text: node.textContent || undefined,
          // Always stored: an unknown value (a peer's bad update) is the default.
          tone: normalizeCalloutTone(node.attrs.tone),
        },
      }

    case "pullQuote":
      return {
        id,
        type: "pull_quote",
        version: 1,
        attrs: {
          pm: pmJSON(node, "cite"),
          text: node.textContent || undefined,
          cite: normalizeCite(node.attrs.cite) ?? undefined,
        },
      }

    case "taskList":
      return {
        id,
        type: "todo_list",
        version: 1,
        attrs: {},
        // children are set by the caller
      }

    case "taskItem":
      return {
        id,
        type: "todo_item",
        version: 1,
        attrs: {
          pm: pmJSON(node, "checked"),
          text: node.textContent || undefined,
          checked: node.attrs.checked === true,
        },
      }
    case "tableBlock":
      return tableNodeToBlock(node, id)

    // #423. The file is the media id alone (its URL, name and size are the media
    // library's); a caption like an image's, a file's label by `normalizeFileLabel`.
    // Empty ones left out, so a block with no file yet stores only its id and type.
    case "video":
    case "audio": {
      const caption = captionOf(node)
      return {
        id,
        type: node.type.name,
        version: node.type.name === "video" ? VIDEO_BLOCK_VERSION : AUDIO_BLOCK_VERSION,
        attrs: { ...mediaIdAttr(node.attrs.mediaId), ...(caption ? { caption } : {}) },
      } as Block
    }

    case "file": {
      const label = normalizeFileLabel(node.attrs.label)
      return {
        id,
        type: "file",
        version: FILE_BLOCK_VERSION,
        attrs: { ...mediaIdAttr(node.attrs.mediaId), ...(label ? { label } : {}) },
      }
    }

    default:
      // Custom/theme block - preserve full PM data for round-trip fidelity
      return {
        id,
        type: node.type.name,
        version: 1,
        attrs: {
          pm: pmJSON(node),
          text: node.textContent || undefined,
          // Preserve custom attributes (variant, message, etc.)
          ...Object.fromEntries(Object.entries(node.attrs).filter(([key]) => key !== "data-block-id")),
        },
      }
  }
}

/**
 * Block colour (#356) is the block's attr, canonical in `attrs.blockColor` like a quote's
 * `cite`, never in its `pm`: left out when the node has none or one outside the palette
 * (a peer's bad update costs the colour, never the store).
 */
function blockColorOf(node: PMNode): { blockColor?: BlockColor } {
  const color = normalizeBlockColor(node.attrs.blockColor)
  return color ? { blockColor: color } : {}
}

/**
 * A node's JSON for a block's `pm`, without the named top-level attrs (canonical on the
 * block), and with `blockColor` left out of every node that has none or one outside the
 * palette. `toJSON` keeps every attr, null ones included: without this, every paragraph
 * inside a list item, a quote or a theme block would gain `"blockColor": null`, and every
 * stored post would change (its `block_revision`, "Changes not published") on its first
 * store after #356. A nested colour (pasted from the editor's own HTML) stays, and renders.
 */
const COLOR_NODE_TYPES = new Set<string>(BLOCK_COLOR_NODE_TYPES)

function pmJSON(node: PMNode, ...topLevel: string[]): any {
  const clean = (json: any, root: boolean): any => {
    if (!json || typeof json !== "object") return json
    let out = json
    if (json.attrs && typeof json.attrs === "object") {
      const attrs = { ...json.attrs }
      if (root) for (const name of topLevel) delete attrs[name]
      // Only the node types BlockColor gives the attribute: a custom or theme node may have
      // its own attr of that name, with its own values.
      if (COLOR_NODE_TYPES.has(json.type) && "blockColor" in attrs && normalizeBlockColor(attrs.blockColor) === null) {
        delete attrs.blockColor
      }
      out = { ...json, attrs }
    }
    if (Array.isArray(json.content)) out = { ...out, content: json.content.map((child: any) => clean(child, false)) }
    return out
  }
  return clean(node.toJSON(), true)
}

/**
 * An installed theme block (#376). Its declared attrs are canonical in the block's
 * `attrs`, like a quote's `cite`, and never in its `pm`, which keeps only the content: the
 * API validates `attrs` against the manifest, and nothing can disagree with them.
 */
function themeNodeToBlock(node: PMNode, id: BlockID, spec: ThemeBlockSpec): Block {
  const json = pmJSON(node) as { type: string; content?: unknown[] }
  return {
    id,
    type: spec.type,
    version: spec.version,
    attrs: {
      ...declaredAttrs(spec, node.attrs),
      pm: json.content ? { type: json.type, content: json.content } : { type: json.type },
      text: node.textContent || undefined,
    },
  }
}

/**
 * A stored theme block as node JSON for `schema`. An installed one is built from its
 * declared attrs (a stored pm's attrs are ignored) and its pm content, or its text. A
 * version newer than this build reads, or a theme block whose theme isn't installed,
 * throws, so the block is dropped: hidden from the editor and kept as stored (#213).
 */
function themeBlockToPM(block: Block, schema: Schema, baseAttrs: Record<string, unknown>): any {
  const spec = themeBlockSpecOf(schema.nodes[block.type])
  if (!spec) throw new Error(`theme block type ${block.type} is not installed in this build`)
  if (typeof block.version !== "number" || block.version > spec.version) {
    throw new Error(`${block.type} version ${block.version} is newer than this build reads (${spec.version})`)
  }
  const attrs = block.attrs as Record<string, unknown>
  const pm = attrs.pm as { content?: unknown[] } | undefined
  const content = Array.isArray(pm?.content)
    ? pm.content
    : typeof attrs.text === "string" && attrs.text !== ""
      ? [{ type: "text", text: attrs.text }]
      : undefined
  return { type: block.type, attrs: { ...declaredAttrs(spec, attrs), ...baseAttrs }, ...(content ? { content } : {}) }
}

/**
 * The declared attrs of `source` (a node's or a stored block's attrs) that are set and
 * valid. Anything else is left out, so the default applies: a value the spec doesn't
 * allow (a peer's bad update, a theme that narrowed an attr without a new version) costs
 * that attr, never the store of the whole post.
 */
function declaredAttrs(spec: ThemeBlockSpec, source: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(spec.attrs)
      .filter(([name, attr]) => source[name] !== null && source[name] !== undefined && attrProblem(attr, source[name]) === null)
      .map(([name]) => [name, source[name]]),
  )
}

/**
 * The image's media id as the number Block Spec v1 (`zImage`) and the API's media sync
 * (`extractMediaIDsFromBlocks`, which skips non-numbers) expect. HTML parsing
 * (`data-media-id`) and older docs can carry it as a string.
 */
function mediaIdOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim())
  return undefined
}

/** `{ mediaId }` for a media id that is a positive integer (`zVideo` etc.), else nothing. */
function mediaIdAttr(value: unknown): { mediaId?: number } {
  const id = mediaIdOf(value)
  return id !== undefined && Number.isInteger(id) && id > 0 ? { mediaId: id } : {}
}

/**
 * An image's caption for Block Spec (#346): the text runs of its `imageCaption` child,
 * as ProseMirror JSON. Undefined when it has none or it's empty.
 */
function captionOf(image: PMNode): CaptionText[] | undefined {
  const caption = image.firstChild
  if (!caption || caption.type.name !== "imageCaption" || caption.content.size === 0) return undefined
  return caption.content.toJSON() as CaptionText[]
}

/**
 * A details' summary for Block Spec (#421): the runs of its `detailsSummary` (its first
 * child) as `attrs.summary`, and their text as `attrs.text` (what search reads). Neither
 * when it's empty.
 */
function summaryOf(details: PMNode): { summary?: CaptionText[]; text?: string } {
  const summary = details.firstChild
  if (!summary || summary.type.name !== "detailsSummary" || summary.content.size === 0) return {}
  return { summary: summary.content.toJSON() as CaptionText[], text: summary.textContent || undefined }
}

/**
 * The caption's runs as the `imageCaption` node's content: text only, only the caption
 * marks, and only the mark attrs `schema` declares (nodeFromJSON throws on any other),
 * so a caption the schema can't hold costs its marks or attrs, not the image.
 */
function captionToPM(caption: unknown, schema: Schema): any[] {
  return captionRuns(caption).map((run) => {
    const marks = run.marks
      ?.filter((mark) => schema.marks[mark.type])
      .map((mark) => {
        const declared = schema.marks[mark.type].spec.attrs ?? {}
        const attrs = Object.fromEntries(Object.entries(mark.attrs ?? {}).filter(([name]) => name in declared))
        return Object.keys(attrs).length > 0 ? { type: mark.type, attrs } : { type: mark.type }
      })
    return marks && marks.length > 0 ? { ...run, marks } : { type: "text", text: run.text }
  })
}

/**
 * A table block (#420) for Block Spec: the grid's rows as `attrs.pm` (every cell a
 * `tableCell`: whether the first row is a header row is `attrs.headerRow`, canonical, so a
 * stored cell type can't disagree with it), spans only when not 1, each cell's paragraphs
 * as `pmJSON` gives them; the caption as runs, like an image's; `text` the cells' text.
 * Defaults left out: no `headerRow` without one, no `caption` when it's empty.
 */
function tableNodeToBlock(node: PMNode, id: BlockID): Block {
  const grid = node.firstChild
  const caption = node.lastChild
  const rows: any[] = []
  const lines: string[] = []
  grid?.forEach((row) => {
    const cells: any[] = []
    const texts: string[] = []
    row.forEach((cell) => {
      const spans: Record<string, number> = {}
      const colspan = clampTableSpan(cell.attrs.colspan)
      const rowspan = clampTableSpan(cell.attrs.rowspan)
      if (colspan !== 1) spans.colspan = colspan
      if (rowspan !== 1) spans.rowspan = rowspan
      const content: any[] = []
      const paragraphs: string[] = []
      cell.forEach((paragraph) => {
        content.push(pmJSON(paragraph))
        if (paragraph.textContent) paragraphs.push(paragraph.textContent)
      })
      cells.push({ type: "tableCell", ...(Object.keys(spans).length > 0 ? { attrs: spans } : {}), content })
      if (paragraphs.length > 0) texts.push(paragraphs.join(" "))
    })
    rows.push({ type: "tableRow", content: cells })
    lines.push(texts.join(" ").trim())
  })
  const text = lines.join("\n").trim()
  const headerRow = grid?.type.name === "table" && grid.attrs.headerRow === true
  return {
    id,
    type: "table",
    version: 1,
    attrs: {
      pm: { type: "table", content: rows },
      text: text || undefined,
      ...(headerRow ? { headerRow: true as const } : {}),
      ...(caption?.type.name === "tableCaption" && caption.content.size > 0 ? { caption: caption.content.toJSON() as CaptionText[] } : {}),
    },
  }
}

/**
 * A stored table as `tableBlock` JSON (#420): its rows from `attrs.pm` (`tableRows`: only
 * rows, cells and their paragraphs, spans clamped), every cell a `tableCell` (a stored
 * `tableHeader` too), the grid's `headerRow` from `attrs.headerRow`, and the caption from
 * `attrs.caption`. A table with no rows can't be built: it throws, so the block is
 * dropped (hidden, kept) like any other block the editor can't show (#213).
 */
function tableBlockToPM(block: Block, baseAttrs: Record<string, unknown>, schema: Schema): any {
  const attrs = block.attrs as { pm?: unknown; headerRow?: unknown; caption?: unknown }
  const rows = tableRows(attrs.pm)
  if (rows.length === 0) throw new Error(`table ${block.id} has no rows`)
  const headerRow = attrs.headerRow === true
  return {
    type: "tableBlock",
    attrs: baseAttrs,
    content: [
      {
        type: "table",
        attrs: { headerRow },
        content: rows.map((cells) => ({
          type: "tableRow",
          content: cells.map((cell) => ({
            type: "tableCell",
            attrs: { colspan: cell.colspan, rowspan: cell.rowspan },
            content: cell.content,
          })),
        })),
      },
      { type: "tableCaption", ...captionContent(captionToPM(attrs.caption, schema)) },
    ],
  }
}

const captionContent = (runs: any[]) => (runs.length > 0 ? { content: runs } : {})

/**
 * Calls `visit` for `rootId` and each block under it (list and container children, any depth) in
 * `source`, each at most once, so a list that contains itself can't loop. Returning
 * false from `visit` skips that block's children. Missing ids are skipped.
 */
export function walkBlockTree(source: BlockDocV1, rootId: BlockID, visit: (block: Block) => boolean | void): void {
  const seen = new Set<BlockID>()
  const walk = (id: BlockID) => {
    const block = source.blocks[id]
    if (!block || seen.has(id)) return
    seen.add(id)
    if (visit(block) === false) return
    block.children?.forEach(walk)
  }
  walk(rootId)
}

/**
 * A block blockDocToPM had to leave out of the PM doc, and where it sat in the source
 * doc so restoreDroppedBlocks can put it back on save.
 */
export interface DroppedBlock {
  id: BlockID
  /** The list or container a dropped child belonged to; null for a top-level block. */
  parentId: BlockID | null
  /** The preceding sibling in the source doc (dropped or not); null if it was first. */
  afterId: BlockID | null
}

interface ConvertContext {
  schema: Schema
  dropped: DroppedBlock[]
  /**
   * Lists and containers currently being converted, to catch one that (transitively)
   * contains itself.
   */
  containersInProgress: Set<BlockID>
  /**
   * Every child already referenced (#414): a block listed under two parents is converted
   * at its first reference only and dropped at the others, so the PM doc never holds two
   * copies of one block (BlockIdExtension would give the second a new id, and the next
   * store would keep both).
   */
  referenced: Set<BlockID>
}

/**
 * Convert Block Spec v1 to ProseMirror document
 */
export function blockDocToPM(doc: BlockDocV1, schema: Schema): PMNode {
  return blockDocToPMWithReport(doc, schema).node
}

/**
 * Convert Block Spec v1 to a ProseMirror doc, reporting the blocks that were left out.
 *
 * schema.nodeFromJSON doesn't check content expressions (#213), so every top-level
 * block (and every list child, see listItemsToPM) is built and check()ed on its own.
 * A block that fails to build or check is dropped and reported rather than failing the
 * whole doc: an editor left empty would have its next store overwrite the entire
 * working copy. Dropped blocks are hidden from the editor, NOT deleted: the collab
 * server keeps the record in `meta.dropped` and merges them back into every store
 * (restoreDroppedBlocks).
 * The doc-level `block+` rule is not checked: an empty block doc stays an empty PM doc.
 */
export function blockDocToPMWithReport(doc: BlockDocV1, schema: Schema): { node: PMNode; dropped: DroppedBlock[] } {
  const ctx: ConvertContext = { schema, dropped: [], containersInProgress: new Set(), referenced: new Set() }
  const nodes: PMNode[] = []
  let afterId: BlockID | null = null

  for (const blockId of doc.blocks_order) {
    const block = doc.blocks[blockId]
    if (!block) {
      console.warn(`Block ${blockId} not found in blocks map`)
      continue
    }
    try {
      if (ctx.referenced.has(blockId)) throw new Error(`block ${blockId} is already in the document`)
      ctx.referenced.add(blockId)
      const json = blockToPMNode(block, doc.blocks, ctx)
      if (!json) throw new Error(`no PM representation for block type ${block.type}`)
      const node = schema.nodeFromJSON(json)
      node.check()
      nodes.push(node)
    } catch (error) {
      console.warn(`Dropping block ${blockId} (${block.type}) that can't be converted to a valid node:`, error)
      ctx.dropped.push({ id: blockId, parentId: null, afterId })
    }
    afterId = blockId
  }

  return { node: schema.topNodeType.create(null, nodes), dropped: ctx.dropped }
}

/**
 * Merge the blocks blockDocToPM dropped (taken from `source`, the doc they were loaded
 * from) back into `current`, the doc mirrored from the editor, so a save never deletes
 * content the editor couldn't show. Each block goes back after its original preceding
 * sibling, or at the end if that sibling is gone; a dropped child whose list or container
 * was deleted is not restored. Blocks already in `current` are left alone.
 */
export function restoreDroppedBlocks(current: BlockDocV1, source: BlockDocV1, dropped: DroppedBlock[]): BlockDocV1 {
  if (dropped.length === 0) return current

  const blocks = { ...current.blocks }
  let order = current.blocks_order

  // Copies a block and everything under it from `source`. A block already in `current`
  // (it moved there since) is left alone, and so is everything under it, and a copied
  // parent doesn't reference it: two parents sharing a child would make the doc invalid
  // (#414, design 2.3), and so would a child that `source` lists but doesn't have. A cycle
  // in `source` ends at the block that closes it, for the same reason.
  const copyTree = (id: BlockID): boolean => {
    const block = source.blocks[id]
    if (!block || blocks[id]) return false
    blocks[id] = block
    if (Array.isArray(block.children)) {
      const kept = block.children.filter(copyTree)
      if (kept.length !== block.children.length) blocks[id] = { ...block, children: kept }
    }
    return true
  }
  const insertAfter = (siblings: BlockID[], afterId: BlockID | null, id: BlockID) => {
    const anchor = afterId === null ? -1 : siblings.indexOf(afterId)
    const at = afterId === null ? 0 : anchor === -1 ? siblings.length : anchor + 1
    return [...siblings.slice(0, at), id, ...siblings.slice(at)]
  }

  // Entries are in source order, so a run of dropped siblings is restored in order.
  for (const { id, parentId, afterId } of dropped) {
    if (blocks[id] || !source.blocks[id]) continue
    if (parentId === null) {
      copyTree(id)
      order = insertAfter(order, afterId, id)
      continue
    }
    const parent = blocks[parentId]
    if (!parent) continue
    copyTree(id)
    blocks[parentId] = { ...parent, children: insertAfter(parent.children ?? [], afterId, id) }
  }

  return { ...current, blocks_order: order, blocks }
}

/**
 * Render a Block Spec v1 doc (or a PM doc already built from one) into an editor
 * without firing TipTap's "update" event. Used by a version restore (liveRestore.ts) and
 * the static read-only view. With collaboration on, the ySyncPlugin still mirrors this
 * into Yjs regardless of emitUpdate. Returns false (and logs) if the
 * content can't be applied.
 */
export function setEditorBlockDoc(editor: Editor, doc: BlockDocV1 | PMNode): boolean {
  try {
    const node = "blocks_order" in doc ? blockDocToPM(doc, editor.schema) : doc
    editor.commands.setContent(node.toJSON(), { emitUpdate: false })
    return true
  } catch (error) {
    console.error("Failed to convert/apply blocks to editor:", error)
    return false
  }
}

/**
 * The block's colour as node attrs (#356): the block's `attrs.blockColor`, never its pm's,
 * and only a palette token. Set only when there is one, so a schema without BlockColor
 * still builds every untinted block.
 */
function colorAttrs(block: Block): { blockColor?: string } {
  const color = normalizeBlockColor((block.attrs as { blockColor?: unknown }).blockColor)
  return color ? { blockColor: color } : {}
}

function pmAttrsWithout(pm: any, ...names: string[]): Record<string, unknown> {
  const attrs = { ...(pm?.attrs ?? {}) }
  for (const name of names) delete attrs[name]
  return attrs
}

/**
 * Convert individual Block to ProseMirror node JSON
 */
function blockToPMNode(block: Block, allBlocks: Record<BlockID, Block>, ctx: ConvertContext): any {
  const baseAttrs = {
    "data-block-id": block.id, // Ensure block ID is preserved
  }

  switch (block.type) {
    case "paragraph":
      if (block.attrs.pm) {
        return {
          ...block.attrs.pm,
          attrs: { ...pmAttrsWithout(block.attrs.pm, "blockColor"), ...baseAttrs, ...colorAttrs(block) },
        }
      }
      return {
        type: "paragraph",
        attrs: { ...baseAttrs, ...colorAttrs(block) },
        content: block.attrs.text ? [{ type: "text", text: block.attrs.text }] : [],
      }

    case "heading":
      if (block.attrs.pm) {
        return {
          ...block.attrs.pm,
          attrs: {
            ...pmAttrsWithout(block.attrs.pm, "blockColor"),
            ...baseAttrs,
            level: block.attrs.level,
            ...colorAttrs(block),
          },
        }
      }
      return {
        type: "heading",
        attrs: { ...baseAttrs, level: block.attrs.level, ...colorAttrs(block) },
        content: block.attrs.text ? [{ type: "text", text: block.attrs.text }] : [],
      }

    case "blockquote": {
      // The block's `cite` wins over anything a pm node carries (see pmNodeToBlock). Set
      // only when there is one: a schema without QuoteCitation still builds the quote.
      const cite = normalizeCite(block.attrs.cite)
      const citeAttrs = cite ? { cite } : {}
      if (block.attrs.pm) {
        return {
          ...block.attrs.pm,
          attrs: { ...pmAttrsWithout(block.attrs.pm, "cite", "blockColor"), ...baseAttrs, ...citeAttrs, ...colorAttrs(block) },
        }
      }
      return {
        type: "blockquote",
        attrs: { ...baseAttrs, ...citeAttrs, ...colorAttrs(block) },
        content: [
          {
            type: "paragraph",
            content: block.attrs.text ? [{ type: "text", text: block.attrs.text }] : [],
          },
        ],
      }
    }

    case "code_block":
      return {
        type: "codeBlock",
        attrs: {
          ...baseAttrs,
          language: block.attrs.language,
        },
        content: [{ type: "text", text: block.attrs.code || "" }],
      }

    case "divider":
      return {
        type: "horizontalRule",
        attrs: baseAttrs,
      }

    case "image": {
      const caption = captionToPM(block.attrs.caption, ctx.schema)
      return {
        type: "image",
        attrs: {
          ...baseAttrs,
          src: block.attrs.src,
          alt: block.attrs.alt,
          title: block.attrs.title,
          mediaId: block.attrs.mediaId,
          // Left to the schema's default ("inline") unless it's another valid width.
          ...(isImageAlign(block.attrs.align) && block.attrs.align !== "inline" ? { align: block.attrs.align } : {}),
        },
        // No caption, no child: an image without one looks exactly as before #346.
        ...(caption.length > 0 ? { content: [{ type: "imageCaption", content: caption }] } : {}),
      }
    }

    case "bullet_list":
      return {
        type: "bulletList",
        attrs: { ...baseAttrs, ...colorAttrs(block) },
        content: listItemsToPM(block, allBlocks, ctx),
      }

    case "ordered_list":
      return {
        type: "orderedList",
        attrs: { ...baseAttrs, ...colorAttrs(block) },
        content: listItemsToPM(block, allBlocks, ctx),
      }

    case "todo_list":
      return {
        type: "taskList",
        attrs: baseAttrs,
        content: listItemsToPM(block, allBlocks, ctx),
      }

    // #419. A stored pm's own `tone` / `cite` / `checked` is ignored: the block's wins.
    // The node type is the block's, whatever the pm says.
    case "callout": {
      const tone = normalizeCalloutTone(block.attrs.tone)
      const pm = block.attrs.pm
      if (pm) return { ...pm, type: "callout", attrs: { ...pmAttrsWithout(pm, "tone"), ...baseAttrs, tone } }
      return {
        type: "callout",
        attrs: { ...baseAttrs, tone },
        content: [{ type: "paragraph", content: block.attrs.text ? [{ type: "text", text: block.attrs.text }] : [] }],
      }
    }

    case "pull_quote": {
      const cite = normalizeCite(block.attrs.cite)
      const citeAttrs = cite ? { cite } : {}
      const pm = block.attrs.pm
      if (pm) return { ...pm, type: "pullQuote", attrs: { ...pmAttrsWithout(pm, "cite"), ...baseAttrs, ...citeAttrs } }
      return {
        type: "pullQuote",
        attrs: { ...baseAttrs, ...citeAttrs },
        content: block.attrs.text ? [{ type: "text", text: block.attrs.text }] : [],
      }
    }

    case "todo_item": {
      const checked = block.attrs.checked === true
      const pm = block.attrs.pm
      if (pm) return { ...pm, type: "taskItem", attrs: { ...pmAttrsWithout(pm, "checked"), ...baseAttrs, checked } }
      return {
        type: "taskItem",
        attrs: { ...baseAttrs, checked },
        content: [{ type: "paragraph", content: block.attrs.text ? [{ type: "text", text: block.attrs.text }] : [] }],
      }
    }

    case "group": {
      const attrs = block.attrs as { style?: unknown; align?: unknown }
      return {
        type: "group",
        attrs: {
          ...baseAttrs,
          // Left to the schema's defaults unless valid.
          ...(isGroupStyle(attrs.style) ? { style: attrs.style } : {}),
          ...(isGroupAlign(attrs.align) ? { align: attrs.align } : {}),
        },
        content: containerChildrenToPM(block, allBlocks, ctx),
      }
    }

    // #421: the summary (always there; empty without runs), then the blocks.
    case "details": {
      const attrs = block.attrs as { summary?: unknown; open?: unknown }
      return {
        type: "details",
        attrs: { ...baseAttrs, ...(attrs.open === true ? { open: true } : {}) },
        content: [
          { type: "detailsSummary", ...captionContent(captionToPM(attrs.summary, ctx.schema)) },
          ...containerChildrenToPM(block, allBlocks, ctx),
        ],
      }
    }

    case "table":
      return tableBlockToPM(block, baseAttrs, ctx.schema)

    // #423. Only a valid media id and label make it into the node; the caption like an
    // image's (no child without one).
    case "video":
    case "audio": {
      const caption = captionToPM((block.attrs as { caption?: unknown }).caption, ctx.schema)
      return {
        type: block.type,
        attrs: { ...baseAttrs, ...mediaIdAttr((block.attrs as { mediaId?: unknown }).mediaId) },
        ...(caption.length > 0 ? { content: [{ type: "imageCaption", content: caption }] } : {}),
      }
    }

    case "file": {
      const attrs = block.attrs as { mediaId?: unknown; label?: unknown }
      const label = normalizeFileLabel(attrs.label)
      return { type: "file", attrs: { ...baseAttrs, ...mediaIdAttr(attrs.mediaId), ...(label ? { label } : {}) } }
    }

    case "list_item":
      if (block.attrs.pm) {
        return {
          ...block.attrs.pm,
          attrs: { ...block.attrs.pm.attrs, ...baseAttrs },
        }
      }
      return {
        type: "listItem",
        attrs: baseAttrs,
        content: [
          {
            type: "paragraph",
            content: block.attrs.text ? [{ type: "text", text: block.attrs.text }] : [],
          },
        ],
      }

    default:
      if (isThemeBlockType(block.type)) return themeBlockToPM(block, ctx.schema, baseAttrs)
      // Any other custom block (a type from before #376's namespaced theme blocks):
      // reconstruct from stored PM JSON (a stand-in keeps it, schemaWithStandIns).
      const customAttrs = block.attrs as Record<string, any>
      if (customAttrs.pm) {
        return {
          ...customAttrs.pm,
          attrs: { ...customAttrs.pm.attrs, ...baseAttrs },
        }
      }
      console.warn(`Unknown block type without PM data: ${(block as any).type}`)
      return null
  }
}

/**
 * Convert a list block's children to its item nodes' JSON (`listItem`, or `taskItem` for
 * a to-do list, #419: `LIST_ITEMS`). The schema requires `<item>+`, but
 * schema.nodeFromJSON doesn't check content expressions (#213), so each child is
 * validated on its own, and one bad item doesn't take the list with it:
 * - a paragraph child is wrapped in an item (both items start with a paragraph),
 *   keeping its text and its id;
 * - any other child that isn't a valid item of this list is dropped and reported in
 *   ctx.dropped, so restoreDroppedBlocks puts it back on save;
 * - when no item is left (none, all dangling, or all dropped), synthesize one empty
 *   item, which is what the editor itself produces for a fresh list.
 * A list that (transitively) lists itself as a child throws here, so the child that
 * closes the cycle is dropped like any other bad child instead of recursing until the
 * stack overflows.
 */
function listItemsToPM(list: Block, allBlocks: Record<BlockID, Block>, ctx: ConvertContext): any[] {
  const listId = list.id
  if (ctx.containersInProgress.has(listId)) throw new Error(`list ${listId} contains itself`)
  ctx.containersInProgress.add(listId)
  try {
    return convertListChildren(listId, list.children, listItemOf(list.type)?.node ?? "listItem", allBlocks, ctx)
  } finally {
    ctx.containersInProgress.delete(listId)
  }
}

function convertListChildren(
  listId: BlockID,
  children: BlockID[] | undefined,
  itemNode: string,
  allBlocks: Record<BlockID, Block>,
  ctx: ConvertContext,
): any[] {
  const items: any[] = []
  let afterId: BlockID | null = null

  for (const childId of children ?? []) {
    const childBlock = allBlocks[childId]
    if (!childBlock) {
      console.warn(`Child block ${childId} not found`)
      continue
    }
    try {
      if (ctx.referenced.has(childId)) throw new Error(`block ${childId} is already in the document`)
      ctx.referenced.add(childId)
      let json = blockToPMNode(childBlock, allBlocks, ctx)
      if (json?.type === "paragraph") {
        json = {
          type: itemNode,
          attrs: { "data-block-id": childId },
          content: [{ ...json, attrs: { ...json.attrs, "data-block-id": null } }],
        }
      }
      if (json?.type !== itemNode) throw new Error(`a ${childBlock.type} block can't be an item of this list`)
      ctx.schema.nodeFromJSON(json).check()
      items.push(json)
    } catch (error) {
      console.warn(`Dropping child ${childId} (${childBlock.type}) of list ${listId}:`, error)
      ctx.dropped.push({ id: childId, parentId: listId, afterId })
    }
    afterId = childId
  }

  if (items.length > 0) return items
  return [{ type: itemNode, attrs: { "data-block-id": synthesizedItemId(listId) }, content: [{ type: "paragraph" }] }]
}

/**
 * A container's children as PM node JSON (#414, design 2.5), the generalization of
 * `listItemsToPM`. Each child is built and `check()`ed on its own, and must be a type the
 * nesting table lets the container hold; one that can't be is **dropped and reported**
 * (`parentId` = the container, `afterId` = its previous sibling), and the container keeps
 * the others. `restoreDroppedBlocks` puts it back at that place on the next store.
 * A container left with fewer children than the table's minimum gets synthesized ones
 * with deterministic ids (`synthesizedChildId`), so the same doc builds the same nodes on
 * every load and the store sees no change. A container that (transitively) contains
 * itself throws, so the child that closes the cycle is dropped.
 */
function containerChildrenToPM(block: Block, allBlocks: Record<BlockID, Block>, ctx: ConvertContext): any[] {
  const rule = containerRule(block.type) as ContainerRule
  if (ctx.containersInProgress.has(block.id)) throw new Error(`${block.type} ${block.id} contains itself`)
  ctx.containersInProgress.add(block.id)
  try {
    const nodeType = ctx.schema.nodes[rule.node]
    // What may follow the container's parts (a details' summary, #421): its blocks.
    let afterParts: ContentMatch | null = nodeType?.contentMatch ?? null
    for (const part of rule.parts ?? []) afterParts = afterParts?.matchType(ctx.schema.nodes[part]) ?? null
    const items: any[] = []
    let afterId: BlockID | null = null
    for (const childId of block.children ?? []) {
      const child = allBlocks[childId]
      if (!child) {
        console.warn(`Child block ${childId} of ${block.type} ${block.id} not found`)
        continue
      }
      try {
        if (ctx.referenced.has(childId)) throw new Error(`block ${childId} is already in the document`)
        ctx.referenced.add(childId)
        if (!acceptsChild(block.type, child.type)) throw new Error(`a ${block.type} can't hold a ${child.type} block`)
        const json = blockToPMNode(child, allBlocks, ctx)
        if (!json) throw new Error(`no PM representation for block type ${child.type}`)
        const node = ctx.schema.nodeFromJSON(json)
        node.check()
        if (nodeType && !afterParts?.matchType(node.type)) throw new Error(`a ${rule.node} can't hold a ${node.type.name}`)
        items.push(json)
      } catch (error) {
        console.warn(`Dropping child ${childId} (${child.type}) of ${block.type} ${block.id}:`, error)
        ctx.dropped.push({ id: childId, parentId: block.id, afterId })
      }
      afterId = childId
    }
    for (let index = items.length; index < rule.min; index++) {
      const role = index === 0 ? rule.synthesize.role : `${rule.synthesize.role}-${index + 1}`
      items.push({ type: BLOCK_NODE_NAMES[rule.synthesize.type], attrs: { "data-block-id": synthesizedChildId(block.id, role) } })
    }
    return items
  } finally {
    ctx.containersInProgress.delete(block.id)
  }
}

/**
 * Id for the listItem synthesized into an empty list. Derived from the list id, NOT
 * random: BlockIdExtension only stamps top-level nodes, so an item without an id would
 * be re-minted by pmToBlockDoc on every store, and the stored block_doc would change
 * each time. The suffix alone is 10 characters, so the id always passes
 * pmToBlockDoc's length >= 10 check, however short the list id is.
 */
export function synthesizedItemId(listId: BlockID): BlockID {
  return `${listId}-list-item`
}

/**
 * A copy of `node` in which every node that is a block (`isBlockNode`, any depth) has a
 * valid, unique `data-block-id`: missing, shorter than 10 characters, or a duplicate of an
 * earlier one (document order) gets a new one. `node` itself is returned when nothing
 * changes. The same rule as BlockIdExtension and `stampFragmentBlockIds`.
 */
export function stampBlockIds(node: PMNode, _schema?: Schema): PMNode {
  const used = new Set<BlockID>()
  const stamp = (parent: PMNode, parentName: string | null): PMNode => {
    if (parent.isTextblock) return parent
    let changed = false
    const children: PMNode[] = []
    parent.forEach((child) => {
      let next = child
      if (isBlockNode(child.type.name, parentName)) {
        const id = child.attrs["data-block-id"]
        if (typeof id === "string" && id.length >= 10 && !used.has(id)) used.add(id)
        else if (child.type.spec.attrs && "data-block-id" in child.type.spec.attrs) {
          let fresh = generateId()
          while (used.has(fresh)) fresh = generateId()
          used.add(fresh)
          next = child.type.create({ ...child.attrs, "data-block-id": fresh }, child.content, child.marks)
        }
      }
      next = stamp(next, next.type.name)
      if (next !== child) changed = true
      children.push(next)
    })
    return changed ? parent.type.create(parent.attrs, children, parent.marks) : parent
  }
  return stamp(node, null)
}
