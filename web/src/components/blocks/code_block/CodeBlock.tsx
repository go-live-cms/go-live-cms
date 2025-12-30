import React from "react"
import type { BlockComponentProps } from "../types"

const CodeBlock: React.FC<BlockComponentProps> = ({ block }) => {
  const attrs = block.attrs as Record<string, unknown>
  const language = (attrs?.language as string) || "text"
  const code = (attrs?.code as string) || ""

  return (
    <pre key={block.id}>
      <code className={`language-${language}`}>{code}</code>
    </pre>
  )
}

export default CodeBlock
