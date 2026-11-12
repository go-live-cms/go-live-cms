import { pluginBlockEditor } from "@gl-admin/lib/plugins/editor"
import block from "./block.json"
import { EstimateView } from "./EstimateView"

// The estimate in the admin editor: a node view and its entry in the block menus, offered
// while the plugin is enabled. Admin only; the collab server reads block.json alone.
export default pluginBlockEditor(block, {
  nodeView: EstimateView,
  icon: "⏱",
  description: "The post's estimated reading time",
  group: "text",
  keywords: ["reading time", "minutes", "estimate"],
})
