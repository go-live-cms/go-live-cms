import TaskList from "@tiptap/extension-task-list"
import TaskItem from "@tiptap/extension-task-item"

/**
 * To-do list (#419, Block Spec `todo_list` / `todo_item`): TipTap's TaskList and TaskItem
 * (pinned 3.4.2 like every `@tiptap/*` package). A list like the bulleted one: each
 * `taskItem` is a block with its own id (`isBlockNode`, `LIST_ITEMS`), and its `checked`
 * is a node attribute, last writer wins. Items don't nest (`nested: false`: `paragraph+`),
 * as the issue asks. `[] ` (or `[x] `) at the start of a line makes one: TaskItem's own
 * input rule, gated by the Markdown shortcuts setting like the others.
 *
 * TaskItem's node view (the checkbox) is the extension's own; it only dispatches on the
 * user's click, and reverts the click when the editor isn't editable (a view-only reader
 * can't tick anything). Its options touch no DOM here, so the collab server builds the same
 * schema (`lib/collaboration/schema.ts`).
 */
export const TodoList = TaskList.configure({
  HTMLAttributes: { class: "editor-todo" },
})

export const TodoItem = TaskItem.configure({
  nested: false,
  HTMLAttributes: { class: "editor-todo__item" },
  a11y: {
    checkboxLabel: (node, checked) => {
      const text = node.textContent.trim() || "empty to-do"
      return `${checked ? "Done" : "To do"}: ${text}`
    },
  },
})
