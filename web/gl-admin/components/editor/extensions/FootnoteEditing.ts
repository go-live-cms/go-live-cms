import { Extension } from "@tiptap/core"
import { Fragment, Slice, type Node as PMNode, type NodeType } from "@tiptap/pm/model"
import { NodeSelection, Plugin, PluginKey, type EditorState } from "@tiptap/pm/state"
import type { Decoration as PMDecoration, DecorationSource, EditorView, NodeView, ViewMutationRecord } from "@tiptap/pm/view"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { FOOTNOTE_NODE, FOOTNOTE_REF_NODE, FOOTNOTES_NODE, normalizeFootnoteId } from "@gl-admin/lib/blocks-spec"

/**
 * The editor's half of footnotes (#422; schema and commands: `FootnotesBlock.ts`). No schema,
 * editor only, and **no appendTransaction** (rule 7): numbers are decorations recomputed from
 * the doc after any change, a remote one included, so they update live for every user without
 * anyone writing anything.
 *
 * - **Numbers:** the order of the references. A reference to a note that doesn't exist shows
 *   "?". Notes are shown in number order with CSS `order` (the list's own order only follows
 *   the references until someone moves a paragraph, and nothing may re-sort it).
 * - **A note's row** (`FootnoteView`): the number, the text, ↩ back to its reference, or
 *   "Not referenced" and Remove when nothing refers to it.
 * - **Keys:** ↵ or Esc in a note go back to the text; ↵ on a selected reference goes to its
 *   note; ⌫ and Delete never join two notes.
 * - **Paste** keeps a reference only when this post has its note.
 */

const pluginKey = new PluginKey<DecorationSet>("footnoteEditing")

/** Past every number the list can show: where notes without a reference go. */
const UNREFERENCED_ORDER = 100000

interface NoteSpec {
  footnote: { number: number | null }
}

type FootnoteScan = {
  refs: { pos: number; size: number; id: string | null }[]
  notes: { pos: number; size: number; id: string }[]
  numbers: Map<string, number>
}

/** One walk: every reference and note, and each note's number, by the order of its first reference. */
function scanFootnotes(doc: PMNode): FootnoteScan {
  const refs: FootnoteScan["refs"] = []
  const notes: FootnoteScan["notes"] = []
  doc.descendants((node, pos) => {
    if (node.type.name === FOOTNOTE_REF_NODE) {
      refs.push({ pos, size: node.nodeSize, id: normalizeFootnoteId(node.attrs.footnoteId) })
      return false
    }
    // Every list, not just the first: two can exist until the next store (`footnotes.ts`).
    if (node.type.name === FOOTNOTE_NODE) {
      notes.push({ pos, size: node.nodeSize, id: node.attrs["data-block-id"] })
      return false
    }
    return true
  })
  const ids = new Set(notes.map((note) => note.id))
  const numbers = new Map<string, number>()
  for (const { id } of refs) {
    if (id !== null && ids.has(id) && !numbers.has(id)) numbers.set(id, numbers.size + 1)
  }
  return { refs, notes, numbers }
}

/** The numbers: each note's, by the order of the first reference to it. */
export function footnoteNumbers(doc: PMNode): Map<string, number> {
  return scanFootnotes(doc).numbers
}

function footnoteDecorations(doc: PMNode): DecorationSet {
  const { refs, notes, numbers } = scanFootnotes(doc)
  const decorations: PMDecoration[] = refs.map(({ pos, size, id }) => {
    const number = id === null ? undefined : numbers.get(id)
    return Decoration.node(
      pos,
      pos + size,
      number === undefined
        ? { "data-footnote-missing": "true", "aria-label": "Footnote missing", title: "This footnote's note was removed" }
        : { "data-footnote-number": String(number), "aria-label": `Footnote ${number}` },
    )
  })
  for (const { pos, size, id } of notes) {
    const spec: NoteSpec = { footnote: { number: numbers.get(id) ?? null } }
    decorations.push(Decoration.node(pos, pos + size, {}, spec))
  }
  return DecorationSet.create(doc, decorations)
}

