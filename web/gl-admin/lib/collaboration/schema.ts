import { getSchema } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import Link from "@tiptap/extension-link"
import TextAlign from "@tiptap/extension-text-align"
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight"
import { createLowlight, common } from "lowlight"
import { Schema, type NodeSpec } from "prosemirror-model"
import { ImageWithMediaId } from "../../components/editor/extensions/ImageWithMediaId"
import { BlockIdExtension } from "../../components/editor/extensions/BlockIdExtension"

const lowlight = createLowlight(common)

/**
 * The extensions that define the editor's document schema (nodes, marks, attributes),
 * configured exactly as the editor configures them, and nothing that needs a DOM or
 * React: no NodeViews, slash menu, placeholder or paste handling. The editor
 * (`components/editor/utils/extensions.ts`) builds its list from these, and the collab
 * server (#206) builds its schema from them, so a Yjs doc means the same thing on both
 * sides. `schema.test.ts` fails if the two schemas ever differ.
 *
 * Returned by name, not as a list, so the editor keeps its own extension order.
 * `collaborating` turns off StarterKit's undo/redo (Collaboration brings its own, #197);
 * it registers no schema, so it doesn't affect the schema.
 */
export function schemaExtensions({ collaborating }: { collaborating: boolean }) {
  return {
    starterKit: StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      codeBlock: false,
      dropcursor: { width: 2, color: "var(--editor-cursor,#3b82f6)" },
      link: false,
      undoRedo: collaborating ? false : undefined,
    }),
    codeBlock: CodeBlockLowlight.configure({
      lowlight,
      defaultLanguage: "javascript",
    }),
    link: Link.configure({
      autolink: true,
      openOnClick: false,
      // Reject non-http(s) protocols at the input layer (#188). `protocols` limits
      // autolink/paste schemes; `validate` is the stronger guard for typed hrefs.
      protocols: ["http", "https"],
      validate: (href) => /^https?:\/\//.test(href),
      HTMLAttributes: {
        class: "editor-link",
      },
    }),
    image: ImageWithMediaId.configure({
      allowBase64: false,
      HTMLAttributes: {
        class: "editor-image",
      },
    }),
    textAlign: TextAlign.configure({ types: ["heading", "paragraph"] }),
    blockId: BlockIdExtension,
  }
}

let coreSchema: Schema | null = null

/**
 * The editor's core schema (no theme blocks), built headlessly. Cached: building a
 * schema is not free and the result is immutable.
 */
export function getCoreSchema(): Schema {
  coreSchema ??= getSchema(Object.values(schemaExtensions({ collaborating: true })))
  return coreSchema
}

interface PMJSON {
  type?: string
  attrs?: Record<string, unknown>
  content?: PMJSON[]
}

/**
 * `base` plus a permissive stand-in for every node type in `roots` (ProseMirror JSON,
 * e.g. a block doc's `attrs.pm` values or `yXmlFragmentToProsemirrorJSON` output) that
 * `base` doesn't know: in practice, theme blocks (#206).
 *
 * Why: the collab server can't load theme extensions (they import React NodeViews), but
 * it must not lose theme blocks. With only the core schema, `blockDocToPMWithReport`
 * drops them (nodeFromJSON throws on an unknown type) and the editors would never see
 * them. A stand-in keeps the node and its attributes exactly as stored; the editor still
 * renders it with the real extension. A stand-in declares every attribute seen on that
 * type (default null, like an attribute the Yjs binding omitted) plus `data-block-id`,
 * takes inline content if it was seen next to text and block content otherwise, and
 * allows every mark. It checks nothing a theme extension would: only the core nodes get
 * a real `check()`.
 */
export function schemaWithStandIns(base: Schema, roots: unknown[]): Schema {
  const seen = new Map<string, { attrs: Set<string>; inline: boolean; content: "inline" | "block" | null }>()

  const visit = (node: PMJSON, inlineContext: boolean) => {
    if (!node || typeof node !== "object" || typeof node.type !== "string") return
    const children = Array.isArray(node.content) ? node.content : []
    const childrenInline = children.some(
      (child) => child?.type === "text" || (child?.type ? base.nodes[child.type]?.isInline : false),
    )
    if (!base.nodes[node.type]) {
      const entry = seen.get(node.type) ?? { attrs: new Set<string>(), inline: inlineContext, content: null }
      Object.keys(node.attrs ?? {}).forEach((key) => entry.attrs.add(key))
      if (children.length > 0) entry.content ??= childrenInline ? "inline" : "block"
      seen.set(node.type, entry)
    }
    children.forEach((child) => visit(child, childrenInline))
  }
  roots.forEach((root) => visit(root as PMJSON, false))

  if (seen.size === 0) return base

  let nodes = base.spec.nodes
  for (const [name, { attrs, inline, content }] of seen) {
    const spec: NodeSpec = {
      group: inline ? "inline" : "block",
      inline,
      content: content === null ? "" : content === "inline" ? "inline*" : "block*",
      marks: "_",
      attrs: Object.fromEntries([...attrs, "data-block-id"].map((key) => [key, { default: null }])),
    }
    nodes = nodes.addToEnd(name, spec)
  }
  return new Schema({ nodes, marks: base.spec.marks, topNode: base.spec.topNode })
}
