import * as Y from "yjs"
import type { BlockDocV1, Block, BlockID } from "../blocks-spec"

// Simple ID generator - can be replaced with ulid later
function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  // Fallback for environments without crypto.randomUUID
  return Math.random().toString(36).substring(2) + Date.now().toString(36)
}

/**
 * Manages Block Spec v1 documents in Yjs
 * Provides atomic operations on blocks and maintains document integrity
 */
export class BlockDocManager {
  private doc: Y.Doc
  private blocksOrder: Y.Array<BlockID>
  private blocks: Y.Map<Y.Map<any>>

  constructor(doc: Y.Doc) {
    this.doc = doc
    this.blocksOrder = doc.getArray<BlockID>("blocks_order")
    this.blocks = doc.getMap<Y.Map<any>>("blocks")
  }

  /**
   * Initialize document with empty paragraph if empty
   */
  initializeDoc(): void {
    if (this.blocksOrder.length === 0) {
      const initialBlockId = generateId()
      const initialBlock: Block = {
        id: initialBlockId,
        type: "paragraph",
        version: 1,
        attrs: { text: "" },
      }

      this.setBlock(initialBlock)
      this.blocksOrder.push([initialBlockId])
    }
  }

  setBlock(block: Block): void {
    const blockMap = new Y.Map()
    blockMap.set("id", block.id)
    blockMap.set("type", block.type)
    blockMap.set("version", block.version)
    blockMap.set("attrs", block.attrs)

    if (block.children && block.children.length > 0) {
      blockMap.set("children", block.children)
    }

    this.blocks.set(block.id, blockMap)
  }

  getBlock(blockId: BlockID): Block | null {
    const blockMap = this.blocks.get(blockId)
    if (!blockMap) return null

    return {
      id: blockMap.get("id"),
      type: blockMap.get("type"),
      version: blockMap.get("version"),
      attrs: blockMap.get("attrs"),
      children: blockMap.get("children"),
    }
  }

  deleteBlock(blockId: BlockID): void {
    this.blocks.delete(blockId)

    const orderArray = this.blocksOrder.toArray()
    const index = orderArray.indexOf(blockId)
    if (index !== -1) {
      this.blocksOrder.delete(index, 1)
    }

    this.blocks.forEach((blockMap, id) => {
      const children = blockMap.get("children")
      if (children && Array.isArray(children)) {
        const childIndex = children.indexOf(blockId)
        if (childIndex !== -1) {
          const newChildren = [...children]
          newChildren.splice(childIndex, 1)
          blockMap.set("children", newChildren)
        }
      }
    })
  }

  /**
   * Insert block at specific position in order
   */
  insertBlockAtPosition(block: Block, position: number): void {
    this.setBlock(block)
    this.blocksOrder.insert(position, [block.id])
  }

  /**
   * Move block to new position
   */
  moveBlock(blockId: BlockID, newPosition: number): void {
    const currentOrder = this.blocksOrder.toArray()
    const currentIndex = currentOrder.indexOf(blockId)

    if (currentIndex === -1) return // Block not found

    // Remove from current position
    this.blocksOrder.delete(currentIndex, 1)

    // Insert at new position (adjust if moving forward)
    const adjustedPosition = currentIndex < newPosition ? newPosition - 1 : newPosition
    this.blocksOrder.insert(adjustedPosition, [blockId])
  }

  /**
   * Update blocks order completely
   */
  setBlocksOrder(order: BlockID[]): void {
    // Clear existing order
    this.blocksOrder.delete(0, this.blocksOrder.length)
    // Set new order
    this.blocksOrder.insert(0, order)
  }

  /**
   * Get current BlockDocV1 representation
   */
  getBlockDocV1(): BlockDocV1 {
    const blocks: Record<BlockID, Block> = {}

    this.blocks.forEach((blockMap, blockId) => {
      const block: Block = {
        id: blockMap.get("id"),
        type: blockMap.get("type"),
        version: blockMap.get("version"),
        attrs: blockMap.get("attrs") || {},
      }

      const children = blockMap.get("children")
      if (children && Array.isArray(children) && children.length > 0) {
        block.children = children
      }

      blocks[blockId] = block
    })

    return {
      doc_version: 1,
      blocks_order: this.blocksOrder.toArray(),
      blocks,
    }
  }

  /**
   * Set complete BlockDocV1 (replaces entire document)
   */
  setBlockDocV1(doc: BlockDocV1): void {
    this.doc.transact(() => {
      // Clear existing content
      this.blocksOrder.delete(0, this.blocksOrder.length)
      this.blocks.clear()

      // Set new content
      this.blocksOrder.insert(0, doc.blocks_order)

      Object.values(doc.blocks).forEach((block) => {
        this.setBlock(block)
      })
    })
  }

  /**
   * Get top-level blocks in order
   */
  getTopLevelBlocks(): Block[] {
    return this.blocksOrder
      .toArray()
      .map((blockId) => this.getBlock(blockId))
      .filter((block): block is Block => block !== null)
  }

  /**
   * Get all blocks as a flat array
   */
  getAllBlocks(): Block[] {
    const blocks: Block[] = []

    this.blocks.forEach((blockMap, blockId) => {
      const block = this.getBlock(blockId)
      if (block) {
        blocks.push(block)
      }
    })

    return blocks
  }

  /**
   * Subscribe to changes in the document
   */
  onDocumentChange(callback: (doc: BlockDocV1) => void): () => void {
    const handler = () => {
      callback(this.getBlockDocV1())
    }

    // Listen to changes on both blocks and order
    this.blocks.observe(handler)
    this.blocksOrder.observe(handler)

    // Return cleanup function
    return () => {
      this.blocks.unobserve(handler)
      this.blocksOrder.unobserve(handler)
    }
  }

  /**
   * Generate a new block ID
   */
  generateBlockId(): BlockID {
    return generateId()
  }

  /**
   * Debug: Log current state
   */
  debugLog(): void {
    console.log("BlockDoc Debug:")
    console.log("Order:", this.blocksOrder.toArray())
    console.log("Blocks:", this.getBlockDocV1().blocks)
  }
}
