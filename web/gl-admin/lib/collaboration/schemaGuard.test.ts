import { describe, it, expect, afterEach } from "vitest"
import * as Y from "yjs"
import { Editor, Mark, Node, getSchema, type AnyExtension } from "@tiptap/core"
import StarterKit from "@tiptap/starter-kit"
import Collaboration from "@tiptap/extension-collaboration"
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap"
import { BlockIdExtension } from "../../components/editor/extensions/BlockIdExtension"
import { EDITOR_FRAGMENT, describeUnbuildableTypes, findUnbuildableTypes } from "./schemaGuard"

// y-tiptap 3.0.0 deletes Y elements an editor's schema can't build (#206/#274). These
// tests pin that hazard against the real binding and prove the guard sees it first.

// Stands in for a theme block (like themes/example's alert), minus the NodeView.
const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "inline*",
  addAttributes() {
    return { "data-block-id": { default: null }, variant: { default: "info" } }
  },
  parseHTML: () => [{ tag: "div[data-type=callout]" }],
  renderHTML: () => ["div", { "data-type": "callout" }, 0],
})

// Stands in for a theme mark.
const Highlight = Mark.create({
  name: "highlight",
  parseHTML: () => [{ tag: "mark" }],
  renderHTML: () => ["mark", 0],
})

const base: AnyExtension[] = [StarterKit.configure({ undoRedo: false }), BlockIdExtension]
const themed = [...base, Callout, Highlight]

const content = {
  type: "doc",
  content: [
    { type: "paragraph", attrs: { "data-block-id": "intro-block-0001" }, content: [{ type: "text", text: "Intro" }] },
    {
      type: "callout",
      attrs: { "data-block-id": "callout-block-01", variant: "warning" },
      content: [{ type: "text", text: "Mind the gap" }],
    },
    { type: "paragraph", attrs: { "data-block-id": "outro-block-0001" }, content: [{ type: "text", text: "The end" }] },
  ],
}

const marked = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { "data-block-id": "marked-block-001" },
      content: [{ type: "text", text: "Hot take", marks: [{ type: "highlight" }] }],
    },
  ],
}

/** A doc the server holds, written by a peer whose editor has the theme. */
function serverDoc(json: object) {
  const server = new Y.Doc()
  prosemirrorJSONToYXmlFragment(getSchema(themed), json, server.getXmlFragment(EDITOR_FRAGMENT))
  return server
}

/** Relays updates both ways between the server doc and a client doc. */
function connect(server: Y.Doc, client: Y.Doc) {
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server), server)
  server.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin !== client) Y.applyUpdate(client, u, server)
  })
  client.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin !== server) Y.applyUpdate(server, u, client)
  })
}

const nodeTypes = (doc: Y.Doc) =>
  doc
    .getXmlFragment(EDITOR_FRAGMENT)
    .toArray()
    .map((el) => (el as Y.XmlElement).nodeName)

const editors: Editor[] = []
afterEach(() => {
  while (editors.length) editors.pop()!.destroy()
})

function bind(doc: Y.Doc, extensions: AnyExtension[]) {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [...extensions, Collaboration.configure({ document: doc })],
  })
  editors.push(editor)
  return editor
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("y-tiptap deletes what a client's schema can't build (hazard)", () => {
  it("an editor without the theme extension removes the theme block for everyone", async () => {
    const server = serverDoc(content)
    const client = new Y.Doc()
    connect(server, client)
    bind(client, base)
    await settle()

    expect(nodeTypes(server)).toEqual(["paragraph", "paragraph"])
  })

  it("an editor without the theme mark removes the marked text for everyone", async () => {
    const server = serverDoc(marked)
    const client = new Y.Doc()
    connect(server, client)
    bind(client, base)
    await settle()

    expect(server.getXmlFragment(EDITOR_FRAGMENT).toString()).not.toContain("Hot take")
  })

  it("an editor with the theme keeps the block (control)", async () => {
    const server = serverDoc(content)
    const client = new Y.Doc()
    connect(server, client)
    bind(client, themed)
    await settle()

    expect(nodeTypes(server)).toEqual(["paragraph", "callout", "paragraph"])
  })
})

describe("findUnbuildableTypes", () => {
  it("names unknown node types", () => {
    const fragment = serverDoc(content).getXmlFragment(EDITOR_FRAGMENT)
    expect(findUnbuildableTypes(fragment, getSchema(base))).toEqual({ nodes: ["callout"], marks: [] })
  })

  it("names unknown marks", () => {
    const fragment = serverDoc(marked).getXmlFragment(EDITOR_FRAGMENT)
    expect(findUnbuildableTypes(fragment, getSchema(base))).toEqual({ nodes: [], marks: ["highlight"] })
  })

  it("finds types nested below the top level", () => {
    const nested = {
      type: "doc",
      content: [
        {
          type: "blockquote",
          attrs: { "data-block-id": "quote-block-0001" },
          content: [{ type: "callout", attrs: { "data-block-id": "callout-block-02" } }],
        },
      ],
    }
    const fragment = serverDoc(nested).getXmlFragment(EDITOR_FRAGMENT)
    expect(findUnbuildableTypes(fragment, getSchema(base))?.nodes).toEqual(["callout"])
  })

  it("returns null when the schema can build everything, and for an empty doc", () => {
    expect(findUnbuildableTypes(serverDoc(content).getXmlFragment(EDITOR_FRAGMENT), getSchema(themed))).toBeNull()
    expect(findUnbuildableTypes(serverDoc(marked).getXmlFragment(EDITOR_FRAGMENT), getSchema(themed))).toBeNull()
    expect(findUnbuildableTypes(new Y.Doc().getXmlFragment(EDITOR_FRAGMENT), getSchema(base))).toBeNull()
  })

  it("does not modify the doc", () => {
    const server = serverDoc(content)
    let updates = 0
    server.on("update", () => updates++)
    findUnbuildableTypes(server.getXmlFragment(EDITOR_FRAGMENT), getSchema(base))
    expect(updates).toBe(0)
  })

  it("describes the result for the notice", () => {
    expect(describeUnbuildableTypes({ nodes: ["callout"], marks: [] })).toBe("callout (block)")
    expect(describeUnbuildableTypes({ nodes: ["a", "b"], marks: ["highlight"] })).toBe(
      "a, b (blocks); highlight (formatting)"
    )
  })
})
