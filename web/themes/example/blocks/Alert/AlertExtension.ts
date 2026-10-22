import { ReactNodeViewRenderer } from "@tiptap/react"
import { AlertNodeView } from "./AlertNodeView.tsx"
import { AlertSchema } from "./AlertSchema"

// The schema lives in AlertSchema.ts so the collab server can load it without React.
export const AlertExtension = AlertSchema.extend({
  addNodeView() {
    return ReactNodeViewRenderer(AlertNodeView)
  },
})
