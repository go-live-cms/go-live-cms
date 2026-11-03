import type { Extension as TiptapExtension, Node as TiptapNode } from "@tiptap/core"

/**
 * Extra TipTap extensions added to every editor after the installed theme blocks. Theme
 * blocks don't go through here any more: they are resolved when the admin is built
 * (`lib/theme-blocks/editorBlocks.ts`, #376), never imported by URL at runtime. Tests use
 * it to give the editor a node the collab schema doesn't have (Editor.test.tsx).
 */
class TiptapExtensionRegistry {
  private extensions: Map<string, TiptapExtension | TiptapNode> = new Map()

  register(extension: TiptapExtension | TiptapNode) {
    if (this.extensions.has(extension.name)) {
      console.warn(`[Tiptap Extension Registry] Extension "${extension.name}" already registered, skipping duplicate`)
      return
    }
    this.extensions.set(extension.name, extension)
  }

  getAll(): (TiptapExtension | TiptapNode)[] {
    return Array.from(this.extensions.values())
  }

  clear() {
    this.extensions.clear()
  }
}

// Singleton instance
export const tiptapExtensionRegistry = new TiptapExtensionRegistry()
