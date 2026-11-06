import Collaboration from "@tiptap/extension-collaboration"
import Placeholder from "@tiptap/extension-placeholder"
import CharacterCount from "@tiptap/extension-character-count"
import Typography from "@tiptap/extension-typography"
import { OpenLinkModal } from "../extensions/OpenLinkModal"
import { slashCommandManager } from "./slashCommandManager"
import { getCursorCoords } from "./cursorCoords"
import { CursorAwareness } from "./cursorAwareness"
import { getActiveTheme, menuEntries, slotAcceptsAt, type CatalogEntry } from "../blocks/catalog"
import { SlashCommandExtension } from "../ui/SlashCommand"
import { PasteSanitizer } from "../extensions/PasteSanitizer"
import { BlockNodeViews } from "../extensions/BlockNodeViews"
import { BlockActions } from "./blockActions"
import { BlockGutterKeys } from "./blockGutter"
import { authManager } from "@gl-admin/lib/auth"
import { tiptapExtensionRegistry } from "./extensionRegistry"
import { installedThemeBlockEditors } from "@gl-admin/lib/theme-blocks/editorBlocks"
import { schemaExtensions } from "@gl-admin/lib/collaboration/schema"

const headingLabel = (lvl?: number) => {
  switch (lvl) {
    case 1:
      return "Heading 1…"
    case 2:
      return "Heading 2…"
    case 3:
      return "Heading 3…"
    default:
      return "Heading…"
  }
}

// "Inserting blocks" › "Empty insert states" (#415).
export const EMPTY_POST_HINT = "Type / for blocks, or start writing"
export const EMPTY_LINE_HINT = "Type / for blocks"

const extensions = ({ collabProvider, maxChars, placeholder, setUrl, setIsLinkModalOpen }) => {
  return () => {
    let slashEntries: { role: string | null; theme: string; entries: CatalogEntry[] } | null = null
    // The schema-defining extensions are shared with the collab server
    // (lib/collaboration/schema.ts, #206). Collaboration ships its own Yjs-aware
    // undo/redo (with Mod-z / Mod-y / Shift-Mod-z keymaps), so StarterKit's bundled
    // undoRedo is off when collaborating, which resolves the
    // "@tiptap/extension-collaboration … not compatible with @tiptap/extension-undo-redo"
    // conflict; non-collab editors keep it as their only undo stack.
    const schema = schemaExtensions({ collaborating: Boolean(collabProvider) })
    const baseExtensions = [
      schema.document,
      schema.starterKit,
      schema.codeBlock,
      Typography,
      schema.link,
      ...(setUrl && setIsLinkModalOpen
        ? [
            OpenLinkModal.configure({
              onOpen: (url: string) => {
                setUrl(url)
                setIsLinkModalOpen(true)
              },
            }),
          ]
        : []),
      schema.image,
      schema.textAlign,
      schema.quoteCitation,
      schema.blockColor,
      schema.group,
      schema.callout,
      schema.pullQuote,
      schema.todoList,
      schema.todoItem,
      schema.blockId,
      BlockNodeViews,
      // The block menu's Ctrl D / Ctrl Shift P (#356); no schema.
      BlockActions,
      PasteSanitizer,
      Placeholder.configure({
        includeChildren: true,
        showOnlyWhenEditable: true,
        placeholder: ({ node, editor }) => {
          switch (node.type.name) {
            case "codeBlock":
              return "Write code…"
            case "blockquote":
              return "Write a quote…"
            case "horizontalRule":
              return ""
            case "image":
              return ""
            case "imageCaption":
              return "Write a caption…"
            case "pullQuote":
              return "Pull quote"
            case "heading":
              return headingLabel(node.attrs?.level)
            case "listItem":
              return editor.isActive("orderedList") ? "List item…" : "List item…"
            case "paragraph":
            default: {
              if (editor.isActive("codeBlock")) return "Write code…"
              if (editor.isActive("callout")) return "Type a note"
              if (editor.isActive("taskList")) return "To-do"
              if (editor.isActive("blockquote")) return "Write a quote…"
              if (editor.isActive("orderedList")) return "List item…"
              if (editor.isActive("bulletList")) return "List item…"
              if (editor.isActive("heading", { level: 1 })) return headingLabel(1)
              if (editor.isActive("heading", { level: 2 })) return headingLabel(2)
              if (editor.isActive("heading", { level: 3 })) return headingLabel(3)
              // "Empty insert states" (#415): the hint is on the focused empty line only
              // (showOnlyCurrent), never on every empty line of an unfocused post.
              if (!editor.isFocused) return ""
              return editor.isEmpty ? placeholder || EMPTY_POST_HINT : EMPTY_LINE_HINT
            }
          }
        },
      }),
      CharacterCount.configure({ limit: maxChars }),
      // Tab from the text reaches the block's + and drag handle (#415).
      BlockGutterKeys,
      SlashCommandExtension.configure({
        suggestion: {
          // "/" at the start of a line (#415, "Type / on an empty line").
          startOfLine: true,
          // No block commands inside an image caption (#346, it holds text only) or in code.
          allow: ({ state, range }: { state: any; range: { from: number } }) => {
            const parent = state.doc.resolve(range.from).parent
            return parent.type.name !== "imageCaption" && !parent.type.spec.code
          },
          // The whole menu (the list filters by the query itself): the role gate and the
          // active theme (catalog.ts). The role is a UI hint; the server enforces.
          // Cached per role and theme: the plugin asks on every view update.
          // Then only what the slot the line is in accepts (#414): no group inside a group,
          // a list item or a quote.
          items: ({ editor }: { editor: any }) => {
            const role = authManager.getState().user?.role ?? null
            const theme = getActiveTheme()
            if (!slashEntries || slashEntries.role !== role || slashEntries.theme !== theme) {
              slashEntries = { role, theme, entries: menuEntries({ role, theme }) }
            }
            return slashEntries.entries.filter(slotAcceptsAt(editor))
          },
          render: () => ({
            onStart: (props: any) => slashCommandManager.start(props, getCursorCoords),
            onUpdate: (props: any) => slashCommandManager.update(props, getCursorCoords),
            onKeyDown: (props: any) => slashCommandManager.handleKeyDown(props),
            onExit: () => slashCommandManager.exit(),
          }),
        },
      }),
    ]
    // Add collaboration extensions
    if (collabProvider) {
      if (collabProvider.doc && collabProvider.provider && collabProvider.provider.awareness) {
        baseExtensions.push(
          Collaboration.configure({
            document: collabProvider.doc,
          })
        )

        const awareness = collabProvider.provider.awareness
        baseExtensions.push(CursorAwareness.configure({ awareness }))
      } else {
        console.warn("Collaboration provider not fully initialized, skipping collaboration extensions")
      }
    }

    // Every installed theme block (#376), whichever theme is active: the collab server's
    // schema has them all (getInstalledCollabSchema), so the editor must too, or a block
    // of an inactive theme would trip the schema gate (rule 10). Then any extras.
    baseExtensions.push(...installedThemeBlockEditors.map((block) => block.extension), ...tiptapExtensionRegistry.getAll())

    return baseExtensions
  }
}

export const getExtensions = ({
  collabProvider,
  maxChars,
  placeholder,
  setUrl,
  setIsLinkModalOpen,
}: {
  collabProvider: any
  maxChars?: number
  placeholder?: string
  setUrl?: (url: string) => void
  setIsLinkModalOpen?: (open: boolean) => void
}) => {
  return extensions({ collabProvider, maxChars, placeholder, setUrl, setIsLinkModalOpen })
}
