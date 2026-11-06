import { Extension } from "@tiptap/core"
import { normalizeBlockColor } from "@gl-admin/lib/blocks-spec"

/**
 * Block colour (#356): a `blockColor` attribute on the blocks that take one, a palette
 * token (`BLOCK_COLORS`: `"red"` for tinted text, `"red-background"` for a tinted block),
 * null when the block has the theme's colours. Schema only, so the collab server builds
 * the same schema (`schema.ts`); the block menu sets it. Last writer wins, like any node
 * attribute.
 *
 * Never a free colour: HTML gives it only through `data-block-color` (the editor's own
 * clipboard; the paste sanitizer keeps nothing else), and a value outside the palette
 * parses as null, so a pasted `style="color:#f00"` or an unknown token is dropped.
 */
export const BLOCK_COLOR_NODE_TYPES = ["paragraph", "heading", "blockquote", "bulletList", "orderedList"] as const

export const BlockColor = Extension.create({
  name: "blockColor",

  addGlobalAttributes() {
    return [
      {
        types: [...BLOCK_COLOR_NODE_TYPES],
        attributes: {
          blockColor: {
            default: null,
            parseHTML: (element) => normalizeBlockColor(element.getAttribute("data-block-color")),
            renderHTML: (attributes) => {
              const color = normalizeBlockColor(attributes.blockColor)
              return color ? { "data-block-color": color } : {}
            },
          },
        },
      },
    ]
  },
})
