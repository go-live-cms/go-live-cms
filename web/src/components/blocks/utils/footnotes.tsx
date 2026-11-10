import React, { createContext, useContext } from "react"
import { EMPTY_FOOTNOTE_INDEX, footnoteAnchorId, footnoteRefAnchorId, type FootnoteIndex } from "@gl-admin/lib/blocks-spec/footnotes"
import type { PMNode } from "../types"

// What BlockRenderer worked out from the doc (#422, `footnoteIndex`): every reference's number
// and anchor. Empty outside a BlockRenderer, where a reference renders nothing.
export const FootnotesContext = createContext<FootnoteIndex>(EMPTY_FOOTNOTE_INDEX)

/**
 * A reference as drawn: `<sup><a class="fn-ref" href="#fn-1" id="ref-1" aria-label="Footnote 1">`.
 * Nothing at all when its note isn't on the page, so a stale reference can never be a broken link.
 */
export function FootnoteRefMark({ node }: { node: PMNode }) {
  const use = useContext(FootnotesContext).useOf(node)
  if (!use) return null
  return (
    <sup>
      <a className="fn-ref" href={`#${footnoteAnchorId(use.number)}`} id={use.occurrence === null ? undefined : footnoteRefAnchorId(use.number, use.occurrence)} aria-label={`Footnote ${use.number}`}>
        {use.number}
      </a>
    </sup>
  )
}
