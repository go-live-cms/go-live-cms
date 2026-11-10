import { mergeAttributes, Node, type Range } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { TextSelection, type EditorState } from "@tiptap/pm/state"
import {
  containerContent,
  FOOTNOTE_CONTENT,
  FOOTNOTE_NODE,
  FOOTNOTE_REF_NODE,
  FOOTNOTES_NODE,
  normalizeFootnoteId,
} from "@gl-admin/lib/blocks-spec"
import { generateBlockId } from "./BlockIdExtension"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    footnotes: {
      /**
       * A reference after the selection (or in place of `range`, the typed "/query"), its note
       * in the post's list (made if needed), and the caret in the note. One transaction.
       */
      insertFootnote: (range?: Range) => ReturnType
      /** Removes a note nothing refers to (with the list, when it was the last). */
      removeFootnote: (id: string) => ReturnType
      /** The caret to the end of the note `id`. */
      goToFootnote: (id: string) => ReturnType
      /** The caret right after the first reference to the note `id`. */
      goToFootnoteReference: (id: string) => ReturnType
    }
  }
}

const BLOCK_ID = "data-block-id"

/**
 * The inline reference (#422, rules in `blocks-spec/footnotes.ts`): an atom holding only the
 * id of its note. Its number is a decoration (`FootnoteEditing.ts`), never stored.
 *
 * It parses with a higher priority than the Superscript mark, which reads every `<sup>`.
 * Schema only (no DOM code), so the collab server builds the same schema.
 */
export const FootnoteRef = Node.create({
  name: FOOTNOTE_REF_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      footnoteId: {
        default: null,
        parseHTML: (element) => normalizeFootnoteId(element.getAttribute("data-footnote-id")),
        renderHTML: (attributes) => (attributes.footnoteId ? { "data-footnote-id": attributes.footnoteId } : {}),
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'sup[data-type="footnote-ref"]',
        priority: 100,
        getAttrs: (element) => (normalizeFootnoteId((element as HTMLElement).getAttribute("data-footnote-id")) === null ? false : null),
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ["sup", mergeAttributes({ "data-type": "footnote-ref", class: "editor-footnote-ref" }, HTMLAttributes)]
  },
})

/**
 * One note (#422): a child of the list, rich inline text and never another reference
 * (`FOOTNOTE_CONTENT`, so a paste or a drag can't put one here). Its `data-block-id` is what
 * its references point at. `isolating`: Backspace and Delete never join two notes, which
 * would lose one's id and leave its references with nothing to point at.
 */
