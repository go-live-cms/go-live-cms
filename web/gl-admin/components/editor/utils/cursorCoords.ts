import type { Editor } from "@tiptap/core"

export const getCursorCoords = (editor: Editor, range: { from: number; to: number }) => {
    const { view } = editor
    const { from } = range

    try {
      const coords = view.coordsAtPos(from)

      const editorRect = view.dom.getBoundingClientRect()

      return {
        x: coords.left,
        y: coords.bottom,
        left: coords.left,
        right: coords.right,
        top: coords.top,
        bottom: coords.bottom,
        width: coords.right - coords.left,
        height: coords.bottom - coords.top,
      }
    } catch (error) {
      const editorRect = view.dom.getBoundingClientRect()
      return {
        x: editorRect.left + 20,
        y: editorRect.top + 40,
        left: editorRect.left + 20,
        right: editorRect.left + 40,
        top: editorRect.top + 20,
        bottom: editorRect.top + 40,
        width: 20,
        height: 20,
      }
    }
  }