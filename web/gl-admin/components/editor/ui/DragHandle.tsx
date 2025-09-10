import { useState, useCallback } from "react"
import type { Editor as TiptapEditor } from "@tiptap/core"
import { DragHandle as TipTapDragHandle } from "@tiptap/extension-drag-handle-react"

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
            <div
                className={[
                    'flex items-center justify-center text-md text-white leading-none',
                    'h-6 w-5 mr-1.5 rounded border border-gray-600 cursor-grab select-none',
                    'bg-gray-800 hover:bg-gray-700 transition-delay-500',
                    'duration-200',
                    showDrag ? 'opacity-80 pointer-events-auto' : 'opacity-0 pointer-events-non',
                ].join(' ')}
                title="Drag to move block"
                onMouseDown={(e) => (e.currentTarget.style.cursor = 'grabbing')}
                onMouseUp={(e) => (e.currentTarget.style.cursor = 'grab')}
            >
                ⋮⋮
            </div>
        </TipTapDragHandle>
    )
}