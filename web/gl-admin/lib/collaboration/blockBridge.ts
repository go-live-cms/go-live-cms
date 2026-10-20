import { Node as PMNode, Schema } from "prosemirror-model"
import type { BlockDocV1, Block, BlockID } from "../blocks-spec"
import type { Editor } from "@tiptap/core"

// Simple ID generator - matches BlockDocManager
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

    case "blockquote":
      return {
        id,
        type: "blockquote",
        version: 1,
        attrs: {
          pm: node.toJSON(),
          text: node.textContent || undefined,
        },
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
        version: 1,
        attrs: {
          src: node.attrs.src || undefined,
          alt: node.attrs.alt || undefined,
          title: node.attrs.title || undefined,
          mediaId: node.attrs.mediaId ?? undefined,
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
 * whole doc: if setEditorBlockDoc fails, initialize() has already seeded the block
 * maps, the editor stays empty, and the next autosave would overwrite the entire
 * working copy. Dropped blocks are hidden from the editor, NOT deleted:
 * BlockPersistenceManager merges them back into every save (restoreDroppedBlocks).
 * The doc-level `block+` rule is not checked: an empty block doc stays an empty PM doc.
 */
export function blockDocToPMWithReport(doc: BlockDocV1, schema: Schema): { node: PMNode; dropped: DroppedBlock[] } {
  const ctx: ConvertContext = { schema, dropped: [] }
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

  const copyTree = (id: BlockID) => {
    const block = source.blocks[id]
    if (!block || blocks[id]) return
    blocks[id] = block
    block.children?.forEach(copyTree)
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
 * without firing TipTap's "update" event. Shared by BlockPersistenceManager.initialize
 * (collab seed) and the read-only editor view. With collaboration on, the ySyncPlugin
 * still mirrors this into Yjs regardless of emitUpdate. Returns false (and logs) if the
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

    case "blockquote":
      if (block.attrs.pm) {
        return {
          ...block.attrs.pm,
          attrs: { ...block.attrs.pm.attrs, ...baseAttrs },
        }
      }
      return {
        type: "blockquote",
        attrs: baseAttrs,
        content: [
          {
            type: "paragraph",
            content: block.attrs.text ? [{ type: "text", text: block.attrs.text }] : [],
          },
        ],
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

    case "image":
      return {
        type: "image",
        attrs: {
          ...baseAttrs,
          src: block.attrs.src,
          alt: block.attrs.alt,
          title: block.attrs.title,
          mediaId: block.attrs.mediaId,
        },
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
 */
function listItemsToPM(
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
 * be re-minted by pmToBlockDoc on every save and setBlockDocV1 would churn Yjs each
 * time (rule 2). The suffix alone is 10 characters, so the id always passes
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
