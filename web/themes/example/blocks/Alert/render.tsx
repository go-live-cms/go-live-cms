import React from "react"
import type { BlockComponentProps } from "@/components/blocks/types"
import { themeBlockAttrs } from "@gl-admin/lib/blocks-spec/themeBlocks"
import alert from "./index"
import { ALERT_STYLES, type AlertVariant } from "./styles"

// The alert block on the public site (server-rendered by BlockRenderer).
const AlertBlock: React.FC<BlockComponentProps> = ({ block, getBlockContent, anchorId }) => {
  const variant = themeBlockAttrs(alert, block.attrs).variant as AlertVariant
  const style = ALERT_STYLES[variant]

  return (
    <div
      // The block's link target on the page (#356, Copy link to block).
      id={anchorId}
      className={`gl-alert gl-alert--${variant}`}
      role="note"
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
      <span style={{ fontSize: "1.25rem", flexShrink: 0 }} aria-hidden="true">
        {style.icon}
      </span>
      <div style={{ flex: 1 }}>
        <strong style={{ display: "block", marginBottom: "0.25rem", textTransform: "capitalize" }}>{variant}</strong>
        <div>{getBlockContent(block)}</div>
      </div>
    </div>
  )
}

export default AlertBlock
