import { Extension } from "@tiptap/core"
import { normalizeCite } from "@gl-admin/lib/blocks-spec"

/**
 * The quote's citation (#346): a plain-text `cite` attribute on `blockquote`, null when
 * there is none. Schema only (the editor's input lives in BlockNodeViews.ts), so the
 * collab server builds the same schema. Last writer wins, like any node attribute.
 */
export const QuoteCitation = Extension.create({
  name: "quoteCitation",

  addGlobalAttributes() {
    return [
      {
        types: ["blockquote"],
        attributes: {
          cite: {
            default: null,
            parseHTML: (element) => normalizeCite(element.getAttribute("data-cite")),
            renderHTML: (attributes) => (attributes.cite ? { "data-cite": attributes.cite } : {}),
          },
        },
      },
    ]
  },
})
