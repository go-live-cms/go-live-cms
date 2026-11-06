import React from "react"
import type { Block } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps } from "../types"

// An item's text element id, for its checkbox's `aria-labelledby`: only from an id that
// is safe in HTML as is (stored ids are UUIDs), else the checkbox gets an `aria-label`.
const SAFE_ID = /^[A-Za-z0-9_-]{10,128}$/

/**
 * A to-do list (#419): `ul.todo-list`, one `li` per item (`is-checked` when done) with a
 * **read-only** checkbox: `disabled`, so readers can't toggle it and it isn't a tab stop,
 * and labelled by the item's text, so a screen reader says "To do, checkbox, checked".
 * The blocks canvas has no published board for it yet; the default theme styles it from
 * its tokens.
 */
const TodoListBlock: React.FC<BlockComponentProps> = ({ block, doc, getBlockContent, anchorId }) => {
  return (
    <ul id={anchorId} className="todo-list">
      {(block.children ?? []).map((childId) => {
        const child = doc.blocks[childId] as Block | undefined
        if (!child) return null
        const attrs = (child.attrs ?? {}) as { checked?: unknown; text?: unknown }
        const checked = attrs.checked === true
        const textId = SAFE_ID.test(childId) ? `todo-${childId}` : undefined
        const fallbackLabel = typeof attrs.text === "string" && attrs.text.trim() ? attrs.text : "To-do"
        return (
          <li key={childId} className={checked ? "todo-item is-checked" : "todo-item"}>
            <input
              type="checkbox"
              checked={checked}
              disabled
              readOnly
              {...(textId ? { "aria-labelledby": textId } : { "aria-label": fallbackLabel })}
            />
            <span className="todo-item__text" id={textId}>
              {getBlockContent(child)}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

export default TodoListBlock
