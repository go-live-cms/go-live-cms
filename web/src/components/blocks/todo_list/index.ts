import type { BlockConfig } from "../types"
import { BLOCK_CATEGORIES } from "../utils/constants"
import TodoListBlock from "./TodoListBlock"

export const todoListConfig: BlockConfig = {
  type: "todo_list",
  name: "To-do list",
  category: BLOCK_CATEGORIES.TEXT,
  description: "A checklist, published with read-only checkboxes",
  icon: "☐",
  keywords: ["todo", "checklist", "task", "list"],
  priority: 62,

  allowedBlocks: ["todo_item"],

  component: TodoListBlock,
  hasChildren: true,
}

export default todoListConfig
