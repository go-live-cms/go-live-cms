import { Extension, mergeAttributes, Node } from "@tiptap/core"
import { isChangeOrigin } from "@tiptap/extension-collaboration"
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state"
import { Mapping } from "@tiptap/pm/transform"
import {
  containerContent,
  containerOfNode,
  COVER_OVERLAY_DEFAULT,
  isCoverAlign,
  isMediaTextPosition,
  normalizeCoverOverlay,
  normalizeFocalAxis,
  normalizeMediaAlt,
} from "@gl-admin/lib/blocks-spec"
import { editorBlockAtSelection, holderAcceptsType, replaceLineOrInsertAfter } from "../utils/blockTree"
import { mediaIdAttribute } from "./MediaBlocks"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    coverMedia: {
      /** The menus' Cover: an empty cover for the caret's line, the caret in its first block. */
      insertCover: () => ReturnType
      /** The menus' Media & text, the same way. */
      insertMediaText: () => ReturnType
    }
  }
}

// The two blocks' node attributes (#427). `focalX` and `focalY` are two scalars, not one
// object: y-tiptap compares attributes by identity, so an object would be written to the
// shared doc on every sync of the node. In Block Spec they are one `focal`, both or neither.
function imageAttributes(decorativeDefault: boolean) {
  const axis = (name: string) => ({
    default: null,
    parseHTML: (element: HTMLElement) => {
      const value = element.getAttribute(name)
      return value === null ? null : normalizeFocalAxis(Number(value))
    },
    renderHTML: (attributes: Record<string, unknown>) => {
      const value = attributes[name === "data-focal-x" ? "focalX" : "focalY"]
      return value === null || value === undefined ? {} : { [name]: value }
    },
  })
  return {
    ...mediaIdAttribute,
    alt: {
      default: null,
      parseHTML: (element: HTMLElement) => normalizeMediaAlt(element.getAttribute("data-alt")),
      renderHTML: (attributes: Record<string, unknown>) => (attributes.alt ? { "data-alt": attributes.alt } : {}),
    },
    decorative: {
      default: decorativeDefault,
      parseHTML: (element: HTMLElement) => {
        const value = element.getAttribute("data-decorative")
        return value === null ? decorativeDefault : value === "true"
      },
      renderHTML: (attributes: Record<string, unknown>) => ({ "data-decorative": attributes.decorative === true ? "true" : "false" }),
    },
    focalX: axis("data-focal-x"),
    focalY: axis("data-focal-y"),
  }
}

/**
 * Cover (#427, Block Spec `cover`): flow blocks on top of one image, darkened by `overlay`
 * (0–80 in steps of 5). The image is the `mediaId` alone: its URL and size are the media
 * library's. Its alt text is optional and on a cover it's decorative by default, as drawn.
 *
 * Top level only, by the nesting table. Schema and commands only, no DOM: the collab server
 * builds it too. The view is `CoverMediaViews.ts`, the panel `ui/CoverMediaSettings.tsx`.
 */
export const Cover = Node.create({
  name: "cover",
  content: containerContent("cover"),
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      ...imageAttributes(true),
      overlay: {
        default: COVER_OVERLAY_DEFAULT,
        parseHTML: (element: HTMLElement) => {
          const value = element.getAttribute("data-overlay")
          return normalizeCoverOverlay(value === null ? undefined : Number(value))
        },
        renderHTML: (attributes: Record<string, unknown>) => ({ "data-overlay": normalizeCoverOverlay(attributes.overlay) }),
      },
      align: {
        default: "content",
        parseHTML: (element: HTMLElement) => {
          const value = element.getAttribute("data-align")
          return isCoverAlign(value) ? value : "content"
        },
        renderHTML: (attributes: Record<string, unknown>) => ({ "data-align": isCoverAlign(attributes.align) ? attributes.align : "content" }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="cover"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "cover", class: "editor-cover" }, HTMLAttributes), 0]
  },
})

