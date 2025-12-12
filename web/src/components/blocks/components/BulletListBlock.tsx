import React from "react"
import type { Block } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps, BlockConfig } from "../types"

const BulletListBlock: React.FC<BlockComponentProps> = ({ block, doc, getBlockContent }) => {
  return (
    <ul key={block.id}>
      {block.children?.map((childId) => {
        const child = doc.blocks[childId] as Block
        if (!child) return null
        const content = getBlockContent(child)
        return <li key={childId}>{content}</li>
      })}
    </ul>
  )
}

export const bulletListConfig: BlockConfig = {
  type: "bullet_list",
  name: "Bullet List",
  description: "An unordered list with bullet points",
  component: BulletListBlock,
  hasChildren: true,
}

export default BulletListBlock
