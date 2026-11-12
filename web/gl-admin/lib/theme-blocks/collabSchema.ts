import type { Node } from "@tiptap/core"
import type { Schema } from "prosemirror-model"
import { getCollabSchema } from "../collaboration/schema"
import { installedThemeBlocks } from "./installed"
import { installedPluginBlocks } from "../plugins/blocks"

/**
 * Every installed extension block's headless node, in schema order: **theme blocks, then
 * plugin blocks, each sorted by type** (docs/design/plugin-system.md 5.2). Node order is part
 * of the schema fingerprint (#416), so the collab schema below and the editor's extension
 * list (components/editor/utils/extensions.ts, through `extensionBlockNodes`'s order) both
 * take it from here. The installed set, never the enabled one (design 5.3).
 */
export function installedExtensionBlockNodes(): Node[] {
  return [...installedThemeBlocks.map((block) => block.node), ...installedPluginBlocks.map((block) => block.node)]
}

/**
 * The collab schema with every installed theme and plugin block (#376, #456): what the
 * collab server converts with, and what the editor's schema must equal (schema.test.ts). Its
 * own file so the public renderer, which needs the definitions but no editor schema, doesn't
 * pull in StarterKit.
 */
export function getInstalledCollabSchema(): Schema {
  return getCollabSchema(installedExtensionBlockNodes())
}
