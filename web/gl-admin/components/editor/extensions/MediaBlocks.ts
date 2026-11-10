import { Extension, mergeAttributes, Node } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state"
import { normalizeFileLabel } from "@gl-admin/lib/blocks-spec"

/** The ProseMirror nodes of the media blocks with a media id (#423), the image included. */
export const MEDIA_NODE_NAMES = ["image", "video", "audio", "file"] as const
export type MediaNodeName = (typeof MEDIA_NODE_NAMES)[number]

/** The media blocks #423 adds (the image is `ImageWithMediaId`). */
export type NewMediaNodeName = Exclude<MediaNodeName, "image">

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    mediaBlocks: {
      /** Insert an empty video, audio or file block for the caret's line (the menus' entries). */
      insertMediaBlock: (name: NewMediaNodeName) => ReturnType
      /**
       * Point the media block at `pos` at a media library item (Choose, Upload, Replace).
       * A file block's label stays as it is: with none, the file's own name is shown (it is
       * never stored, so a Replace shows the new file's name).
       */
      setBlockMedia: (pos: number, mediaId: number) => ReturnType
      /** Add an empty caption to the selected video or audio block, or remove its caption. */
      toggleMediaCaption: () => ReturnType
    }
  }
}

const isMediaNodeName = (name: string): name is MediaNodeName => (MEDIA_NODE_NAMES as readonly string[]).includes(name)

/** A `data-media-id` as the number Block Spec and the API's media sync need, else null. */
export function mediaIdFromElement(element: Element | null | undefined): number | null {
  const value = element?.getAttribute("data-media-id")
  return value && /^\d+$/.test(value) ? Number(value) : null
}

export const mediaIdAttribute = {
  mediaId: {
    default: null,
    parseHTML: (element: HTMLElement) => mediaIdFromElement(element),
    renderHTML: (attributes: Record<string, unknown>) => (attributes.mediaId ? { "data-media-id": attributes.mediaId } : {}),
  },
}

/**
 * The media block the selection is on (a NodeSelection) or in (the caret in its caption),
 * the image included: what the media toolbar and Replace act on.
 */
export function findSelectedMediaBlock(state: EditorState): { pos: number; node: PMNode } | null {
  const { selection } = state
  if (selection instanceof NodeSelection && isMediaNodeName(selection.node.type.name)) {
    return { pos: selection.from, node: selection.node }
  }
  const { $from } = selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (isMediaNodeName(node.type.name)) return { pos: $from.before(depth), node }
  }
  return null
}

/**
 * Adds an empty caption to the media block at `pos` (and puts the caret in it), or
 * removes its caption and selects the block: the image's "Add caption" (#346), shared by
 * video and audio.
 */
export function toggleCaptionOf(tr: Transaction, state: EditorState, pos: number, node: PMNode) {
  const captionPos = pos + 1
  if (node.childCount > 0) {
    tr.delete(captionPos, captionPos + node.child(0).nodeSize)
    tr.setSelection(NodeSelection.create(tr.doc, pos))
  } else {
    tr.insert(captionPos, state.schema.nodes.imageCaption.create())
    tr.setSelection(TextSelection.create(tr.doc, captionPos + 1))
  }
}

/** The caption child (the image's, `imageCaption`) a video or audio figure parses into. */
export function captionOnly(element: HTMLElement) {
  const wrapper = element.ownerDocument.createElement("div")
  const caption = element.querySelector(":scope > figcaption, :scope > div > figcaption")
  if (caption) wrapper.appendChild(caption.cloneNode(true))
  return wrapper
}

/**
 * Video and audio (#423, Block Spec `video` / `audio`): a media library file played by
 * the browser, and an optional caption, the image's own caption node (`imageCaption`,
 * a child so two people typing in it merge per character; `ImageWithMediaId.ts`). The
 * file is the `mediaId` alone: its URL, name and size come from the media library
 * (the editor's view looks it up, the public page reads the API's `media` map), so a
 * replaced or deleted file shows as such everywhere.
 *
 * **Not in the `block` group** (`STANDALONE_FLOW_NODE_NAMES`, like the table): a block of
 * the doc or of a group, never part of a quote's or a list item's content, which the
 * public page renders as text only. Schema and commands only, no DOM code: the collab
 * server builds the same schema. The views are `BlockNodeViews.ts`'s `MediaBlockView`.
 */
function playable(name: "video" | "audio") {
  return Node.create({
    name,
    content: "imageCaption?",
    // Backspace/Delete next to the block never join a paragraph into the caption.
    isolating: true,
    defining: true,
    selectable: true,

    addAttributes() {
      return { ...mediaIdAttribute }
    },

    parseHTML() {
      // The editor's own markup (renderHTML below). Pasted HTML never reaches this: the
      // paste sanitizer drops <video>/<audio> and figures carry no data-type from outside.
      return [{ tag: `figure[data-type="${name}"]`, priority: 60, contentElement: captionOnly }]
    },

    renderHTML({ HTMLAttributes }) {
      return [
        "figure",
        mergeAttributes({ "data-type": name, class: `editor-media editor-media--${name}` }, HTMLAttributes),
        ["div", { class: "editor-media__caption-slot" }, 0],
      ]
    },
  })
}

export const VideoBlock = playable("video")
export const AudioBlock = playable("audio")

/**
 * File (#423, Block Spec `file`): a download link to a media library file. The link text is
 * `label`, plain text by `normalizeFileLabel`'s rules, a node attribute (last writer wins,
 * like a quote's citation) typed in the block's own field; null shows the file's name. An
 * atom: no content of its own, so nothing can be typed or pasted into it.
 */
export const FileBlock = Node.create({
  name: "file",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      ...mediaIdAttribute,
      label: {
        default: null,
        parseHTML: (element: HTMLElement) => normalizeFileLabel(element.getAttribute("data-label")),
        renderHTML: (attributes: Record<string, unknown>) => (attributes.label ? { "data-label": attributes.label } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="file"]', priority: 60 }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "file", class: "editor-media editor-media--file" }, HTMLAttributes), node.attrs.label ?? ""]
  },
})

/**
 * The commands of the media blocks (#423), no schema (the editor adds it next to the
 * nodes). Every one is a single ordinary transaction, never an appendTransaction (rule 7).
 */
export const MediaBlockCommands = Extension.create({
  name: "mediaBlockCommands",
  addCommands() {
    return {
      insertMediaBlock:
        (name) =>
        ({ state, commands }) => {
          if (!state.schema.nodes[name]) return false
          return commands.insertContent({ type: name })
        },
      setBlockMedia:
        (pos, mediaId) =>
        ({ state, tr, dispatch }) => {
          const node = state.doc.nodeAt(pos)
          if (!node || !isMediaNodeName(node.type.name) || !Number.isInteger(mediaId) || mediaId <= 0) return false
          if (dispatch) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, mediaId })
            if (state.selection instanceof NodeSelection && state.selection.from === pos) {
              tr.setSelection(NodeSelection.create(tr.doc, pos))
            }
          }
          return true
        },
      toggleMediaCaption:
        () =>
        ({ state, tr, dispatch }) => {
          const found = findSelectedMediaBlock(state)
          if (!found || (found.node.type.name !== "video" && found.node.type.name !== "audio")) return false
          if (dispatch) toggleCaptionOf(tr, state, found.pos, found.node)
          return true
        },
    }
  },
})
