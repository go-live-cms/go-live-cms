import React from "react"
import type { BlockComponentProps } from "../types"

/** One column of a columns block (#426): `div.column`, its blocks through `renderBlock`. */
const ColumnBlock: React.FC<BlockComponentProps> = ({ block, renderBlock }) => (
  <div className="column">{(block.children ?? []).map((childId) => renderBlock(childId))}</div>
)

export default ColumnBlock
