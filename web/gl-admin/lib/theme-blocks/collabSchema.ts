import type { Schema } from "prosemirror-model"
import { getCollabSchema } from "../collaboration/schema"
import { installedThemeBlocks } from "./installed"

/**
 * The collab schema with every installed theme block (#376): what the collab server
 * converts with, and what the editor's schema must equal (schema.test.ts). Its own file
 * so the public renderer, which needs the definitions but no editor schema, doesn't pull
 * in StarterKit.
 */
export function getInstalledCollabSchema(): Schema {
  return getCollabSchema(installedThemeBlocks.map((block) => block.node))
}