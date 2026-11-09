import React from "react"
import { spacerHeight } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps } from "../types"

/**
 * Spacer (#426): empty space, a step of the theme's spacing scale (`--space-<n>`, with the
 * default theme's size as the fallback for a theme that has no such property). Hidden from
 * assistive technology: there is nothing in it to read.
 */
const SpacerBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => (
  <div id={anchorId} className="spacer" aria-hidden="true" style={{ height: spacerHeight((block.attrs as { size?: unknown } | undefined)?.size) }} />
)

export default SpacerBlock
