import type { BlockConfig } from "../../../../src/components/blocks/types"
import type { Block } from "../../../../gl-admin/components/editor/blocks/index"
import AlertBlock from "./AlertBlock.tsx"
import { AlertExtension } from "./AlertExtension"

export const alertConfig: BlockConfig = {
  type: "alert",
  name: "Alert",
  category: "design",
  description: "Colored alert box for important messages",
  icon: "⚠️",
  keywords: ["alert", "warning", "notice", "callout", "box"],
  priority: 60,

  component: AlertBlock,
  hasChildren: false,

  // Default attributes
  attributes: {
    variant: {
      type: "string",
      default: "info",
      enum: ["info", "success", "warning", "error"],
    },
    message: {
      type: "string",
      default: "This is an alert message",
    },
  },
}

// Editor configuration for slash command
export const alertEditorConfig: Block = {
  title: "Alert",
  description: "Colored alert box for important messages",
  icon: "⚠️",
  aliases: ["alert", "warning", "notice", "callout"],
  command: ({ editor, range }) => {
    editor
      .chain()
      .focus()
      .deleteRange(range)
      .insertContent({
        type: "alert",
        attrs: {
          variant: "info",
          message: "This is an alert message",
        },
        content: [{ type: "text", text: "This is an alert message" }],
      })
      .run()
  },
}

// Tiptap extension for the alert block
export const alertExtension = AlertExtension

export default alertConfig
