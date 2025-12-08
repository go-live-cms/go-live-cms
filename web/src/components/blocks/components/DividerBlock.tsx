import React from "react"
import type { BlockComponentProps, BlockConfig } from "../types"

const DividerBlock: React.FC<BlockComponentProps> = ({ block }) => {
  return <hr key={block.id} />
}

export const dividerConfig: BlockConfig = {
  type: "divider",
  name: "Divider",
  description: "A horizontal rule to separate content sections",
  component: DividerBlock,
  hasChildren: false,
}

export default DividerBlock
