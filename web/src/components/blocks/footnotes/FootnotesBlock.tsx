import React, { useContext } from "react"
import { footnoteAnchorId, footnoteRefAnchorId, FOOTNOTES_TITLE_ID } from "@gl-admin/lib/blocks-spec/footnotes"
import type { BlockComponentProps, PMNode } from "../types"
import { FootnotesContext } from "../utils/footnotes"

/**
 * The published list (#422, the canvas's "Published · text"): a `section.footnotes` with one
 * `<li id="fn-N">` per note in number order, each with a back link to every reference.
 * The order, the numbers and which notes are listed are `footnoteIndex`'s. Nothing renders when
 * no note is left to show.
 */
const FootnotesBlock: React.FC<BlockComponentProps> = ({ renderContent, anchorId }) => {
  const { notes } = useContext(FootnotesContext)
  if (notes.length === 0) return null
  return (
    <section className="footnotes" id={anchorId} aria-labelledby={FOOTNOTES_TITLE_ID}>
      <h2 id={FOOTNOTES_TITLE_ID}>Footnotes</h2>
      <ol>
        {notes.map((note) => {
          const pm = note.block.attrs?.pm as { content?: PMNode[] } | undefined
          return (
            <li key={note.id} id={footnoteAnchorId(note.number)}>
              {pm?.content ? renderContent(pm.content) : String(note.block.attrs?.text ?? "")}
              {Array.from({ length: note.uses }, (_, index) => {
                const occurrence = index + 1
                return (
                  <a
                    key={occurrence}
                    className="fn-back"
                    href={`#${footnoteRefAnchorId(note.number, occurrence)}`}
                    aria-label={occurrence === 1 ? `Back to reference ${note.number}` : `Back to reference ${note.number}, use ${occurrence}`}
                  >
                    ↩{occurrence > 1 && <sup>{occurrence}</sup>}
                  </a>
                )
              })}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

export default FootnotesBlock
