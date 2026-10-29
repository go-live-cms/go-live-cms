import { useState, useCallback } from "react"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { DragHandle as TipTapDragHandle } from "@tiptap/extension-drag-handle-react"

// The block handle in the gutter ("Post editor": the hovered block). Drag to move. The
// design's "add block below" button and block menu (Duplicate, Move to, …, #356) aren't
// built yet.
export default function DragHandle({ editor }: { editor: TiptapEditor }) {
    const [showDrag, setShowDrag] = useState(false)

    const onDragHandleNodeChange = useCallback((data: { node: any; editor: TiptapEditor; pos: number }) => {
        if (data.node && data.node.textContent && data.node.textContent.trim().length > 0) {
            setShowDrag(true)
        } else {
            setShowDrag(false)
        }
    }, [])

    if (!editor) return null

    return (
        <TipTapDragHandle editor={editor} onNodeChange={onDragHandleNodeChange}>
            <div className={`editor-drag-handle${showDrag ? "" : " is-hidden"}`} title="Drag to move">
                <svg width="14" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="9" cy="6" r="1.6" />
                    <circle cx="9" cy="12" r="1.6" />
                    <circle cx="9" cy="18" r="1.6" />
                    <circle cx="15" cy="6" r="1.6" />
                    <circle cx="15" cy="12" r="1.6" />
                    <circle cx="15" cy="18" r="1.6" />
                </svg>
            </div>
        </TipTapDragHandle>
    )
}
