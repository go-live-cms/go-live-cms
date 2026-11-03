import React from "react"
import { NodeViewWrapper, NodeViewContent, type ReactNodeViewProps } from "@tiptap/react"
import { ALERT_VARIANTS } from "./index"
import { ALERT_STYLES, type AlertVariant } from "./styles"

export const AlertNodeView = ({ node, updateAttributes, editor }: ReactNodeViewProps) => {
  const variant: AlertVariant = (ALERT_VARIANTS as readonly string[]).includes(node.attrs.variant) ? node.attrs.variant : "info"
  const style = ALERT_STYLES[variant]

  return (
    <NodeViewWrapper data-block-type={node.type.name} data-variant={variant}>
      <div
        style={{
          padding: "1rem 1.25rem",
          backgroundColor: style.bg,
          border: `2px solid ${style.border}`,
          borderRadius: "0.5rem",
          color: style.text,
          marginBottom: "1rem",
          display: "flex",
          alignItems: "flex-start",
          gap: "0.75rem",
        }}
      >
        <span contentEditable={false} style={{ fontSize: "1.25rem", flexShrink: 0 }} aria-hidden="true">
          {style.icon}
        </span>
        <div style={{ flex: 1 }}>
          <div contentEditable={false} style={{ marginBottom: "0.25rem" }}>
            <select
              aria-label="Alert type"
              value={variant}
              disabled={!editor.isEditable}
              onChange={(event) => updateAttributes({ variant: event.target.value })}
              style={{ font: "inherit", fontWeight: 600, color: style.text, background: "transparent", border: "none" }}
            >
              {ALERT_VARIANTS.map((option) => (
                <option key={option} value={option}>
                  {option[0].toUpperCase() + option.slice(1)}
                </option>
              ))}
            </select>
          </div>
          {/* The editor's stylesheet colours its text for the admin's theme; the alert's
              colours are set here so its text stays readable on its own background. */}
          <NodeViewContent as="div" style={{ color: style.text }} />
        </div>
      </div>
    </NodeViewWrapper>
  )
}
