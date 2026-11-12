import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import { countWords, readingMinutes } from "./readingTime"

// The estimate in the editor: the minutes for the post as it stands, and the label after
// them (a node attr, last writer wins). Reads the document, never writes it.
export const EstimateView = ({ node, editor, updateAttributes }: ReactNodeViewProps) => {
  const minutes = readingMinutes(countWords(editor.state.doc.textContent))
  const label = typeof node.attrs.label === "string" ? node.attrs.label : ""
  return (
    <NodeViewWrapper data-block-type={node.type.name} className="gl-reading-time-editor">
      <div contentEditable={false} style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.5rem 0" }}>
        <span aria-hidden="true">⏱</span>
        <span>{minutes}</span>
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
