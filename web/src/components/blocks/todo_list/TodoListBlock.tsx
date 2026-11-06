import React from "react"
import { isSafeBlockId, type Block } from "@gl-admin/lib/blocks-spec"
import type { BlockComponentProps, PMNode } from "../types"
import { plainText, todoListMarkup, type TodoItemMarkup } from "../utils/textBlockMarkup"

/**
 * A to-do list (#419): `ul.todo-list`, one `li` per item (`is-checked` when done) with a
 * **read-only** checkbox: `disabled`, so readers can't toggle it and it isn't a tab stop,
 * and labelled by the item's text (`aria-labelledby` = `todo-<item id>`, or an `aria-label`
 * for an id that isn't safe in HTML), so a screen reader says "Write it, checkbox, checked".
 * The blocks canvas has no published board for it yet; the default theme styles it from
 * its tokens. The markup is shared with a to-do list nested in a list item
 * (`textBlockMarkup.tsx`).
 */
const TodoListBlock: React.FC<BlockComponentProps> = ({ block, doc, getBlockContent, anchorId }) => {
  const items = (block.children ?? []).flatMap((childId): TodoItemMarkup[] => {
    const child = doc.blocks[childId] as Block | undefined
    if (!child) return []
    const attrs = (child.attrs ?? {}) as { checked?: unknown; text?: unknown; pm?: { content?: PMNode[] } }
    const text = typeof attrs.text === "string" ? attrs.text : plainText(attrs.pm?.content)
    return [
      {
        key: childId,
        checked: attrs.checked === true,
        content: getBlockContent(child),
        labelId: isSafeBlockId(childId) ? `todo-${childId}` : undefined,
        label: text.trim() || "To-do",
      },
    ]
  })
  return todoListMarkup({ items, id: anchorId })
}

export default TodoListBlock
