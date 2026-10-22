import Collaboration from "@tiptap/extension-collaboration"
import Placeholder from "@tiptap/extension-placeholder"
import CharacterCount from "@tiptap/extension-character-count"
import Typography from "@tiptap/extension-typography"
import { OpenLinkModal } from "../extensions/OpenLinkModal"
import { slashCommandManager } from "./slashCommandManager"
import { getCursorCoords } from "./cursorCoords"
import { CursorAwareness } from "./cursorAwareness"
import { getSlashCommandItems } from "../blocks"
import { SlashCommandExtension } from "../ui/SlashCommand"
import { PasteSanitizer } from "../extensions/PasteSanitizer"
import { tiptapExtensionRegistry } from "./extensionRegistry"
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

const extensions = ({ collabProvider, maxChars, placeholder, setUrl, setIsLinkModalOpen }) => {
  return () => {
    // The schema-defining extensions are shared with the collab server
    // (lib/collaboration/schema.ts, #206). Collaboration ships its own Yjs-aware
    // undo/redo (with Mod-z / Mod-y / Shift-Mod-z keymaps), so StarterKit's bundled
    // undoRedo is off when collaborating, which resolves the
    // "@tiptap/extension-collaboration … not compatible with @tiptap/extension-undo-redo"
    // conflict; non-collab editors keep it as their only undo stack.
    const schema = schemaExtensions({ collaborating: Boolean(collabProvider) })
    const baseExtensions = [
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
      schema.blockId,
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
            case "heading":
              return headingLabel(node.attrs?.level)
            case "listItem":
              return editor.isActive("orderedList") ? "List item…" : "List item…"
            case "paragraph":
            default: {
              if (editor.isActive("codeBlock")) return "Write code…"
              if (editor.isActive("blockquote")) return "Write a quote…"
              if (editor.isActive("orderedList")) return "List item…"
              if (editor.isActive("bulletList")) return "List item…"
              if (editor.isActive("heading", { level: 1 })) return headingLabel(1)
              if (editor.isActive("heading", { level: 2 })) return headingLabel(2)
              if (editor.isActive("heading", { level: 3 })) return headingLabel(3)
              return placeholder || "Type '/' for commands…"
            }
          }
        },
      }),
      CharacterCount.configure({ limit: maxChars }),
      SlashCommandExtension.configure({
        suggestion: {
          items: ({ query }: { query: string }) => {
            return getSlashCommandItems()
              .filter((item) => {
                const searchTerm = query.toLowerCase()
                return (
                  item.title.toLowerCase().includes(searchTerm) ||
                  item.description.toLowerCase().includes(searchTerm) ||
                  (item.aliases && item.aliases.some((alias) => alias.includes(searchTerm)))
                )
              })
              .slice(0, 10)
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
        console.warn("CollaborationProvider not fully initialized, skipping collaboration extensions")
      }
    }

    // Add dynamically registered theme extensions
    const themeExtensions = tiptapExtensionRegistry.getAll()
    if (themeExtensions.length > 0) {
      console.log(`[Editor] Adding ${themeExtensions.length} theme extensions to editor`)
      baseExtensions.push(...themeExtensions)
    }

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
