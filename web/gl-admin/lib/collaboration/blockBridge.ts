import { Node as PMNode, Schema } from "prosemirror-model"
import type { BlockDocV1, Block, BlockID } from "../blocks-spec"

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
    const block = pmNodeToBlock(node, blocks, seenIds)
    if (block) {
      blocks[block.id] = block
      blocksOrder.push(block.id)
      seenIds.add(block.id)

      // Handle list children
      if ((block.type === "bullet_list" || block.type === "ordered_list") && node.content && node.content.size > 0) {
        const children: BlockID[] = []

        // Iterate through list items
        for (let j = 0; j < node.content.childCount; j++) {
          const listItemNode = node.content.child(j)
          const listItemBlock = pmNodeToBlock(listItemNode, blocks, seenIds)
          if (listItemBlock) {
            blocks[listItemBlock.id] = listItemBlock
            children.push(listItemBlock.id)
            seenIds.add(listItemBlock.id)
          }
        }

        // Update the list block with children
        if (children.length > 0) {
          blocks[block.id] = { ...block, children }
        }
      }
    }
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
          mediaId: node.attrs.mediaId || undefined,
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
 * Convert Block Spec v1 to ProseMirror document
 */
export function blockDocToPM(doc: BlockDocV1, schema: Schema): PMNode {
  // Convert blocks back to ProseMirror JSON, then parse
  const pmJSON = {
    type: "doc",
    content: doc.blocks_order
      .map((blockId) => {
        const block = doc.blocks[blockId]
        if (!block) {
          console.warn(`Block ${blockId} not found in blocks map`)
          return null
        }
        return blockToPMNode(block, doc.blocks)
      })
      .filter(Boolean), // Remove nulls
  }

  return schema.nodeFromJSON(pmJSON)
}

/**
 * Convert individual Block to ProseMirror node JSON
 */
function blockToPMNode(block: Block, allBlocks: Record<BlockID, Block>): any {
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
        content:
          block.children
            ?.map((childId) => {
              const childBlock = allBlocks[childId]
              if (!childBlock) {
                console.warn(`Child block ${childId} not found`)
                return null
              }
              return blockToPMNode(childBlock, allBlocks)
            })
            .filter(Boolean) || [],
      }

    case "ordered_list":
      return {
        type: "orderedList",
        attrs: baseAttrs,
        content:
          block.children
            ?.map((childId) => {
              const childBlock = allBlocks[childId]
              if (!childBlock) {
                console.warn(`Child block ${childId} not found`)
                return null
              }
              return blockToPMNode(childBlock, allBlocks)
            })
            .filter(Boolean) || [],
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
