import { isMacOS } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import Highlight from "@tiptap/extension-highlight"
import Subscript from "@tiptap/extension-subscript"
import Superscript from "@tiptap/extension-superscript"

/**
 * The inline marks of #418 (design `docs/design/block-library.md` 3.3; "Keyboard",
 * "Formatting text"): highlight (⌘⇧H), superscript (⌘.) and subscript (⌘,), TipTap's own
 * extensions at 3.4.2 with their commands and `<mark>` / `<sup>` / `<sub>` parse rules
 * (highlight's shortcut is its own; the other two below). Nothing here needs a DOM, so
 * they're in `schemaExtensions` and the collab server's schema has them.
 *
 * - **Highlight is one theme colour:** `multicolor: false`, so the mark has no `color`
 *   attr (text and background colours are the block menu's palette, #356). The editor and
 *   every theme style `<mark>`; the API keeps no attrs on it.
 * - **Superscript and subscript exclude each other** (ProseMirror `excludes`, each also
 *   excluding itself as the default would): turning one on replaces the other, in a
 *   selection, in stored marks and in pasted HTML, so a run is never both.
 *
 * Each mark changes the schema fingerprint (#416): a tab from before #418 would delete a
 * highlighted run a newer peer typed (rule 10), so it is refused at its reconnect.
 */
export const GlHighlight = Highlight.configure({ multicolor: false })

/**
 * ⌘. / ⌘, exactly: Mod and the key, no Shift or Alt. Not TipTap's `Mod-,` keymap entry:
 * ProseMirror's keymap retries a shifted character key without its Shift, so `Mod-,` would
 * also take ⌘⇧, (the settings panel, #417) whenever that one passes, or on a layout whose
 * Shift+, still reads ",". Returns false (the key goes on) where the mark can't be set,
 * as in a caption.
 */
function exactShortcut(key: string, run: () => boolean): Plugin {
  return new Plugin({
    key: new PluginKey(`glScriptShortcut${key}`),
    props: {
      handleKeyDown(_view, event) {
        const mod = isMacOS() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
        if (!mod || event.shiftKey || event.altKey || event.key !== key) return false
        return run()
      },
    },
  })
}

export const GlSuperscript = Superscript.extend({
  excludes: "superscript subscript",
  addKeyboardShortcuts: () => ({}),
  addProseMirrorPlugins() {
    return [exactShortcut(".", () => this.editor.commands.toggleSuperscript())]
  },
})

export const GlSubscript = Subscript.extend({
  excludes: "subscript superscript",
  addKeyboardShortcuts: () => ({}),
  addProseMirrorPlugins() {
    return [exactShortcut(",", () => this.editor.commands.toggleSubscript())]
  },
})

/** The marks #418 added, by schema name. */
export const INLINE_MARK_NAMES = ["highlight", "superscript", "subscript"] as const
