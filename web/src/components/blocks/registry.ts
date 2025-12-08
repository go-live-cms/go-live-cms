import type { BlockConfig, BlockComponent } from "./types"
import {
  paragraphConfig,
  headingConfig,
  blockquoteConfig,
  codeBlockConfig,
  dividerConfig,
  imageConfig,
  bulletListConfig,
  orderedListConfig,
} from "./components"

/**
 * Block Registry
 * Central registry for all block types and their configurations
 * WordPress-style architecture for easy extensibility
 */
class BlockRegistry {
  private blocks: Map<string, BlockConfig> = new Map()

  /**
   * Register a new block type
   */
  register(config: BlockConfig): void {
    if (this.blocks.has(config.type)) {
      console.warn(`Block type "${config.type}" is already registered. Overwriting.`)
    }
    this.blocks.set(config.type, config)
  }

  /**
   * Unregister a block type
   */
  unregister(type: string): boolean {
    return this.blocks.delete(type)
  }

  /**
   * Get a block configuration by type
   */
  get(type: string): BlockConfig | undefined {
    return this.blocks.get(type)
  }

  /**
   * Get the component for a block type
   */
  getComponent(type: string): BlockComponent | undefined {
    return this.blocks.get(type)?.component
  }

  /**
   * Check if a block type is registered
   */
  has(type: string): boolean {
    return this.blocks.has(type)
  }

  /**
   * Get all registered block types
   */
  getAll(): BlockConfig[] {
    return Array.from(this.blocks.values())
  }

  /**
   * Get all registered block type names
   */
  getTypes(): string[] {
    return Array.from(this.blocks.keys())
  }
}

// Create singleton instance
export const blockRegistry = new BlockRegistry()

// Register all built-in block types
blockRegistry.register(paragraphConfig)
blockRegistry.register(headingConfig)
blockRegistry.register(blockquoteConfig)
blockRegistry.register(codeBlockConfig)
blockRegistry.register(dividerConfig)
blockRegistry.register(imageConfig)
blockRegistry.register(bulletListConfig)
blockRegistry.register(orderedListConfig)

export default blockRegistry
