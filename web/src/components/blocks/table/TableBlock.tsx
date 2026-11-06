import React, { useId } from "react"
import { blockAnchorId, captionRuns, tableRows } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps } from "../types"
import { renderContent } from "../utils/contentRenderer"

/**
 * A table (#420). Markup the theme styles:
 *
 *   figure > div.table-scroll[role=region][tabindex=0][aria-labelledby=<caption id>] > table
 *          > figcaption#<caption id>
 *
 * The table scrolls sideways inside its own box (the theme's `.table-scroll`), so a wide
 * table never widens the page; the box is focusable, so ← → scroll it from the keyboard,
 * and a region named by the caption (or "Table" without one). With `headerRow` the first
 * row is a `<thead>` of `<th scope="col">` (`colgroup` for a cell spanning columns);
 * every other row is `<td>`s. Cells hold paragraphs only (`tableRows`), rendered like a
 * list item's: inline, a line break between paragraphs.
 */
const TableBlock: React.FC<BlockComponentProps> = ({ block, anchorId }) => {
  const attrs = (block.attrs ?? {}) as { pm?: unknown; headerRow?: unknown; caption?: unknown }
  const fallbackId = useId()
  const rows = tableRows(attrs.pm)
  if (rows.length === 0) return null

  const headerRow = attrs.headerRow === true
  const caption = captionRuns(attrs.caption)
  // From the block id when it's a safe one (stable across renders), so a group's tables
  // get one too; React's id otherwise.
  const captionId = `${blockAnchorId(block.id) ?? `table${fallbackId.replace(/[^A-Za-z0-9_-]/g, "")}`}-caption`
  const [head, ...body] = headerRow ? rows : [null, ...rows]

  const cell = (Tag: "th" | "td", key: number, view: (typeof rows)[number][number], scope?: "col" | "colgroup") => (
    <Tag
      key={key}
      colSpan={view.colspan > 1 ? view.colspan : undefined}
      // A header cell can't span into the body (row groups bound a rowspan).
      rowSpan={Tag === "td" && view.rowspan > 1 ? view.rowspan : undefined}
      scope={scope}
    >
      {renderContent(view.content)}
    </Tag>
  )

  return (
    <figure id={anchorId} className="table-block">
      <div
        className="table-scroll"
        role="region"
        tabIndex={0}
        aria-labelledby={caption.length > 0 ? captionId : undefined}
        aria-label={caption.length > 0 ? undefined : "Table"}
      >
        <table>
          {head && (
            <thead>
              <tr>{head.map((view, i) => cell("th", i, view, view.colspan > 1 ? "colgroup" : "col"))}</tr>
            </thead>
          )}
          {body.length > 0 && (
            <tbody>
              {body.map((cells, r) => (
                <tr key={r}>{(cells ?? []).map((view, i) => cell("td", i, view))}</tr>
              ))}
            </tbody>
          )}
        </table>
      </div>
      {caption.length > 0 && <figcaption id={captionId}>{renderContent(caption)}</figcaption>}
    </figure>
  )
}

export default TableBlock
