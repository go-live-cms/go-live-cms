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

/** Order-independent deep equality for JSON-ish block attrs/children values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false
  }
  const aIsArr = Array.isArray(a)
  const bIsArr = Array.isArray(b)
  if (aIsArr || bIsArr) {
    if (!aIsArr || !bIsArr || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  const aKeys = Object.keys(a as Record<string, unknown>)
  const bKeys = Object.keys(b as Record<string, unknown>)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false
    }
  }
  return true
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
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
    if (this.blocksOrder.length === 0 && this.blocks.size === 0) {
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
   * Set complete BlockDocV1, applying only the DIFFERENCES against the current
   * state. Identical content produces zero Yjs mutations (so the transaction emits
   * no update — no WS broadcast, no LevelDB write, no observer fire).
   *
   * This replaces an earlier implementation that cleared and recreated every block
   * on every call. That churn — combined with the (now-removed) handleDocumentChange
   * autosave trigger — formed the 2s WS-restart "heartbeat" loop: each save rebuilt
   * the whole map, the server echoed it back on resync, and the echo re-triggered
   * a save. Diffing keeps the mirror cheap and makes a no-op save truly a no-op.
   */
  setBlockDocV1(doc: BlockDocV1): void {
    this.doc.transact(() => {
      // 1) Remove blocks that are no longer present.
      const targetIds = new Set(Object.keys(doc.blocks))
      for (const existingId of Array.from(this.blocks.keys())) {
        if (!targetIds.has(existingId)) {
          this.blocks.delete(existingId)
        }
      }

      // 2) Upsert blocks: create new ones, update changed fields in place, skip
      //    unchanged ones (so identical blocks emit nothing).
      for (const block of Object.values(doc.blocks)) {
        this.upsertBlock(block)
      }

      // 3) Replace the order array only when it actually differs.
      if (!arraysEqual(this.blocksOrder.toArray(), doc.blocks_order)) {
        this.blocksOrder.delete(0, this.blocksOrder.length)
        this.blocksOrder.insert(0, doc.blocks_order)
      }
    })
  }

  /**
   * Insert a new block, or update an existing one in place touching only the
   * fields that actually changed. Updating in place (rather than replacing the
   * whole Y.Map) is what keeps unchanged saves from generating Yjs churn.
   */
  private upsertBlock(block: Block): void {
    const existing = this.blocks.get(block.id)
    if (!existing) {
      this.setBlock(block)
      return
    }

    if (existing.get("type") !== block.type) existing.set("type", block.type)
    if (existing.get("version") !== block.version) existing.set("version", block.version)
    if (!deepEqual(existing.get("attrs"), block.attrs)) existing.set("attrs", block.attrs)

    const nextChildren = block.children && block.children.length > 0 ? block.children : undefined
    const curChildren = (existing.get("children") as string[] | undefined) ?? undefined
    if (!deepEqual(curChildren, nextChildren)) {
      if (nextChildren) existing.set("children", nextChildren)
      else if (existing.has("children")) existing.delete("children")
    }
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
