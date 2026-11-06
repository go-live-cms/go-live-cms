import { getSchema } from "@tiptap/core"
import type { Schema } from "prosemirror-model"
import { schemaFingerprint } from "@gl-admin/lib/collaboration/schemaFingerprint"
import { getExtensions } from "./extensions"

/**
 * The schema the editor binds with: its extension list (theme blocks and registry extras
 * included; Collaboration adds no node or mark types). The one definition both the schema
 * gate (rule 10, `Editor.tsx`) and the schema fingerprint the client sends (#416,
 * `postCollab.ts`) use, so the two can't describe different schemas. `schema.test.ts`
 * proves it equals the collab server's.
 */
export function editorSchema(): Schema {
  return getSchema(getExtensions({ collabProvider: null })())
}

/** `schemaFingerprint(editorSchema())`: what the client sends with its ticket. */
export function editorSchemaFingerprint(): string {
  return schemaFingerprint(editorSchema())
}
