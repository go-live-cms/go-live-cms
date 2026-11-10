import type { Editor } from "@tiptap/core"
import type { PostHtmlSnippetsStore } from "@gl-admin/lib/htmlSnippetsStore"

// What the custom HTML blocks' views (#428, plain DOM, created by ProseMirror) need from the
// editor around them: the post's snippets, handed over per editor, and the one-shot "put
// the cursor in the new block" flag the catalog sets, like an embed's link field.

const stores = new WeakMap<Editor, PostHtmlSnippetsStore>()
const waiters = new WeakMap<Editor, Set<() => void>>()

export function provideHtmlSnippets(editor: Editor, store: PostHtmlSnippetsStore | null) {
  if (store) stores.set(editor, store)
  else stores.delete(editor)
  for (const waiter of [...(waiters.get(editor) ?? [])]) waiter()
}

export function htmlSnippetsOf(editor: Editor): PostHtmlSnippetsStore | null {
  return stores.get(editor) ?? null
}

/** Calls `listener` when the editor's store is set or taken away. */
export function onHtmlSnippetsChanged(editor: Editor, listener: () => void): () => void {
  const set = waiters.get(editor) ?? new Set()
  waiters.set(editor, set)
  set.add(listener)
  return () => set.delete(listener)
}

let focusNewField = false

export function requestHtmlFieldFocus() {
  focusNewField = true
}

export function takeHtmlFieldFocus(): boolean {
  const asked = focusNewField
  focusNewField = false
  return asked
}

/** The toolbar's HTML / Preview buttons reach the block's view through this event. */
export const HTML_MODE_EVENT = "gl-html-mode"
export type HtmlBlockMode = "html" | "preview"
