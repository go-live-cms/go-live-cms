import { Node as PMNode, Schema } from "prosemirror-model"
import {
  BLOCKQUOTE_BLOCK_VERSION,
  captionRuns,
  IMAGE_BLOCK_VERSION,
  isImageAlign,
  normalizeCite,
  type BlockDocV1,
  type Block,
  type BlockID,
  type CaptionText,
} from "../blocks-spec"
import type { Editor } from "@tiptap/core"

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

  // Iterate through top-level nodes
  for (let i = 0; i < pmDoc.content.childCount; i++) {
    const node = pmDoc.content.child(i)
    const isList = node.type.name === "bulletList" || node.type.name === "orderedList"

    // A list with no items can only come from an already schema-invalid PM node
    // (the schema requires `listItem+`; nodeFromJSON doesn't enforce it). It holds
    // no content, so skip it rather than persist a childless list block (#213).
    if (isList && node.childCount === 0) continue

    const block = pmNodeToBlock(node, blocks, seenIds)
    if (!block) continue

    if (isList) {
      blocksOrder.push(block.id)
      seenIds.add(block.id)

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
      continue
    }

    blocks[block.id] = block
    blocksOrder.push(block.id)
    seenIds.add(block.id)
  }

  return {
    doc_version: 1,
    blocks_order: blocksOrder,
    blocks,
  }
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

  switch (node.type.name) {
    case "paragraph":
      return {
        id,
        type: "paragraph",
        version: 1,
        attrs: {
          pm: node.toJSON(),
          text: node.textContent || undefined,
        },
      }

    case "heading":
      return {
        id,
        type: "heading",
        version: 1,
        attrs: {
          level: node.attrs.level as 1 | 2 | 3 | 4 | 5 | 6,
          pm: node.toJSON(),
          text: node.textContent || undefined,
        },
      }

    case "blockquote": {
      // `cite` is the block's attr, not the pm node's: the stored pm stays what it was
      // before #346, and a pm `cite` can't disagree with it.
      const pm = node.toJSON()
      const { cite, ...pmAttrs } = pm.attrs ?? {}
      return {
        id,
        type: "blockquote",
        version: BLOCKQUOTE_BLOCK_VERSION,
        attrs: {
          pm: { ...pm, attrs: pmAttrs },
          text: node.textContent || undefined,
          cite: normalizeCite(cite) ?? undefined,
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
        attrs: {},
        // children will be set by caller
      }

    case "orderedList":
      return {
        id,
        type: "ordered_list",
        version: 1,
        attrs: {},
        // children will be set by caller
      }

    case "listItem":
      return {
        id,
        type: "list_item",
        version: 1,
        attrs: {
          pm: node.toJSON(),
          text: node.textContent || undefined,
        },
      }

    default:
      // Custom/theme block - preserve full PM data for round-trip fidelity
      return {
        id,
        type: node.type.name,
        version: 1,
        attrs: {
          pm: node.toJSON(),
          text: node.textContent || undefined,
          // Preserve custom attributes (variant, message, etc.)
          ...Object.fromEntries(Object.entries(node.attrs).filter(([key]) => key !== "data-block-id")),
        },
      }
  }
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
 * Calls `visit` for `rootId` and each block under it (list children, any depth) in
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
  /** The list a dropped list child belonged to; null for a top-level block. */
  parentId: BlockID | null
  /** The preceding sibling in the source doc (dropped or not); null if it was first. */
  afterId: BlockID | null
}

interface ConvertContext {
  schema: Schema
  dropped: DroppedBlock[]
  /** Lists currently being converted, to catch a list that (transitively) contains itself. */
  listsInProgress: Set<BlockID>
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
  const ctx: ConvertContext = { schema, dropped: [], listsInProgress: new Set() }
  const nodes: PMNode[] = []
  let afterId: BlockID | null = null

  for (const blockId of doc.blocks_order) {
    const block = doc.blocks[blockId]
    if (!block) {
      console.warn(`Block ${blockId} not found in blocks map`)
      continue
    }
    try {
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
 * sibling, or at the end if that sibling is gone; a dropped list child whose list was
 * deleted is not restored. Blocks already in `current` are left alone.
 */
export function restoreDroppedBlocks(current: BlockDocV1, source: BlockDocV1, dropped: DroppedBlock[]): BlockDocV1 {
  if (dropped.length === 0) return current

  const blocks = { ...current.blocks }
  let order = current.blocks_order

  // A block already in `current` is left alone, and so is everything under it.
  const copyTree = (id: BlockID) =>
    walkBlockTree(source, id, (block) => {
      if (blocks[block.id]) return false
      blocks[block.id] = block
    })
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
          attrs: { ...block.attrs.pm.attrs, ...baseAttrs },
        }
      }
      return {
        type: "paragraph",
        attrs: baseAttrs,
        content: block.attrs.text ? [{ type: "text", text: block.attrs.text }] : [],
      }

    case "heading":
      if (block.attrs.pm) {
        return {
          ...block.attrs.pm,
          attrs: {
            ...block.attrs.pm.attrs,
            ...baseAttrs,
            level: block.attrs.level,
          },
        }
      }
      return {
        type: "heading",
        attrs: { ...baseAttrs, level: block.attrs.level },
        content: block.attrs.text ? [{ type: "text", text: block.attrs.text }] : [],
      }

    case "blockquote": {
      // The block's `cite` wins over anything a pm node carries (see pmNodeToBlock). Set
      // only when there is one: a schema without QuoteCitation still builds the quote.
      const cite = normalizeCite(block.attrs.cite)
      const citeAttrs = cite ? { cite } : {}
      if (block.attrs.pm) {
        const { cite: _pmCite, ...pmAttrs } = block.attrs.pm.attrs ?? {}
        return {
          ...block.attrs.pm,
          attrs: { ...pmAttrs, ...baseAttrs, ...citeAttrs },
        }
      }
      return {
        type: "blockquote",
        attrs: { ...baseAttrs, ...citeAttrs },
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
        attrs: baseAttrs,
        content: listItemsToPM(block.id, block.children, allBlocks, ctx),
      }

    case "ordered_list":
      return {
        type: "orderedList",
        attrs: baseAttrs,
        content: listItemsToPM(block.id, block.children, allBlocks, ctx),
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
      // Custom/theme block - reconstruct from stored PM JSON
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
 * Convert a list block's children to PM listItem JSON. The schema requires
 * `listItem+`, but schema.nodeFromJSON doesn't check content expressions (#213), so
 * each child is validated on its own, and one bad item doesn't take the list with it:
 * - a paragraph child is wrapped in a listItem (listItem content is `paragraph block*`),
 *   keeping its text and its id;
 * - any other child that isn't a valid listItem is dropped and reported in ctx.dropped,
 *   so restoreDroppedBlocks puts it back on save;
 * - when no item is left (none, all dangling, or all dropped), synthesize one empty
 *   listItem, which is what the editor itself produces for a fresh list.
 * A list that (transitively) lists itself as a child throws here, so the child that
 * closes the cycle is dropped like any other bad child instead of recursing until the
 * stack overflows.
 */
function listItemsToPM(
  listId: BlockID,
  children: BlockID[] | undefined,
  allBlocks: Record<BlockID, Block>,
  ctx: ConvertContext,
): any[] {
  if (ctx.listsInProgress.has(listId)) throw new Error(`list ${listId} contains itself`)
  ctx.listsInProgress.add(listId)
  try {
    return convertListChildren(listId, children, allBlocks, ctx)
  } finally {
    ctx.listsInProgress.delete(listId)
  }
}

function convertListChildren(
  listId: BlockID,
  children: BlockID[] | undefined,
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
      let json = blockToPMNode(childBlock, allBlocks, ctx)
      if (json?.type === "paragraph") {
        json = {
          type: "listItem",
          attrs: { "data-block-id": childId },
          content: [{ ...json, attrs: { ...json.attrs, "data-block-id": null } }],
        }
      }
      if (json?.type !== "listItem") throw new Error(`a ${childBlock.type} block can't be a list item`)
      ctx.schema.nodeFromJSON(json).check()
      items.push(json)
    } catch (error) {
      console.warn(`Dropping child ${childId} (${childBlock.type}) of list ${listId}:`, error)
      ctx.dropped.push({ id: childId, parentId: listId, afterId })
    }
    afterId = childId
  }

  if (items.length > 0) return items
  return [{ type: "listItem", attrs: { "data-block-id": synthesizedItemId(listId) }, content: [{ type: "paragraph" }] }]
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
 * Update ProseMirror nodes with stable block IDs
 * This mutates the document to add data-block-id attrs where missing
 */
export function stampBlockIds(node: PMNode, schema: Schema): PMNode {
  let hasChanges = false
  const newContent: PMNode[] = []

  node.content.forEach((child, offset, index) => {
    const currentId = child.attrs["data-block-id"]

    if (!currentId || typeof currentId !== "string" || currentId.length < 10) {
      // Need to add block ID
      const newId = generateId()
      const newAttrs = { ...child.attrs, "data-block-id": newId }
      const newChild = child.type.create(newAttrs, child.content, child.marks)
      newContent.push(newChild)
      hasChanges = true
    } else {
      newContent.push(child)
    }
  })

  if (hasChanges) {
    return node.type.create(node.attrs, newContent, node.marks)
  }

  return node
}
