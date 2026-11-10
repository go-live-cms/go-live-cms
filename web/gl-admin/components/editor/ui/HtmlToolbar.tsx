import { useCallback, useEffect, useState } from "react"
import { BubbleMenu as TipTapBubbleMenu } from "@tiptap/react/menus"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { NodeSelection } from "@tiptap/pm/state"
import { authManager } from "@gl-admin/lib/auth"
import { isSiteAdmin } from "@gl-admin/lib/roles"
import { HTML_MODE_EVENT, type HtmlBlockMode } from "../blocks/htmlSnippets"
import { moveBlockBy } from "../extensions/BlockNavigation"
import { editorBlockAtSelection } from "../utils/blockTree"
import { isViewMounted } from "./ImageToolbar"

const isHtmlSelection = (selection: unknown) => selection instanceof NodeSelection && selection.node.type.name === "html"

/**
 * A selected custom HTML block's toolbar (#428, "Editor · embeds, custom HTML"): an admin's
 * HTML / Preview, and for an editor or contributor the block's name and Move up / Move down
 * (their block menu's other way of moving it).
 */
export default function HtmlToolbar({ editor }: { editor: TiptapEditor }) {
  const [mode, setMode] = useState<string | null>(null)

  const update = useCallback(() => {
    const { selection } = editor.state
    if (!(selection instanceof NodeSelection) || selection.node.type.name !== "html") return setMode(null)
    const dom = editor.view.nodeDOM(selection.from) as HTMLElement | null
    setMode(dom?.dataset.mode ?? null)
  }, [editor])

  useEffect(() => {
    update()
    editor.on("selectionUpdate", update)
    editor.on("transaction", update)
    return () => {
      editor.off("selectionUpdate", update)
      editor.off("transaction", update)
    }
  }, [editor, update])

  const pick = (next: HtmlBlockMode) => {
    const { selection } = editor.state
    if (!(selection instanceof NodeSelection)) return
    const dom = editor.view.nodeDOM(selection.from) as HTMLElement | null
    dom?.dispatchEvent(new CustomEvent(HTML_MODE_EVENT, { detail: next }))
    setMode(next)
  }

  const move = (dir: -1 | 1) => {
    const block = editorBlockAtSelection(editor.state)
    if (block) moveBlockBy(editor, block, dir)
  }

  const isAdmin = isSiteAdmin(authManager.getState().user?.role)

  return (
    <TipTapBubbleMenu
      editor={editor}
      pluginKey="htmlToolbar"
      className="editor-toolbar image-toolbar"
      shouldShow={({ editor: e, state: s }) => isViewMounted(e) && e.isEditable && isHtmlSelection(s.selection)}
    >
      <div role="toolbar" aria-label="Custom HTML" className="editor-toolbar__group">
        {isAdmin ? (
          <>
            <button type="button" className="editor-toolbar__button editor-toolbar__button--text" aria-pressed={mode === "html"} onClick={() => pick("html")}>
              HTML
            </button>
            <button type="button" className="editor-toolbar__button editor-toolbar__button--text" aria-pressed={mode === "preview"} onClick={() => pick("preview")}>
              Preview
            </button>
          </>
        ) : (
          <>
            <span className="editor-toolbar__button editor-toolbar__button--text">Custom HTML</span>
            <span aria-hidden="true" className="editor-toolbar__divider" />
            <button type="button" className="editor-toolbar__button" aria-label="Move up" onClick={() => move(-1)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m18 15-6-6-6 6" />
              </svg>
            </button>
            <button type="button" className="editor-toolbar__button" aria-label="Move down" onClick={() => move(1)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          </>
        )}
      </div>
    </TipTapBubbleMenu>
  )
}
