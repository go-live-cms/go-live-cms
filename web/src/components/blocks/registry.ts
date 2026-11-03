import type { BlockConfig, BlockComponent } from "./types"
// Browser-safe: the admin loads this module too (ThemeContext).
import { log } from "../../lib/log"

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
      // Look for: default export, or named export matching <type>Config pattern
      const config = module.default || Object.values(module).find((exp: any) => exp?.type && exp?.component)
      if (config) {
        this.register(config)
        log.debug("block_registered", { type: config.type })
      }
    } catch (error) {
      log.error("block_module_load_failed", { module: modulePath, error })
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

Object.values(systemBlockModules).forEach((module) => {
  blockRegistry.register(module.default)
})

// One line at module load, and only in dev (#378).
log.debug("system_blocks_registered", { count: blockRegistry.getAll().length, types: blockRegistry.getTypes() })

// Export function to load theme blocks dynamically
export async function registerThemeBlocks(themeSlug: string, blocks?: Array<{ type: string; modulePath: string }>) {
  if (!blocks || blocks.length === 0) {
    return
  }

  // Dynamic import of editor block registry (only in client-side context)
  let editorBlockRegistry: any
  try {
    const editorModule = await import("../../../gl-admin/components/editor/blocks/index")
    editorBlockRegistry = editorModule.editorBlockRegistry
  } catch (e) {
    // SSR context: there is no editor registry.
  }

  for (const block of blocks) {
    // Register SSR block
    await blockRegistry.registerFromModule(block.modulePath)

    // Register editor block (if in client context)
    if (editorBlockRegistry) {
      try {
        const module = await import(/* @vite-ignore */ block.modulePath)
        // Look for: named export matching <type>EditorConfig, or generic 'editorConfig'
        const editorConfig =
          module[`${block.type}EditorConfig`] ||
          module.editorConfig ||
          Object.values(module).find((exp: any) => exp?.title && exp?.command)
        if (editorConfig) {
          editorBlockRegistry.register(editorConfig)
        }
      } catch (error) {
        log.error("editor_block_config_load_failed", { module: block.modulePath, error })
      }
    }
  }

  log.debug("theme_blocks_registered", { theme: themeSlug, count: blockRegistry.getAll().length, types: blockRegistry.getTypes() })
}

export default blockRegistry