export const Footnote = Node.create({
  name: FOOTNOTE_NODE,
  content: FOOTNOTE_CONTENT,
  defining: true,
  isolating: true,
  // Not on its own: Remove and the caret are what act on a note.
  selectable: false,

  parseHTML() {
    return [{ tag: 'div[data-type="footnote"]', context: "footnotes/" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-type": "footnote", class: "editor-footnote" }, HTMLAttributes), 0]
  },
})

/**
 * The post's list of notes (#422, a row of the nesting table). The menus make it, at the end
 * of the post, in the insert command's own transaction: **nothing appends, renumbers or
 * deletes a note in response to a change** (rule 7), so a sync can't start a loop.
 *
 * Its content allows any number of lists anywhere in the doc on purpose (`footnotes.ts`). Not
 * selectable, so Delete at the end of the last paragraph doesn't select it for the next key.
 *
 * Schema only (no DOM code). The editor's view of a note and the numbers are
 * `FootnoteEditing.ts`.
 */
export const Footnotes = Node.create({
  name: FOOTNOTES_NODE,
  content: containerContent("footnotes"),
  defining: true,
  isolating: true,
  selectable: false,

  addExtensions() {
    return [Footnote]
  },

  parseHTML() {
    return [{ tag: 'section[data-type="footnotes"]', contentElement: "div" }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "section",
      mergeAttributes({ "data-type": "footnotes", class: "editor-footnotes" }, HTMLAttributes),
      ["h3", { class: "editor-footnotes__title", contenteditable: "false" }, "Footnotes"],
      ["div", { class: "editor-footnotes__list" }, 0],
    ]
  },

  addCommands() {
    return {
      insertFootnote:
        (range) =>
        ({ state, tr, dispatch }) => {
          const at = range ? range.from : state.selection.to
          if (!acceptsFootnoteRef(state, at)) return false
          if (!dispatch) return true
          if (range) tr.delete(range.from, range.to)
          const id = generateBlockId()
          const { footnoteRef, footnote, footnotes } = state.schema.nodes
          tr.insert(at, footnoteRef.create({ footnoteId: id }))

          const note = footnote.create({ [BLOCK_ID]: id })
          const list = findFootnotesList(tr.doc)
          let notePos: number
          if (list) {
            notePos = notePositionFor(tr.doc, list, at)
            tr.insert(notePos, note)
          } else {
            notePos = tr.doc.content.size + 1
            tr.insert(tr.doc.content.size, footnotes.create({ [BLOCK_ID]: generateBlockId() }, note))
          }
          tr.setSelection(TextSelection.create(tr.doc, notePos + 1)).scrollIntoView()
          return true
        },

      removeFootnote:
        (id) =>
        ({ state, tr, dispatch }) => {
          const list = findFootnotesList(state.doc)
          const note = list && findNote(list, id)
          // Someone may have referred to it since the button was drawn.
          if (!list || !note || footnoteUses(state.doc).has(id)) return false
          if (dispatch) {
            if (list.node.childCount === 1) tr.delete(list.pos, list.pos + list.node.nodeSize)
            else tr.delete(note.pos, note.pos + note.node.nodeSize)
          }
          return true
        },

      goToFootnote:
        (id) =>
        ({ state, tr, dispatch }) => {
          const list = findFootnotesList(state.doc)
          const note = list && findNote(list, id)
          if (!note) return false
          if (dispatch) tr.setSelection(TextSelection.create(tr.doc, note.pos + 1 + note.node.content.size)).scrollIntoView()
          return true
        },

      goToFootnoteReference:
        (id) =>
        ({ state, tr, dispatch }) => {
          const uses = footnoteUses(state.doc).get(id)
          if (!uses) return false
          if (dispatch) tr.setSelection(TextSelection.create(tr.doc, uses[0] + 1)).scrollIntoView()
          return true
        },
    }
  },
})

/** Whether a reference can go at `pos`: text that takes inline nodes (not code, a caption or a note). */
export function acceptsFootnoteRef(state: EditorState, pos: number): boolean {
  const $at = state.doc.resolve(pos)
  const type = state.schema.nodes[FOOTNOTE_REF_NODE]
  return !!type && $at.parent.inlineContent && !$at.parent.type.spec.code && $at.parent.canReplaceWith($at.index(), $at.index(), type)
}

/** The Block tab's text. Not the canvas's wording: a note outlives its reference, until someone removes it. */
export const FOOTNOTES_HELP = "Notes are numbered in the order their references appear. A note whose reference was deleted stays here until you remove it. A post has one Footnotes block."

/** "2 notes", as the Block tab says it. */
export function footnotesNoteCount(list: PMNode): string {
  return list.childCount === 1 ? "1 note" : `${list.childCount} notes`
}

/** The list the caret is in, in the shape the Block tab reads. */
export function footnotesBlockAtSelection(state: EditorState) {
  const { $from } = state.selection
  if ($from.depth < 2 || $from.node(1).type.name !== FOOTNOTES_NODE) return null
  return { node: $from.node(1), pos: $from.before(1), index: $from.index(0), holder: state.doc, holderPos: -1 }
}

export type FootnotesList = { node: PMNode; pos: number }

/** The list the commands use: the first (two people adding the first note at once make two until the next store). */
export function findFootnotesList(doc: PMNode): FootnotesList | null {
  let found: FootnotesList | null = null
  doc.forEach((node, pos) => {
    if (!found && node.type.name === FOOTNOTES_NODE) found = { node, pos }
  })
  return found
}

function findNote(list: FootnotesList, id: string): { node: PMNode; pos: number } | null {
  let found: { node: PMNode; pos: number } | null = null
  list.node.forEach((node, offset) => {
    if (!found && node.attrs[BLOCK_ID] === id) found = { node, pos: list.pos + 1 + offset }
  })
  return found
}

/** Every reference in the doc, by the note it points at: their positions in document order. */
export function footnoteUses(doc: PMNode): Map<string, number[]> {
  const uses = new Map<string, number[]>()
  doc.descendants((node, pos) => {
    if (node.type.name === FOOTNOTE_REF_NODE) {
      const id = normalizeFootnoteId(node.attrs.footnoteId)
      if (id !== null) uses.set(id, [...(uses.get(id) ?? []), pos])
      return false
    }
    // A note can't hold one (`FOOTNOTE_CONTENT`), and a peer's bad update isn't a reference.
    return node.type.name !== FOOTNOTES_NODE
  })
  return uses
}

/**
 * Where a new note goes in the list so its order follows the references': before the first
 * note whose reference comes after `at`. Later moves can change that order (nothing re-sorts
 * the list, rule 7): the editor shows notes by number with CSS, and the page always does.
 */
function notePositionFor(doc: PMNode, list: FootnotesList, at: number): number {
  const uses = footnoteUses(doc)
  let pos = list.pos + 1
  let offset = 0
  let chosen = pos
  let stop = false
  list.node.forEach((note) => {
    if (stop) return
    const first = uses.get(note.attrs[BLOCK_ID])?.[0]
    if (first !== undefined) {
      if (first > at) stop = true
      else chosen = pos + offset + note.nodeSize
    }
    offset += note.nodeSize
  })
  return chosen
}

