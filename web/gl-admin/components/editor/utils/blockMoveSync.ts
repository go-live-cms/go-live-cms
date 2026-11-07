import { ySyncPluginKey, yUndoPluginKey } from "@tiptap/y-tiptap"
import type { Node as PMNode } from "prosemirror-model"
import type { EditorView } from "prosemirror-view"
import type { BlockMove } from "./blockTree"

// How a block move reaches Yjs (#417). Yjs has no move (design 2.12), so a move must arrive
// as "delete the block's element, insert a new one with the same content and id": when two
// people move the same block at once, both inserts survive and the post has two copies,
// never a loss.
//
// y-tiptap (3.0.0) doesn't do that for a ProseMirror transaction that reorders blocks: its
// diff (`updateYFragment`) matches children only from both ends and then rewrites, in
// place, every element of the same node type in between. Moving "gamma" below "end" becomes
// "rewrite gamma's element as end, and end's as gamma"; a collaborator's concurrent delete of
// gamma's element then takes "end" with it (found by blockMoves.collab.test.ts).
//
// So a move is synced in two diffs inside ONE Yjs transaction: first the doc with only the
// removal (the element is deleted, its neighbours match by identity and stay untouched),
// then the real result (a new element is inserted). It runs under the binding's own mutex,
// as its view update does, so neither the view update nor the binding's Yjs observer echoes
// it; collaborators get one update, and the undo manager (which tracks the sync plugin's
// origin) one stack item, closed on both sides so typing never merges into it.
//
// Not an appendTransaction (rule 7): it runs only when this user moves a block.

type Binding = {
  doc: { transact: (f: () => void, origin?: unknown) => void } | null
  mux: (f: () => void) => void
  prosemirrorView: EditorView | null
  _prosemirrorChanged: (doc: PMNode) => void
}

export function applyBlockMove(view: EditorView, move: BlockMove) {
  const sync = ySyncPluginKey.getState(view.state) as
    | { binding?: Binding; snapshot?: unknown; prevSnapshot?: unknown }
    | undefined
  const binding = sync?.binding
  if (!binding || !binding.doc || binding.prosemirrorView !== view || sync.snapshot != null || sync.prevSnapshot != null) {
    view.dispatch(move.tr)
    return
  }
  const undoManager = (yUndoPluginKey.getState(view.state) as { undoManager?: { stopCapturing: () => void } } | undefined)
    ?.undoManager
  undoManager?.stopCapturing()
  binding.mux(() => {
    binding.doc!.transact(() => {
      binding._prosemirrorChanged(move.removedDoc)
      // The view update's own sync is skipped (the mutex is held): the line below does it.
      view.dispatch(move.tr)
      binding._prosemirrorChanged(view.state.doc)
    }, ySyncPluginKey)
  })
  undoManager?.stopCapturing()
}
