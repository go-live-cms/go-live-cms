import React from "react"
import type { BlockComponentProps } from "../types"

const DividerBlock: React.FC<BlockComponentProps> = ({ block }) => {
  return <hr key={block.id} />
}

export default DividerBlock
