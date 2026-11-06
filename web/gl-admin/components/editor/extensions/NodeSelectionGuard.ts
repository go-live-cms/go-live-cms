import { Extension } from "@tiptap/core"
import { ySyncPluginKey } from "@tiptap/y-tiptap"
import type { Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"

// Keeps a selected block from breaking the sync when the block goes away (#417).
//
// When Yjs changes the doc (a collaborator's edit, or this user's undo), y-tiptap 3.0.0
// rebuilds the editor's doc and restores the selection it saved before the change. A block
// selection (a NodeSelection: Esc, a dropped block, a clicked image) is restored with
// `NodeSelection.create(doc, anchor)`, which throws when the selected block was deleted and
// was the last block of its container: there is no node after the anchor. The throw is in
// the binding's Yjs observer, so the editor would never get that change (and its next edit
// would be diffed against a doc that misses it). With Esc selecting blocks at any depth, and
// a drop leaving the moved block selected (whose undo deletes it), that is no longer rare
// (found by blockMoves.collab.test.ts: undo right after a drop).
//
// Before the observers run (Yjs's `beforeObserverCalls`), this checks whether the selected
// block's element is still in the doc; if it was deleted, the saved selection becomes a
// caret at the block's place, which y-tiptap restores safely. A block that is still there
// stays selected. It reads and writes only the binding's saved selection: no transaction,
// no appendTransaction (rule 7 in lib/collaboration/CLAUDE.md).

type RelativeSelection = { type: string; anchor: unknown; head: unknown } | null
type Binding = {
  doc: { on: (event: string, f: () => void) => void; off: (event: string, f: () => void) => void } | null
  mapping: Map<{ _item: { deleted: boolean } | null }, PMNode | PMNode[]>
  prosemirrorView: EditorView | null
  beforeTransactionSelection: RelativeSelection
}

const key = new PluginKey("nodeSelectionGuard")

/** Whether the Yjs element the binding maps to `node` is still in the doc. */
export function elementAlive(binding: Pick<Binding, "mapping">, node: PMNode): boolean {
  for (const [type, mapped] of binding.mapping) {
    if (mapped === node) return !type._item || !type._item.deleted
  }
  return false
}

/** The saved selection to restore: a deleted block's selection becomes a caret at its place. */
export function safeSavedSelection(binding: Pick<Binding, "mapping">, saved: RelativeSelection, selection: unknown): RelativeSelection {
  if (!saved || saved.type !== "node" || !(selection instanceof NodeSelection)) return saved
  if (elementAlive(binding, selection.node)) return saved
  return { type: "text", anchor: saved.anchor, head: saved.anchor }
}

export const NodeSelectionGuard = Extension.create({
  name: "nodeSelectionGuard",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        view(view) {
          const binding = (ySyncPluginKey.getState(view.state) as { binding?: Binding } | undefined)?.binding
          const doc = binding?.doc
          if (!binding || !doc) return {}
          const guard = () => {
            const current = binding.prosemirrorView ?? view
            binding.beforeTransactionSelection = safeSavedSelection(binding, binding.beforeTransactionSelection, current.state.selection)
          }
          doc.on("beforeObserverCalls", guard)
          return {
            destroy() {
              doc.off("beforeObserverCalls", guard)
            },
          }
        },
      }),
    ]
  },
})
