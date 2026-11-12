import React from "react"
import type { BlockComponentProps } from "@/components/blocks/types"
import { blocksInReadingOrder } from "@gl-admin/lib/blocks-spec"
import { themeBlockAttrs } from "@gl-admin/lib/blocks-spec/themeBlocks"
import { pluginBlockSpec } from "@gl-admin/lib/plugins/blocks"
import block from "./block.json"
import { countWords, readingMinutes } from "./readingTime"

const spec = pluginBlockSpec(block)

/** The words of every block on the page, from the text the editor stores with each one. */
function wordsIn(doc: BlockComponentProps["doc"]): number {
  return blocksInReadingOrder(doc).reduce((sum, id) => {
    const text = (doc.blocks[id]?.attrs as { text?: unknown } | undefined)?.text
    return sum + (typeof text === "string" ? countWords(text) : 0)
  }, 0)
}

// The estimate on the public site (server-rendered by BlockRenderer, inside
// PluginBlockBoundary: a throw here hides this block only). Themes style `.gl-reading-time`.
const EstimateBlock: React.FC<BlockComponentProps> = ({ block: stored, doc, anchorId }) => {
  const { label } = themeBlockAttrs(spec, stored.attrs)
  return (
    <p id={anchorId} className="gl-reading-time">
      {readingMinutes(wordsIn(doc))} {String(label)}
    </p>
  )
}

export default EstimateBlock
