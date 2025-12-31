import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import CodeBlock from "./CodeBlock"

export const codeBlockConfig: BlockConfig = {
  type: "code_block",
  name: "Code",
  category: BLOCK_CATEGORIES.TEXT,
  description: "Display code with syntax highlighting",
  icon: "</>",
  keywords: ["code", "snippet", "programming"],
  priority: 40,

  attributes: {
    language: {
      type: "string",
      default: "javascript",
    },
    code: {
      type: "string",
      default: "",
    },
  },

  component: CodeBlock,
  hasChildren: false,
}

export default codeBlockConfig
