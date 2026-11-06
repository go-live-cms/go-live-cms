import React from "react"
import type { Block } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps } from "../types"
import { blockColorClassOf } from "../utils/blockColor"

const BulletListBlock: React.FC<BlockComponentProps> = ({ block, doc, getBlockContent, anchorId }) => {
  return (
    <ul key={block.id} id={anchorId} className={blockColorClassOf(block.attrs)}>
      {block.children?.map((childId) => {
        const child = doc.blocks[childId] as Block
        if (!child) return null
        const content = getBlockContent(child)
        return <li key={childId}>{content}</li>
      })}
    </ul>
  )
}

export default BulletListBlock
