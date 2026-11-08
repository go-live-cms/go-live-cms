import React from "react"
import { captionRuns } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps } from "../types"

/**
 * Details (#421, the canvas's "Published · text"): `<details [open]><summary>…</summary>`
 * then its blocks, each through `renderBlock` like any child, so every flow block works in
 * one. The browser opens and closes it (↵ or Space on the summary, a click): no script.
 * `open` only when the block says so ("Open by default"). The summary is runs with bold,
 * italic and link only (`captionRuns`); an empty one still renders a <summary>, so the
 * browser doesn't put its own "Details" label there.
 */
const DetailsBlock: React.FC<BlockComponentProps> = ({ block, renderBlock, renderContent, anchorId }) => {
  const attrs = (block.attrs ?? {}) as { summary?: unknown; open?: unknown }
  const children = (block.children ?? []).map((childId) => renderBlock(childId)).filter(Boolean)
  if (children.length === 0) return null
  return (
    <details id={anchorId} open={attrs.open === true || undefined}>
      <summary>{renderContent(captionRuns(attrs.summary))}</summary>
      {children}
    </details>
  )
}

export default DetailsBlock
