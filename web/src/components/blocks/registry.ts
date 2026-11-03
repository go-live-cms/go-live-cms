import type { BlockConfig, BlockComponent } from "./types"
import { blockPathParts, installedThemeBlocks, type InstalledThemeBlock } from "@gl-admin/lib/theme-blocks/installed"
// Browser-safe: the admin loads this module too (the revision preview renders blocks).
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

// Theme blocks (#376): every installed theme block's public renderer
// (themes/<slug>/blocks/<Name>/render.tsx), resolved when the image is built, like the
// system blocks above. Registered whichever theme is active, so a post keeps its theme
// blocks when the site switches themes; a block of a theme that isn't in this build
// renders nothing (BlockRenderer).
const themeRenderers = import.meta.glob<{ default?: BlockComponent }>("../../../themes/*/blocks/*/render.tsx", {
  eager: true,
})

/**
 * The BlockConfigs for `renderers` (a glob of the blocks' render.tsx): each must sit next
 * to an installed definition (index.ts) and default-export a component. Throws otherwise;
 * themeBlocks.loadable.test.ts runs it over the repository's themes.
 */
export function themeBlockConfigs(
  renderers: Record<string, { default?: BlockComponent }>,
  definitions: InstalledThemeBlock[] = installedThemeBlocks,
): BlockConfig[] {
  return Object.entries(renderers).map(([path, module]) => {
    const parts = blockPathParts(path)
    const definition = parts && definitions.find((d) => d.dir === `${parts.slug}/${parts.dir}`)
    if (!definition) throw new Error(`theme block ${path}: no index.ts definition in the same directory`)
    if (typeof module.default !== "function") throw new Error(`theme block ${path}: render.tsx must default-export a component`)
    return {
      type: definition.type,
      version: definition.version,
      name: definition.title,
      category: "design",
      icon: "",
      component: module.default,
    }
  })
}

themeBlockConfigs(themeRenderers).forEach((config) => blockRegistry.register(config))

export default blockRegistry