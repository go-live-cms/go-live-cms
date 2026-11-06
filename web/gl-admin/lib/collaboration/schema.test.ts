import { describe, it, expect } from "vitest"
import { getSchema } from "@tiptap/core"
import type { Schema } from "prosemirror-model"
import { getExtensions } from "@gl-admin/components/editor/utils/extensions"
import { getCoreSchema, schemaExtensions, schemaWithStandIns } from "./schema"
import { schemaFingerprint } from "./schemaFingerprint"
import { editorSchemaFingerprint } from "@gl-admin/components/editor/utils/editorSchema"
import { getInstalledCollabSchema } from "../theme-blocks/collabSchema"
import { installedThemeBlocks } from "../theme-blocks/installed"

/** Everything about a schema that decides which docs it accepts, as plain data. */
function describeSchema(schema: Schema) {
  const attrs = (spec: Record<string, { default?: unknown }> | undefined) =>
    Object.fromEntries(Object.entries(spec ?? {}).map(([name, attr]) => [name, attr.default ?? null]))
  return {
    topNode: schema.topNodeType.name,
    nodes: Object.values(schema.nodes).map((type) => ({
      name: type.name,
      content: type.spec.content ?? "",
      group: type.spec.group ?? "",
      inline: type.isInline,
      atom: type.isAtom,
      marks: type.spec.marks ?? null,
      attrs: attrs(type.spec.attrs as any),
    })),
    marks: Object.values(schema.marks).map((type) => ({
      name: type.name,
      excludes: type.spec.excludes ?? null,
      attrs: attrs(type.spec.attrs as any),
    })),
  }
}

