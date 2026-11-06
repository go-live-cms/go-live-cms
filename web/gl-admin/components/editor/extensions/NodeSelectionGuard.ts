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
type YType = { _item: { deleted: boolean } | null }
type Binding = {
  doc: { on: (event: string, f: () => void) => void; off: (event: string, f: () => void) => void } | null
  mapping: Map<YType, PMNode | PMNode[]>
  prosemirrorView: EditorView | null
  beforeTransactionSelection: RelativeSelection
}

const key = new PluginKey("nodeSelectionGuard")

/** The Yjs element the binding maps to `node`, if any. */
function elementOf(mapping: Binding["mapping"], node: PMNode): YType | null {
  for (const [type, mapped] of mapping) if (mapped === node) return type
  return null
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
          // The selected block's Yjs element, found once per selected node (a remote
          // keystroke elsewhere then costs one lookup, not a scan of the whole mapping).
          // A moved block keeps its node but gets a new element, so a cached element counts
          // only while the mapping still points it at that node.
          let cached: { node: PMNode; type: YType | null } | null = null
          const guard = () => {
            const saved = binding.beforeTransactionSelection
            const { selection } = (binding.prosemirrorView ?? view).state
            if (!saved || saved.type !== "node" || !(selection instanceof NodeSelection)) return
            const node = selection.node
            if (!cached || cached.node !== node || !cached.type || binding.mapping.get(cached.type) !== node) {
              cached = { node, type: elementOf(binding.mapping, node) }
            }
            const alive = !!cached.type && (!cached.type._item || !cached.type._item.deleted)
            // Deleted: restore a caret at its place, which y-tiptap does safely.
            if (!alive) binding.beforeTransactionSelection = { type: "text", anchor: saved.anchor, head: saved.anchor }
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
