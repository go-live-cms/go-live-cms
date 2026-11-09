import { useCallback, useEffect, useState } from "react"
import { BubbleMenu as TipTapBubbleMenu } from "@tiptap/react/menus"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { NodeSelection } from "@tiptap/pm/state"
import { findSelectedEmbed } from "../extensions/EmbedBlock"
import { openEmbedLinkField } from "../blocks/embedLinks"

const isEmbedSelection = (selection: unknown) => selection instanceof NodeSelection && selection.node.type.name === "embed"

function viewMounted(editor: TiptapEditor): boolean {
  try {
    return !!editor?.view?.dom?.parentElement
  } catch {
    return false
  }
}

/** A selected embed's toolbar (#425, "Editor · embeds"): Edit link, and the caption on or off. */
export default function EmbedToolbar({ editor }: { editor: TiptapEditor }) {
  const [hasCaption, setHasCaption] = useState(false)

  const update = useCallback(() => {
    const block = editor ? findSelectedEmbed(editor.state) : null
    if (block) setHasCaption(block.node.childCount > 0)
  }, [editor])

  useEffect(() => {
    if (!editor) return
    update()
    editor.on("selectionUpdate", update)
    editor.on("transaction", update)
    return () => {
      editor.off("selectionUpdate", update)
      editor.off("transaction", update)
    }
  }, [editor, update])

  if (!editor) return null

  const editLink = () => {
    const block = findSelectedEmbed(editor.state)
    if (block) openEmbedLinkField(editor, block.pos)
  }

  return (
    <TipTapBubbleMenu
      editor={editor}
      pluginKey="embedToolbar"
      className="editor-toolbar image-toolbar"
      shouldShow={({ editor: e, state: s }) => viewMounted(e) && e.isEditable && isEmbedSelection(s.selection)}
    >
      <div role="toolbar" aria-label="Embed" className="editor-toolbar__group">
        <button type="button" className="editor-toolbar__button editor-toolbar__button--text" onClick={editLink}>
          Edit link
        </button>
        <span aria-hidden="true" className="editor-toolbar__divider" />
        <button
          type="button"
          className="editor-toolbar__button editor-toolbar__button--text"
          aria-pressed={hasCaption}
          onClick={() => editor.chain().focus().toggleEmbedCaption().run()}
        >
          Caption
        </button>
      </div>
    </TipTapBubbleMenu>
  )
}