describe("collab schema parity (#206)", () => {
  // The collab server converts with getInstalledCollabSchema() (the core schema plus every
  // installed theme block, #376); the editor with its full extension list. If they differ,
  // the server seeds or stores docs the editor reads differently.
  it("the editor's schema is exactly the collab server's", () => {
    const editorSchema = getSchema(getExtensions({ collabProvider: null })())
    expect(describeSchema(editorSchema)).toEqual(describeSchema(getInstalledCollabSchema()))
  })

  // #416: the server refuses an editor whose fingerprint isn't its own, so the admin bundle
  // and the collab bundle built from one commit must agree, or nobody could connect.
  it("the editor's schema fingerprint is exactly the collab server's", () => {
    const serverFingerprint = schemaFingerprint(getInstalledCollabSchema())
    expect(schemaFingerprint(getSchema(getExtensions({ collabProvider: null })()))).toBe(serverFingerprint)
    // What the admin sends (postCollab.ts): the editor's own schema (editorSchema.ts).
    expect(editorSchemaFingerprint()).toBe(serverFingerprint)
    // Collaborating or not (StarterKit's undo/redo registers no schema).
    const solo = getSchema(Object.values(schemaExtensions({ collaborating: false })))
    expect(schemaFingerprint(solo)).toBe(schemaFingerprint(getCoreSchema()))
    expect(serverFingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it("the collab server's schema is the core schema plus the installed theme blocks, and nothing else", () => {
    const core = Object.keys(getCoreSchema().nodes)
    const installed = Object.keys(getInstalledCollabSchema().nodes)
    expect(installed.filter((name) => !core.includes(name))).toEqual(installedThemeBlocks.map((block) => block.type))
    expect(installed).toContain("theme:example/alert")
  })

  it("collaborating or not, the schema is the same", () => {
    const solo = getSchema(Object.values(schemaExtensions({ collaborating: false })))
    expect(describeSchema(solo)).toEqual(describeSchema(getCoreSchema()))
  })

  it("covers every block type the bridge writes, with h1-h6 and block ids", () => {
    const schema = getCoreSchema()
    for (const name of ["paragraph", "heading", "blockquote", "codeBlock", "horizontalRule", "image", "bulletList", "orderedList", "listItem"]) {
      expect(schema.nodes[name], name).toBeDefined()
      expect(schema.nodes[name].spec.attrs?.["data-block-id"], `${name} data-block-id`).toBeDefined()
    }
    expect(schema.nodes.image.spec.attrs?.mediaId).toBeDefined()
    expect(() => schema.node("heading", { level: 6 }, schema.text("x")).check()).not.toThrow()
  })
})

describe("schemaWithStandIns", () => {
  const base = getCoreSchema()

  it("returns the base schema when every node type is known", () => {
    expect(schemaWithStandIns(base, [{ type: "paragraph", content: [{ type: "text", text: "x" }] }])).toBe(base)
  })

  it("adds a block stand-in that keeps a theme node's attributes and inline content", () => {
    const sidenote = {
      type: "sidenote",
      attrs: { "data-block-id": "blk-sidenote-0001", variant: "warn", message: "Careful" },
      content: [{ type: "text", text: "Hi", marks: [{ type: "bold" }] }],
    }
    const schema = schemaWithStandIns(base, [sidenote])
    const node = schema.nodeFromJSON(sidenote)
    expect(() => node.check()).not.toThrow()
    expect(node.toJSON()).toEqual(sidenote)
    expect(schema.nodes.sidenote.isBlock).toBe(true)
  })

  it("adds a leaf stand-in for a theme node seen without content", () => {
    const schema = schemaWithStandIns(base, [{ type: "embed", attrs: { url: "https://x.test" } }])
    expect(schema.nodes.embed.isLeaf).toBe(true)
    expect(schema.nodeFromJSON({ type: "embed", attrs: { url: "https://x.test" } }).attrs.url).toBe("https://x.test")
  })

  it("makes a theme node found inside text an inline stand-in", () => {
    const paragraph = {
      type: "paragraph",
      content: [{ type: "text", text: "a " }, { type: "mention", attrs: { userId: 7 } }],
    }
    const schema = schemaWithStandIns(base, [{ type: "doc", content: [paragraph] }])
    expect(schema.nodes.mention.isInline).toBe(true)
    expect(() => schema.nodeFromJSON(paragraph).check()).not.toThrow()
  })

  it("makes a theme node that is a textblock's only child inline (the parent decides, not its siblings)", () => {
    const paragraph = { type: "paragraph", attrs: { "data-block-id": "blk-mention-001" }, content: [{ type: "mention", attrs: { userId: 7 } }] }
    const schema = schemaWithStandIns(base, [paragraph])
    expect(schema.nodes.mention.isInline).toBe(true)
    expect(() => schema.nodeFromJSON(paragraph).check()).not.toThrow()
  })

  it("adds a mark stand-in for a theme mark, keeping its attributes", () => {
    const paragraph = {
      type: "paragraph",
      // In schema rank order (stand-ins come last), since toJSON() writes marks that way.
      content: [{ type: "text", text: "hi", marks: [{ type: "bold" }, { type: "highlight", attrs: { color: "yellow" } }] }],
    }
    const schema = schemaWithStandIns(base, [paragraph])
    expect(schema.marks.highlight).toBeDefined()
    expect(schema.nodes.paragraph).toBeDefined()
    expect(schema.nodeFromJSON(paragraph).toJSON()).toMatchObject(paragraph)
  })

  it("reuses the schema for the same stand-ins and builds a new one when they change", () => {
    const sidenote = (attrs: Record<string, unknown>) => ({ type: "sidenote", attrs, content: [{ type: "text", text: "x" }] })
    const first = schemaWithStandIns(base, [sidenote({ variant: "a" })])
    expect(schemaWithStandIns(base, [sidenote({ variant: "b" })])).toBe(first)
    expect(schemaWithStandIns(base, [sidenote({ variant: "a", icon: "i" })])).not.toBe(first)
  })

  it("finds theme nodes nested inside core nodes and other theme nodes", () => {
    const tabs = {
      type: "tabs",
      content: [{ type: "tab", attrs: { title: "One" }, content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] }],
    }
    const schema = schemaWithStandIns(base, [{ type: "blockquote", content: [tabs] }])
    expect(schema.nodes.tabs).toBeDefined()
    expect(schema.nodes.tab.spec.attrs?.title).toBeDefined()
    // toJSON() adds the defaulted attrs (data-block-id, textAlign), so match, not equal.
    expect(schema.nodeFromJSON(tabs).toJSON()).toMatchObject(tabs)
  })
})
