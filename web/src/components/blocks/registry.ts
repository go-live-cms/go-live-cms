import type { BlockConfig, BlockComponent } from "./types"

/**
 * Block Registry
 * Central registry for all block types and their configurations
 * WordPress-style architecture with auto-discovery
 */
class BlockRegistry {
  private blocks: Map<string, BlockConfig> = new Map()

  /**
   * Register a new block type
   */
  register(config: BlockConfig): void {
    if (this.blocks.has(config.type)) {
      // Silently skip duplicates instead of overwriting
      return
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
   * Register a block dynamically at runtime from a module
   */
  async registerFromModule(modulePath: string): Promise<void> {
    try {
      const module = await import(/* @vite-ignore */ modulePath)
      const config = module.default || module.alertConfig
      if (config) {
        this.register(config)
        console.log(`[Block Registry] Dynamically registered: ${config.type}`)
      }
    } catch (error) {
      console.error(`[Block Registry] Failed to load block from ${modulePath}:`, error)
    }
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

// Auto-register system blocks using Vite glob imports
const systemBlockModules = import.meta.glob<{ default: BlockConfig }>("./*/index.ts", {
  eager: true,
})

console.log("[Block Registry] System block paths:", Object.keys(systemBlockModules))

Object.values(systemBlockModules).forEach((module) => {
  blockRegistry.register(module.default)
})

// Log registered blocks for verification
console.log(
  `[Block Registry] Registered ${blockRegistry.getAll().length} system blocks:`,
  blockRegistry.getTypes().join(", ")
)

// Export function to load theme blocks dynamically
export async function registerThemeBlocks(themeSlug: string, blocks?: Array<{ type: string; modulePath: string }>) {
  if (!blocks || blocks.length === 0) {
    console.log(`[Block Registry] No custom blocks for theme: ${themeSlug}`)
    return
  }

  console.log(`[Block Registry] Loading ${blocks.length} blocks for theme: ${themeSlug}`)

  // Dynamic import of editor block registry (only in client-side context)
  let editorBlockRegistry: any
  try {
    const editorModule = await import("../../../gl-admin/components/editor/blocks/index")
    editorBlockRegistry = editorModule.editorBlockRegistry
  } catch (e) {
    console.log("[Block Registry] Editor block registry not available (SSR context)")
  }

  for (const block of blocks) {
    // Register SSR block
    await blockRegistry.registerFromModule(block.modulePath)

    // Register editor block (if in client context)
    if (editorBlockRegistry) {
      try {
        const module = await import(/* @vite-ignore */ block.modulePath)
        const editorConfig = module.alertEditorConfig || module.editorConfig
        if (editorConfig) {
          editorBlockRegistry.register(editorConfig)
          console.log(`[Editor Block Registry] Registered: ${editorConfig.title}`)
        }
      } catch (error) {
        console.error(`[Editor Block Registry] Failed to load editor config from ${block.modulePath}:`, error)
      }
    }
  }

  console.log(
    `[Block Registry] Total blocks after theme load: ${blockRegistry.getAll().length}`,
    blockRegistry.getTypes().join(", ")
  )
}

export default blockRegistry