/** A note in the list: its number, the text, and what can be done with it. */
class FootnoteView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private readonly number: HTMLElement
  private readonly back: HTMLButtonElement
  private readonly unreferenced: HTMLElement
  private readonly remove: HTMLButtonElement
  private node: PMNode

  constructor(
    node: PMNode,
    private readonly view: EditorView,
    decorations: readonly PMDecoration[],
    private readonly commands: { back: (id: string) => void; remove: (id: string) => void },
  ) {
    this.node = node
    const doc = view.dom.ownerDocument
    this.dom = doc.createElement("div")
    this.dom.className = "editor-footnote"
    this.dom.setAttribute("data-type", "footnote")
    this.number = doc.createElement("span")
    this.number.className = "editor-footnote__number"
    this.number.contentEditable = "false"
    this.contentDOM = doc.createElement("div")
    this.contentDOM.className = "editor-footnote__text"
    const actions = doc.createElement("span")
    actions.className = "editor-footnote__actions"
    actions.contentEditable = "false"
    this.back = doc.createElement("button")
    this.back.type = "button"
    this.back.className = "editor-footnote__back"
    this.back.textContent = "↩"
    this.back.addEventListener("click", () => this.commands.back(this.id))
    this.unreferenced = doc.createElement("span")
    this.unreferenced.className = "editor-footnote__unreferenced"
    this.unreferenced.textContent = "Not referenced"
    this.remove = doc.createElement("button")
    this.remove.type = "button"
    this.remove.className = "editor-footnote__remove"
    this.remove.textContent = "Remove"
    this.remove.addEventListener("click", () => this.commands.remove(this.id))
    actions.append(this.back, this.unreferenced, this.remove)
    this.dom.append(this.number, this.contentDOM, actions)
    this.render(decorations)
  }

  private get id(): string {
    return this.node.attrs["data-block-id"]
  }

  private render(decorations: readonly PMDecoration[]) {
    const spec = decorations.find((decoration) => (decoration.spec as Partial<NoteSpec>).footnote)?.spec as NoteSpec | undefined
    const number = spec?.footnote.number ?? null
    if (this.id) this.dom.setAttribute("data-block-id", this.id)
    this.dom.classList.toggle("is-unreferenced", number === null)
    this.dom.style.order = String(number ?? UNREFERENCED_ORDER)
    this.number.textContent = number === null ? "–" : `${number}.`
    this.back.hidden = number === null
    this.unreferenced.hidden = number !== null
    this.remove.hidden = number !== null
    if (number !== null) this.back.setAttribute("aria-label", `Back to reference ${number}`)
    this.remove.setAttribute("aria-label", "Remove this footnote")
  }

  update(node: PMNode, decorations: readonly PMDecoration[], _inner: DecorationSource) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render(decorations)
    return true
  }

  stopEvent(event: Event) {
    return !this.contentDOM.contains(event.target as Node)
  }

  ignoreMutation(mutation: ViewMutationRecord) {
    return !this.contentDOM.contains(mutation.target)
  }
}

/** The ids of the notes the selection doesn't cover: the ones that will still be there after a paste over it. */
function noteIdsOutsideSelection(state: EditorState): Set<string> {
  const { from, to } = state.selection
  const ids = new Set<string>()
  state.doc.forEach((node, offset) => {
    if (node.type.name !== FOOTNOTES_NODE) return
    node.forEach((note, inner) => {
      const start = offset + 1 + inner
      const end = start + note.nodeSize
      if (end <= from || start >= to || from === to) ids.add(note.attrs["data-block-id"])
    })
  })
  return ids
}

/** `fragment` without the references `keep` refuses. Text next to them stays where it is. */
function withKnownReferences(fragment: Fragment, keep: (id: string | null) => boolean): Fragment {
  const children: PMNode[] = []
  let changed = false
  fragment.forEach((child) => {
    if (child.type.name === FOOTNOTE_REF_NODE && !keep(normalizeFootnoteId(child.attrs.footnoteId))) {
      changed = true
      return
    }
    const content = withKnownReferences(child.content, keep)
    if (content !== child.content) changed = true
    children.push(content === child.content ? child : child.copy(content))
  })
  return changed ? Fragment.fromArray(children) : fragment
}

