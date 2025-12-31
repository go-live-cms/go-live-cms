import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import ParagraphBlock from "./ParagraphBlock"

export const paragraphConfig: BlockConfig = {
  type: "paragraph",
  name: "Paragraph",
  category: BLOCK_CATEGORIES.TEXT,
  description: "A standard text paragraph with inline formatting support",
  icon: "¶",
  keywords: ["text", "p", "para"],
  priority: 10,

  supports: {
    align: true,
    anchor: true,
    customClassName: true,
    spacing: {
      margin: true,
      padding: true,
    },
  },

  transforms: {
    from: [
      {
        type: "heading",
        transform: (attrs) => ({
          text: attrs.text,
          pm: attrs.pm,
        }),
      },
    ],
    to: [
      {
        type: "heading",
        transform: (attrs) => ({
          text: attrs.text,
          pm: attrs.pm,
          level: 2,
        }),
      },
    ],
  },

  component: ParagraphBlock,
  hasChildren: false,

  example: {
    attributes: {
      text: "This is an example paragraph with some text content.",
    },
  },
}

export default paragraphConfig
