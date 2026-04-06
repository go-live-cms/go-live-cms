import type { Extension as TiptapExtension, Node as TiptapNode } from "@tiptap/core"

/**
 * Tiptap Extension Registry
 * Manages dynamic registration of theme block extensions
 */
class TiptapExtensionRegistry {
  private extensions: Map<string, TiptapExtension | TiptapNode> = new Map()
  private initialized = false

  register(extension: TiptapExtension | TiptapNode) {
    if (this.extensions.has(extension.name)) {
      console.warn(`[Tiptap Extension Registry] Extension "${extension.name}" already registered, skipping duplicate`)
      return
    }
    this.extensions.set(extension.name, extension)
    console.log(`[Tiptap Extension Registry] Registered extension:`, extension.name)
  }

  getAll(): (TiptapExtension | TiptapNode)[] {
    return Array.from(this.extensions.values())
  }

  clear() {
    this.extensions.clear()
    this.initialized = false
  }

  setInitialized(value: boolean) {
    this.initialized = value
  }

  isInitialized(): boolean {
    return this.initialized
  }
}

// Singleton instance
export const tiptapExtensionRegistry = new TiptapExtensionRegistry()

// Export function to load theme extensions
export async function registerThemeExtensions(themeSlug: string, blocks?: Array<{ type: string; modulePath: string }>) {
  if (!blocks || blocks.length === 0) {
    console.log(`[Tiptap Extension Registry] No extensions for theme: ${themeSlug}`)
    return
  }

  console.log(`[Tiptap Extension Registry] Loading ${blocks.length} extensions for theme: ${themeSlug}`)

  for (const block of blocks) {
    try {
      const module = await import(/* @vite-ignore */ block.modulePath)
      // Look for exported extension: named export matching <type>Extension, or generic 'extension'
      const extension =
        module[`${block.type}Extension`] || // e.g. alertExtension
        module.extension ||
        // Fallback: find any export that looks like a Tiptap extension
        Object.values(module).find(
          (exp: any) => exp?.type === "node" || exp?.type === "extension" || exp?.name === block.type
        )
      if (extension) {
        tiptapExtensionRegistry.register(extension)
      }
    } catch (error) {
      console.error(`[Tiptap Extension Registry] Failed to load extension from ${block.modulePath}:`, error)
    }
  }

  console.log(`[Tiptap Extension Registry] Total extensions: ${tiptapExtensionRegistry.getAll().length}`)
}
