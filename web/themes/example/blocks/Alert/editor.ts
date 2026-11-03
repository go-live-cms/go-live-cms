import { themeBlockEditor } from "@gl-admin/lib/theme-blocks/editor"
import alert from "./index"
import { AlertNodeView } from "./AlertNodeView"

// The alert block in the admin editor: the node view and the slash-menu entry. Admin only;
// the collab server bundles index.ts alone.
export default themeBlockEditor(alert, {
  nodeView: AlertNodeView,
  icon: "⚠️",
  description: "Colored alert box for important messages",
  aliases: ["alert", "warning", "notice", "callout"],
})
