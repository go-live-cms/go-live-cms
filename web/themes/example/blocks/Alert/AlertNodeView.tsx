import React from "react"
import { NodeViewWrapper, NodeViewContent } from "@tiptap/react"

export const AlertNodeView = ({ node }: any) => {
  const variant = node.attrs.variant || "info"
  const message = node.attrs.message || "This is an alert message"

  const variantStyles = {
    info: {
      bg: "#dbeafe",
      border: "#3b82f6",
      text: "#1e40af",
      icon: "ℹ️",
    },
    success: {
      bg: "#d1fae5",
      border: "#10b981",
      text: "#065f46",
      icon: "✓",
    },
    warning: {
      bg: "#fef3c7",
      border: "#f59e0b",
      text: "#92400e",
      icon: "⚠️",
    },
    error: {
      bg: "#fee2e2",
      border: "#ef4444",
      text: "#991b1b",
      icon: "✕",
    },
  }

  const style = variantStyles[variant as keyof typeof variantStyles] || variantStyles.info

  return (
    <NodeViewWrapper>
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
        <span style={{ fontSize: "1.25rem", flexShrink: 0 }}>{style.icon}</span>
        <div style={{ flex: 1 }}>
          <strong style={{ display: "block", marginBottom: "0.25rem", textTransform: "capitalize" }}>{variant}</strong>
          <NodeViewContent as="div" />
        </div>
      </div>
    </NodeViewWrapper>
  )
}
