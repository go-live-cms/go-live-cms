import { themeBlockEditor } from "@gl-admin/lib/theme-blocks/editor"
import alert from "./index"
import { AlertNodeView } from "./AlertNodeView"

// The alert block in the admin editor: the node view and its entry in the block menus
// (slash and +). Admin only; the collab server bundles index.ts alone.
export default themeBlockEditor(alert, {
  nodeView: AlertNodeView,
  icon: "⚠️",
  description: "Colored alert box for important messages",
  group: "text",
  keywords: ["warning", "notice", "callout"],
})
