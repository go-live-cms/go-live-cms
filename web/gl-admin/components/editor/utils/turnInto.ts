import { NodeSelection } from "@tiptap/pm/state"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { embedEntryId, findEntry, turnIntoEntries, type CatalogEntry } from "../blocks/catalog"

// Turn into (the selection toolbar's and the block-type toolbar's picker) reads the block
// catalog (#415): the options are the catalog entries that have a `turnInto`, the value
// is the entry's id.

/** A catalog entry id ("paragraph", "heading-2", "bullet-list", …). */
export type TurnIntoValue = string

/** The catalog id of the block holding the selection ("divider" and the media blocks have no Turn into). */
export const computeTurnIntoFromSelection = (editor: TiptapEditor): TurnIntoValue => {
  const { state } = editor
  const sel = state.selection

  if (sel instanceof NodeSelection && sel.node) {
    const node = sel.node
    if (node.type.name === "image") return "image"
    // #423
    if (node.type.name === "video" || node.type.name === "audio" || node.type.name === "file") return node.type.name
    if (node.type.name === "embed") return embedEntryId(node.attrs.provider)
    // #428
    if (node.type.name === "html") return "html"
    if (node.type.name === "horizontalRule") return "divider"
    if (node.type.name === "codeBlock") return "code-block"
    if (node.type.name === "blockquote") return "quote"
    if (node.type.name === "pullQuote") return "pull-quote"
    if (node.type.name === "callout") return "callout"
    if (node.type.name === "orderedList") return "numbered-list"
    if (node.type.name === "bulletList") return "bullet-list"
    if (node.type.name === "taskList") return "todo-list"
    if (node.type.name === "heading") {
      const lvl = (node.attrs?.level ?? 1) as number
      return `heading-${Math.min(Math.max(lvl, 1), 6)}`
    }
    return "paragraph"
  }

  if (editor.isActive("codeBlock")) return "code-block"
  if (editor.isActive("pullQuote")) return "pull-quote"
  if (editor.isActive("callout")) return "callout"
  if (editor.isActive("blockquote")) return "quote"
  if (editor.isActive("taskList")) return "todo-list"
  if (editor.isActive("orderedList")) return "numbered-list"
  if (editor.isActive("bulletList")) return "bullet-list"

  for (const level of [1, 2, 3, 4, 5, 6]) {
    if (editor.isActive("heading", { level })) return `heading-${level}`
  }

  const $from = sel.$from
  for (let d = $from.depth; d >= 0; d--) {
    const node = $from.node(d)
    if (node.type.name === "horizontalRule") return "divider"
    if (node.type.name === "image") return "image"
    if (node.type.name === "video" || node.type.name === "audio") return node.type.name
    if (node.type.name === "embed") return embedEntryId(node.attrs.provider)
  }

  return "paragraph"
}

/**
 * Turns the block holding the selection into the catalog entry `value`. False when the
 * entry doesn't exist or has no Turn into (an image can't become a paragraph).
 */
export const applyTurnInto = (editor: TiptapEditor, value: TurnIntoValue, entries: readonly CatalogEntry[] = turnIntoEntries()): boolean => {
  const entry = findEntry(value, entries)
  if (!entry?.turnInto) return false
  entry.turnInto(editor)
  return true
}
