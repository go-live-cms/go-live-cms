import type { SlashCommandItem } from "../ui/SlashCommand"
import type { CommandSelectOption } from "@gl-admin/components/editor/ui/CommandSelect"
import { headingBlocks } from "./headingBlocks"
import { listBlocks } from "./listBlocks"
import { textBlocks } from "./textBlocks"
import { createMediaBlocks } from "./mediaBlocks"

export type Block = {
  title: string
  icon: string
  description: string
  aliases: string[]
  command: ({ editor, range }: any) => void
  turnInto?: ({ editor }: any) => void
}

/**
 * Editor Block Registry
 * Dynamic registry for slash command blocks
 */
class EditorBlockRegistry {
  private blocks: Block[] = []
  private initialized = false

  initialize() {
    if (this.initialized) return
    // Register system blocks
    this.blocks = [...headingBlocks, ...listBlocks, ...textBlocks, ...createMediaBlocks()]
    this.initialized = true
    console.log(`[Editor Block Registry] Initialized with ${this.blocks.length} system blocks`)
  }

  register(block: Block) {
    // Check for duplicates
    if (this.blocks.some(b => b.title === block.title)) {
      return
    }
    this.blocks.push(block)
    console.log(`[Editor Block Registry] Registered: ${block.title}`)
  }

  getAll(): Block[] {
    if (!this.initialized) this.initialize()
    return this.blocks
  }

  clear() {
    this.blocks = []
    this.initialized = false
  }
}

// Singleton instance
const editorBlockRegistry = new EditorBlockRegistry()

// Initialize on module load
editorBlockRegistry.initialize()

// Export registry for theme block registration
export { editorBlockRegistry }

export const getAllBlocks = (): Block[] => {
  return editorBlockRegistry.getAll()
}

export const getSlashCommandItems = (): SlashCommandItem[] => {
  return getAllBlocks()
    .filter((cmd) => cmd.command)
    .map((cmd) => ({
      title: cmd.title,
      icon: cmd.icon,
      description: cmd.description,
      aliases: cmd.aliases,
      command: cmd.command,
    }))
}

export const getTurnIntoCommandOptions = (): CommandSelectOption[] => {
  return getAllBlocks()
    .filter((cmd) => cmd.turnInto)
    .map((cmd) => ({
      label: cmd.title,
      label_icon: cmd.icon,
      value: cmd.title.toLowerCase().replace(/\s+/g, "-"),
      command: cmd.turnInto,
    }))
}

// Export individual block groups for potential future use
export { headingBlocks, listBlocks, textBlocks, createMediaBlocks }
