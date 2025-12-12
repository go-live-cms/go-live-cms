import React from "react"
import type { BlockComponentProps, BlockConfig } from "../types"

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

export const codeBlockConfig: BlockConfig = {
  type: "code_block",
  name: "Code Block",
  description: "A block of code with optional syntax highlighting",
  component: CodeBlock,
  hasChildren: false,
}

export default CodeBlock