/** The slice's inline content, flat: only what a note can hold, each block after the first on a new line. */
function asNoteContent(slice: Slice, note: NodeType): Slice {
  const inline: PMNode[] = []
  const breakNode = note.schema.nodes.hardBreak
  let lines = 0
  const fits = (node: PMNode) => !!note.contentMatch.matchType(node.type)
  const visit = (fragment: Fragment) =>
    fragment.forEach((child) => {
      if (child.isTextblock) {
        if (lines++ > 0) inline.push(breakNode.create())
        child.forEach((node) => {
          if (fits(node)) inline.push(node)
        })
      } else if (child.isInline) {
        if (fits(child)) inline.push(child)
      } else visit(child.content)
    })
  visit(slice.content)
  return new Slice(Fragment.fromArray(inline), 0, 0)
}

/**
 * What a paste keeps (#422). A reference is a pointer: a copy of it, cut and pasted or copied
 * elsewhere in the post, still points at its note, which then has two references and two back
 * links. One from another post has no note here, so it is left out and the text around it
 * stays. The check is against the notes the paste doesn't replace.
 */
export function keepKnownFootnoteRefs(slice: Slice, state: EditorState): Slice {
  const { $from, $to } = state.selection
  // A note is one line of text: what's pasted into it stays in it (lines become hard breaks).
  // ProseMirror would otherwise put a second paragraph where one fits, after the list.
  if ($from.parent.type.name === FOOTNOTE_NODE && $to.parent === $from.parent) return asNoteContent(slice, $from.parent.type)
  const known = noteIdsOutsideSelection(state)
  const content = withKnownReferences(slice.content, (id) => id !== null && known.has(id))
  return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd)
}

export const FootnoteEditing = Extension.create({
  name: "footnoteEditing",
  // Before #417's keys and the text keymaps, like the other blocks' own (`DetailsKeyboard`).
  priority: 200,

  addKeyboardShortcuts() {
    const noteAtCaret = () => {
      const { $from, $to } = this.editor.state.selection
      return $from.parent.type.name === FOOTNOTE_NODE && $to.parent === $from.parent ? $from.parent : null
    }
    const backToText = () => {
      const note = noteAtCaret()
      if (!note) return false
      this.editor.commands.goToFootnoteReference(note.attrs["data-block-id"])
      return true
    }

    return {
      // A note is one paragraph: ↵ never splits it (⇧↵ still breaks the line).
      Enter: () => {
        const { selection } = this.editor.state
        if (selection instanceof NodeSelection && selection.node.type.name === FOOTNOTE_REF_NODE) {
          return this.editor.commands.goToFootnote(selection.node.attrs.footnoteId)
        }
        return backToText()
      },
      Escape: () => {
        const note = noteAtCaret()
        return !!note && this.editor.commands.goToFootnoteReference(note.attrs["data-block-id"])
      },
      // Never into the note beside it.
      Backspace: () => {
        const { selection } = this.editor.state
        return selection.empty && !!noteAtCaret() && selection.$from.parentOffset === 0
      },
      Delete: () => {
        const { selection } = this.editor.state
        return selection.empty && !!noteAtCaret() && selection.$from.parentOffset === selection.$from.parent.content.size
      },
    }
  },

  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin<DecorationSet>({
        key: pluginKey,
        state: {
          init: (_config, state) => footnoteDecorations(state.doc),
          apply: (tr, previous, _old, next) => (tr.docChanged ? footnoteDecorations(next.doc) : previous),
        },
        props: {
          decorations: (state) => pluginKey.getState(state),
          nodeViews: {
            [FOOTNOTE_NODE]: (node, view, _getPos, decorations) =>
              new FootnoteView(node, view, decorations, {
                back: (id) => {
                  editor.chain().focus().goToFootnoteReference(id).run()
                },
                remove: (id) => {
                  if (view.editable) editor.chain().focus().removeFootnote(id).run()
                },
              }),
          },
          // The number is a link to its note.
          handleClickOn: (_view, _pos, node) => {
            if (node.type.name !== FOOTNOTE_REF_NODE) return false
            return editor.chain().focus().goToFootnote(node.attrs.footnoteId).run()
          },
          transformPasted: (slice, view) => keepKnownFootnoteRefs(slice, view.state),
        },
      }),
    ]
  },
})
