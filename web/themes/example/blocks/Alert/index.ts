import { defineThemeBlock } from "@gl-admin/lib/theme-blocks/define"

/**
 * The alert block's headless definition: its Block Spec (type, version, attrs) and its
 * TipTap node, with no React or DOM. The collab server bundles this file and the API's
 * manifest is generated from it (themes/README.md, "Custom Blocks"). The editor's node
 * view is in editor.ts, the public renderer in render.tsx.
 */
export const ALERT_VARIANTS = ["info", "success", "warning", "error"] as const

export default defineThemeBlock({
  type: "theme:example/alert",
  version: 1,
  title: "Alert",
  attrs: {
    variant: { type: "string", enum: ALERT_VARIANTS, default: "info" },
  },
  // Text with bold, italic, links and the like.
  content: "inline*",
})
