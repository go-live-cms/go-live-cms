import React from "react"
import type { Block } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps, BlockConfig } from "../types"

const OrderedListBlock: React.FC<BlockComponentProps> = ({ block, doc, getBlockContent }) => {
  return (
    <ol key={block.id}>
      {block.children?.map((childId) => {
        const child = doc.blocks[childId] as Block
        if (!child) return null
        const content = getBlockContent(child)
        return <li key={childId}>{content}</li>
      })}
    </ol>
  )
}

export const orderedListConfig: BlockConfig = {
  type: "ordered_list",
  name: "Ordered List",
  description: "A numbered list with sequential items",
  component: OrderedListBlock,
  hasChildren: true,
}

export default OrderedListBlock
