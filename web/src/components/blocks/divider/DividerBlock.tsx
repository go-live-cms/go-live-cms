import React from "react"
import type { BlockComponentProps } from "../types"

const DividerBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  return <hr key={block.id} id={anchorId} />
}

export default DividerBlock
