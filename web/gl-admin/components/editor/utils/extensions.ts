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
import { InlineNodeViews } from "../extensions/InlineNodeViews"
import { MentionMenuExtension, mentionMenuAllowed } from "../ui/MentionMenu"
import { mentionMenuManager } from "./mentionMenuManager"
import { BlockNodeViews } from "../extensions/BlockNodeViews"
import { TableKeyboard } from "../extensions/TableBlock"
import { DetailsKeyboard } from "../extensions/DetailsBlock"
import { ButtonsKeyboard } from "../extensions/ButtonsBlock"
import { GalleryKeyboard } from "../extensions/GalleryKeyboard"
import { TEXT_PART_NODE_NAMES } from "@gl-admin/lib/blocks-spec/nesting"
import { BlockActions } from "./blockActions"
import { BlockGutterKeys } from "./blockGutter"
import { BlockNavigationKeys, BlockSelectionKeys } from "../extensions/BlockNavigation"
import { NodeSelectionGuard } from "../extensions/NodeSelectionGuard"
import { EmptyContainerFill } from "../extensions/CoverMediaBlocks"
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
export const DETAILS_CONTENT_HINT = "Hidden content. Type / to add blocks."

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
      // #418: ⌘⇧H, ⌘. and ⌘, are the marks' own shortcuts.
      schema.highlight,
      schema.superscript,
      schema.subscript,
      schema.textAlign,
      schema.quoteCitation,
      schema.blockColor,
      schema.group,
      schema.callout,
      schema.pullQuote,
      schema.todoList,
      schema.todoItem,
      schema.table,
      schema.details,
      schema.gallery,
      schema.video,
      schema.audio,
      schema.file,
      // #423: insert, set the file of, and caption the media blocks; no schema.
      schema.mediaCommands,
      schema.embed,
      // #425: insert an embed, its caption; no schema.
      schema.embedCommands,
      // #428: a snippet id, never markup; its command has no schema.
      schema.html,
      schema.htmlCommands,
      // #426
      schema.columns,
      schema.buttons,
      schema.spacer,
      // #427
      schema.cover,
      schema.mediaText,
      schema.coverMediaCommands,
      schema.mention,
      schema.contentLink,
      schema.dateChip,
      schema.blockId,
      BlockNodeViews,
      // #320: the mention's current name and the site's date format; no schema.
      InlineNodeViews,
      // #420: Tab / ⇧Tab between cells, only while the caret is in one; no schema.
      TableKeyboard,
      // #421: ↵ from the summary into the content, ⌫ never deletes the summary; no schema.
      DetailsKeyboard,
      // #426: ↵ leaves a button for the line under it, ⌫ never joins two; no schema.
      ButtonsKeyboard,
      // #424: ← → between images, ⌘⇧← → reorder, ↵ to the image's alt text; no schema.
      GalleryKeyboard,
      // The block menu's Ctrl D / Ctrl Shift P (#356); no schema.
      BlockActions,
      // Blocks at any depth from the keyboard (#417): Esc, ↵, ↑↓, ⌘⇧↑↓, ⌫; no schema.
      BlockSelectionKeys,
      BlockNavigationKeys,
      EmptyContainerFill,
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
            case "video":
            case "audio":
            case "file":
            case "embed":
            case "html":
              return ""
            case "imageCaption":
            case "tableCaption":
            case "galleryCaption":
              return "Write a caption…"
            case "detailsSummary":
              return "Summary"
            case "button":
              return "Button text"
            case "spacer":
              return ""
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
              // A table cell holds paragraphs only (#420): no block menu there, so no hint.
              if (editor.isActive("tableCell") || editor.isActive("tableHeader")) return ""
              // #421, the canvas's empty details: what's typed here is hidden until a reader opens it.
              if (editor.isActive("details")) return editor.isFocused ? DETAILS_CONTENT_HINT : ""
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
          // No block commands inside a caption or a details summary (#346, #420, #421: text
          // only), in code, or in a table cell (#420: paragraphs only).
          allow: ({ state, range }: { state: any; range: { from: number } }) => {
            const $at = state.doc.resolve(range.from)
            const parent = $at.parent
            const cell = $at.depth > 1 ? $at.node($at.depth - 1).type.spec.tableRole : undefined
            return !TEXT_PART_NODE_NAMES.has(parent.type.name) && !parent.type.spec.code && !cell
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
      // "@" (#320): people, posts and pages, dates. Anywhere text takes inline nodes (not
      // code or a caption); the menu fetches its own results for the query.
      MentionMenuExtension.configure({
        suggestion: {
          allow: mentionMenuAllowed,
          render: () => ({
            onStart: (props: any) => mentionMenuManager.start(props, getCursorCoords),
            onUpdate: (props: any) => mentionMenuManager.update(props, getCursorCoords),
            onKeyDown: (props: any) => mentionMenuManager.handleKeyDown(props),
            onExit: () => mentionMenuManager.exit(),
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
        // A selected block that a collaborator (or an undo) deletes must not break the
        // sync (#417, y-tiptap's selection restore).
        baseExtensions.push(NodeSelectionGuard)
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
