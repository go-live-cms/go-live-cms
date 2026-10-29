import { getSchema, type AnyExtension } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import Link from "@tiptap/extension-link"
import TextAlign from "@tiptap/extension-text-align"
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight"
import { createLowlight, common } from "lowlight"
import { Schema, type MarkSpec, type NodeSpec } from "prosemirror-model"
import { ImageWithMediaId } from "../../components/editor/extensions/ImageWithMediaId"
import { BlockIdExtension } from "../../components/editor/extensions/BlockIdExtension"
import { QuoteCitation } from "../../components/editor/extensions/QuoteCitation"

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
    quoteCitation: QuoteCitation,
    blockId: BlockIdExtension,
  }
}

const collabSchemas = new Map<string, Schema>()

/**
 * The editor's schema built headlessly: the core extensions plus `themeExtensions`, a
 * theme's **headless** node definitions (no NodeView, so no React import; see
 * `themes/example/blocks/Alert/AlertSchema.ts`). A theme block with a real definition
 * here is checked like any core block; one without gets a stand-in
 * (schemaWithStandIns). Cached per extension list: building a schema is not free and the
 * result is immutable.
 */
export function getCollabSchema(themeExtensions: AnyExtension[] = []): Schema {
  const key = themeExtensions.map((extension) => extension.name).join(",")
  let schema = collabSchemas.get(key)
  if (!schema) {
    schema = getSchema([...Object.values(schemaExtensions({ collaborating: true })), ...themeExtensions])
    collabSchemas.set(key, schema)
  }
  return schema
}

/** The editor's core schema (no theme blocks), built headlessly. */
export function getCoreSchema(): Schema {
  return getCollabSchema()
}

interface PMJSON {
  type?: string
  attrs?: Record<string, unknown>
  content?: PMJSON[]
  marks?: { type?: string; attrs?: Record<string, unknown> }[]
}

interface NodeStandIn {
  attrs: Set<string>
  inline: boolean
  content: "inline" | "block" | null
}

const standInSchemas = new WeakMap<Schema, Map<string, Schema>>()

/**
 * `base` plus a permissive stand-in for every node and mark type in `roots` (ProseMirror
 * JSON, e.g. a block doc's `attrs.pm` values or `yXmlFragmentToProsemirrorJSON` output)
 * that `base` doesn't know: in practice, theme blocks and marks (#206).
 *
 * Why: the collab server can only load a theme's headless definitions (getCollabSchema),
 * and a theme may not ship them, but it must never lose theme content. Without a type,
 * `blockDocToPMWithReport` drops the block (nodeFromJSON throws on an unknown type) and
 * `fragmentToBlockDoc` can't build it. A stand-in keeps the node or mark and its
 * attributes exactly as stored; the editor still renders it with the real extension.
 *
 * A node stand-in declares every attribute seen on that type (default null, like an
 * attribute the Yjs binding omitted) plus `data-block-id`. It is inline when it sits in
 * inline content (the parent's content type when the parent is known, else next to
 * text), takes inline or block content as observed, and allows every mark. A mark
 * stand-in declares the attributes seen on it. Stand-ins check nothing a theme's real
 * definition would; that is what headless theme definitions are for.
 *
 * Cached per base schema and stand-in set, so repeated stores of the same doc reuse one
 * schema.
 */
export function schemaWithStandIns(base: Schema, roots: unknown[]): Schema {
  const nodes = new Map<string, NodeStandIn>()
  const marks = new Map<string, Set<string>>()

  const visit = (node: PMJSON, inlineContext: boolean) => {
    if (!node || typeof node !== "object" || typeof node.type !== "string") return
    node.marks?.forEach((mark) => {
      if (typeof mark?.type !== "string" || base.marks[mark.type]) return
      const attrs = marks.get(mark.type) ?? new Set<string>()
      Object.keys(mark.attrs ?? {}).forEach((key) => attrs.add(key))
      marks.set(mark.type, attrs)
    })
    if (node.type === "text") return

    const children = Array.isArray(node.content) ? node.content : []
    const known = base.nodes[node.type]
    const childrenInline = known
      ? known.inlineContent
      : children.some((child) => child?.type === "text" || (child?.type ? base.nodes[child.type]?.isInline : false))
    if (!known) {
      const entry = nodes.get(node.type) ?? { attrs: new Set<string>(), inline: inlineContext, content: null }
      Object.keys(node.attrs ?? {}).forEach((key) => entry.attrs.add(key))
      if (children.length > 0) entry.content ??= childrenInline ? "inline" : "block"
      nodes.set(node.type, entry)
    }
    children.forEach((child) => visit(child, childrenInline))
  }
  roots.forEach((root) => visit(root as PMJSON, false))

  if (nodes.size === 0 && marks.size === 0) return base

  const sorted = (set: Set<string>) => [...set].sort()
  const key = JSON.stringify([
    [...nodes].map(([name, entry]) => [name, sorted(entry.attrs), entry.inline, entry.content]).sort(),
    [...marks].map(([name, attrs]) => [name, sorted(attrs)]).sort(),
  ])
  const cache = standInSchemas.get(base) ?? new Map<string, Schema>()
  standInSchemas.set(base, cache)
  const cached = cache.get(key)
  if (cached) return cached

  const nullDefaults = (names: Iterable<string>) => Object.fromEntries([...names].map((name) => [name, { default: null }]))
  let nodeSpecs = base.spec.nodes
  for (const [name, { attrs, inline, content }] of nodes) {
    const spec: NodeSpec = {
      group: inline ? "inline" : "block",
      inline,
      content: content === null ? "" : content === "inline" ? "inline*" : "block*",
      marks: "_",
      attrs: nullDefaults([...attrs, "data-block-id"]),
    }
    nodeSpecs = nodeSpecs.addToEnd(name, spec)
  }
  let markSpecs = base.spec.marks
  for (const [name, attrs] of marks) {
    const spec: MarkSpec = { attrs: nullDefaults(attrs) }
    markSpecs = markSpecs.addToEnd(name, spec)
  }
  const schema = new Schema({ nodes: nodeSpecs, marks: markSpecs, topNode: base.spec.topNode })
  cache.set(key, schema)
  return schema
}
