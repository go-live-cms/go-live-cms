import { useEffect, useState } from "react"
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import { countWords, readingMinutes } from "./readingTime"

const minutesOf = (editor: ReactNodeViewProps["editor"]) => readingMinutes(countWords(editor.state.doc.textContent))

// The estimate in the editor: the minutes for the post as it stands, and the label after
// them (a node attr, last writer wins). A React node view re-renders only when its own node
// changes, so it follows the editor's updates (anyone's typing, synced edits) to stay
// current. It reads the document and never writes it (rule 7).
export const EstimateView = ({ node, editor, updateAttributes }: ReactNodeViewProps) => {
  const [minutes, setMinutes] = useState(() => minutesOf(editor))
  useEffect(() => {
    const update = () => setMinutes(minutesOf(editor))
    update()
    editor.on("update", update)
    return () => {
      editor.off("update", update)
    }
  }, [editor])
  const label = typeof node.attrs.label === "string" ? node.attrs.label : ""
  return (
    <NodeViewWrapper data-block-type={node.type.name} className="gl-reading-time-editor">
      <div contentEditable={false} style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.5rem 0" }}>
        <span aria-hidden="true">⏱</span>
        <span data-testid="reading-minutes">{minutes}</span>
        <input
          aria-label="Reading time label"
          value={label}
          maxLength={40}
          disabled={!editor.isEditable}
          onChange={(event) => updateAttributes({ label: event.target.value })}
          style={{ font: "inherit", border: "none", background: "transparent", minWidth: "8ch" }}
        />
      </div>
    </NodeViewWrapper>
  )
}