/**
 * Media & text (#427, Block Spec `media_text`): one image beside flow blocks and details, on
 * the left or the right, above them on phones. A group may hold one; nothing else may.
 */
export const MediaText = Node.create({
  name: "mediaText",
  content: containerContent("media_text"),
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      ...imageAttributes(false),
      position: {
        default: "left",
        parseHTML: (element: HTMLElement) => {
          const value = element.getAttribute("data-position")
          return isMediaTextPosition(value) ? value : "left"
        },
        renderHTML: (attributes: Record<string, unknown>) => ({ "data-position": isMediaTextPosition(attributes.position) ? attributes.position : "left" }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="media-text"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "media-text", class: "editor-media-text" }, HTMLAttributes), 0]
  },
})

/** Inserts one with an empty paragraph (the schema would allow none) for the caret's line, the caret in it. */
function insertWithParagraph(name: "cover" | "mediaText", specType: "cover" | "media_text") {
  return () =>
    ({ state, tr, dispatch }: { state: EditorState; tr: Transaction; dispatch?: unknown }) => {
      const block = editorBlockAtSelection(state)
      if (!holderAcceptsType(block?.holder.type.name ?? "doc", specType)) return false
      const node = state.schema.nodes[name].create(null, state.schema.nodes.paragraph.create())
      if (dispatch) {
        const at = replaceLineOrInsertAfter(tr, block, node)
        tr.setSelection(TextSelection.create(tr.doc, at + 2)).scrollIntoView()
      }
      return true
    }
}

/** The two blocks' commands: no schema, kept next to the nodes like the media blocks'. */
export const CoverMediaCommands = Extension.create({
  name: "coverMediaCommands",
  addCommands() {
    return {
      insertCover: insertWithParagraph("cover", "cover"),
      insertMediaText: insertWithParagraph("mediaText", "media_text"),
    }
  },
})

const emptyContainerFillKey = new PluginKey("emptyContainerFill")

/**
 * A local change that leaves a cover or media & text with no block gets an empty paragraph
 * back, and the caret goes in it. The schema allows an empty one for the sake of a merge
 * (`emptyNotInSchema`), so without this cutting its only selected block would leave it unable
 * to hold a caret, and a post that isn't saved yet would lose it. Local changes only (rule 7):
 * after a sync the collab server repairs it, once
 * (`repairEmptyContainers`). Editor only: the collab server has no use for it.
 */
export const EmptyContainerFill = Extension.create({
  name: "emptyContainerFill",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: emptyContainerFillKey,
        appendTransaction(transactions, oldState, state) {
          if (!transactions.some((tr) => tr.docChanged) || transactions.some((tr) => isChangeOrigin(tr))) return null
          const mapping = new Mapping()
          for (const tr of transactions) mapping.appendMapping(tr.mapping)
          const back = mapping.invert()
          // Only one these changes emptied: a merge can leave one empty until the server's
          // repair, and typing elsewhere meanwhile must not fill it or take the caret there.
          const emptiedHere = (pos: number) => {
            const before = oldState.doc.nodeAt(back.map(pos))
            return !(before && before.type === state.doc.nodeAt(pos)?.type && before.childCount === 0)
          }
          const positions: number[] = []
          const walk = (parent: typeof state.doc, start: number) => {
            parent.forEach((child, offset) => {
              const pos = start + offset
              const rule = containerOfNode(child.type.name)
              if (rule?.emptyNotInSchema && child.childCount === 0) {
                if (emptiedHere(pos)) positions.push(pos)
              } else if (rule && !rule.emptyNotInSchema) walk(child, pos + 1)
            })
          }
          walk(state.doc, 0)
          if (positions.length === 0) return null
          const tr = state.tr
          // From the end, so an earlier position stays right.
          for (const pos of [...positions].reverse()) tr.insert(pos + 1, state.schema.nodes.paragraph.create())
          return tr.setSelection(TextSelection.create(tr.doc, positions[0] + 2))
        },
      }),
    ]
  },
})
