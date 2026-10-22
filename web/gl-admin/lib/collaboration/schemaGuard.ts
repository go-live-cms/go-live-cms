import type { Schema } from "@tiptap/pm/model"
import type { XmlFragment } from "yjs"
import { yXmlFragmentToProsemirrorJSON } from "@tiptap/y-tiptap"

/** The fragment the Collaboration extension binds to (no `field` option). */
export const EDITOR_FRAGMENT = "default"

/** Node and mark types in a shared doc that an editor schema can't build. */
export type UnbuildableTypes = { nodes: string[]; marks: string[] }

type PMJSON = {
  type: string
  attrs?: Record<string, unknown>
  content?: PMJSON[]
  marks?: { type: string; attrs?: Record<string, unknown> }[]
}

/**
 * Finds what in the shared doc `schema` can't build, before an editor binds to it.
 *
 * y-tiptap's `createNodeFromYElement` / `createTextNodesFromYText` catch a failing
 * `schema.node()` / `schema.text()` and DELETE that element (or text run) from the Y doc,
 * so every peer and the next autosave lose it. That happens for an unknown node type, an
 * unknown mark, or attrs the type can't accept (a required attr missing). This checks the
 * same things, without touching the doc. Returns null when everything can be built.
 */
export function findUnbuildableTypes(fragment: XmlFragment, schema: Schema): UnbuildableTypes | null {
  const nodes = new Set<string>()
  const marks = new Set<string>()

  const visit = (node: PMJSON) => {
    if (node.type === "text") {
      for (const mark of node.marks ?? []) {
        const type = schema.marks[mark.type]
        if (!type) {
          marks.add(mark.type)
          continue
        }
        try {
          type.create(mark.attrs ?? null)
        } catch {
          marks.add(mark.type)
        }
      }
      return
    }
    const type = schema.nodes[node.type]
    if (!type) {
      nodes.add(node.type)
    } else {
      try {
        type.create(node.attrs ?? null)
      } catch {
        nodes.add(node.type)
      }
    }
    node.content?.forEach(visit)
  }

  const root = yXmlFragmentToProsemirrorJSON(fragment) as PMJSON
  root.content?.forEach(visit)

  if (nodes.size === 0 && marks.size === 0) return null
  return { nodes: [...nodes].sort(), marks: [...marks].sort() }
}

/** "callout, quote (block); highlight (formatting)" — for the editor's notice. */
export function describeUnbuildableTypes({ nodes, marks }: UnbuildableTypes): string {
  const parts: string[] = []
  if (nodes.length) parts.push(`${nodes.join(", ")} (block${nodes.length > 1 ? "s" : ""})`)
  if (marks.length) parts.push(`${marks.join(", ")} (formatting)`)
  return parts.join("; ")
}
