import { describe, it, expect, afterEach } from "vitest"
import * as Y from "yjs"
import { Editor, Node } from "@tiptap/core"
import Collaboration, { isChangeOrigin } from "@tiptap/extension-collaboration"
import type { BlockDocV1 } from "../blocks-spec"
import { blockDocToPM, pmToBlockDoc } from "./blockBridge"
import { getCoreSchema, schemaExtensions, schemaWithStandIns } from "./schema"
import { EDITOR_FRAGMENT, fragmentToBlockDoc, seedFragment } from "./fragmentBridge"
import { ids, richDoc } from "./fragmentBridge.fixtures"

// The client side of server seeding (#206): editors bound to a doc the server seeded
// must show the block doc, must not rewrite it (no id re-stamping, no churn), and
// their edits must come back out of the server's store.

// Stands in for a theme extension (like themes/example's alert), minus the NodeView.
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

const editors: Editor[] = []
afterEach(() => {
  while (editors.length) editors.pop()!.destroy()
})

function makeEditor(doc: Y.Doc, { theme = true } = {}): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      ...Object.values(schemaExtensions({ collaborating: true })),
      ...(theme ? [Callout] : []),
      Collaboration.configure({ document: doc }),
    ],
  })
  editors.push(editor)
  return editor
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Relays updates between the server doc and a client doc, counting the client's own. */
function connect(server: Y.Doc, client: Y.Doc) {
  const fromClient = { updates: 0 }
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server), "relay")
  server.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin !== client) Y.applyUpdate(client, u, server)
  })
  client.on("update", (u: Uint8Array, origin: unknown) => {
    if (origin === server || origin === "relay") return
    fromClient.updates++
    Y.applyUpdate(server, u, client)
  })
  return fromClient
}

const base = getCoreSchema()
const canonical = (doc: BlockDocV1) => {
  const roots = Object.values(doc.blocks).map((block) => (block.attrs as any)?.pm).filter(Boolean)
  return pmToBlockDoc(blockDocToPM(doc, schemaWithStandIns(base, roots)))
}

function serverSeeded(doc: BlockDocV1) {
  const server = new Y.Doc()
  seedFragment(doc, server.getXmlFragment(EDITOR_FRAGMENT), base)
  return server
}

describe("editors on a server-seeded doc (#206)", () => {
  it("show exactly the block doc, without the client seeding anything", async () => {
    const doc = canonical(richDoc())
    const server = serverSeeded(doc)
    const client = new Y.Doc()
    connect(server, client)
    const editor = makeEditor(client)
    await settle()

    expect(editor.getJSON()).toEqual(blockDocToPM(doc, editor.schema).toJSON())
  })

  it("binding an editor changes nothing in the doc (no id re-stamping, no churn)", async () => {
    const server = serverSeeded(canonical(richDoc()))
    const client = new Y.Doc()
    const fromClient = connect(server, client)
    const editor = makeEditor(client)
    let localChanges = 0
    editor.on("transaction", ({ transaction, appendedTransactions }) => {
      for (const tr of [transaction, ...(appendedTransactions ?? [])]) {
        if (tr.docChanged && !isChangeOrigin(tr)) localChanges++
      }
    })
    await settle()

    expect(fromClient.updates).toBe(0)
    expect(localChanges).toBe(0)
  })

  it("an edit in the editor comes back out of the server's store, ids unchanged", async () => {
    const doc = canonical(richDoc())
    const server = serverSeeded(doc)
    const client = new Y.Doc()
    connect(server, client)
    const editor = makeEditor(client)
    await settle()

    editor.commands.insertContentAt(1, "Edited. ")
    await settle()

    const stored = fragmentToBlockDoc(server.getXmlFragment(EDITOR_FRAGMENT), base)
    expect(stored.blocks_order).toEqual(doc.blocks_order)
    expect((stored.blocks[ids.intro].attrs as any).text).toBe("Edited. Plain, bold and a link")
    expect(stored.blocks[ids.callout]).toEqual(doc.blocks[ids.callout])
  })

  it("two editors on one server-seeded doc converge", async () => {
    const server = serverSeeded(canonical(richDoc()))
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    connect(server, docA)
    connect(server, docB)
    const a = makeEditor(docA)
    const b = makeEditor(docB)
    await settle()

    a.commands.insertContentAt(1, "A ")
    b.commands.insertContentAt(b.state.doc.content.size - 1, "!")
    await settle()

    expect(b.getJSON()).toEqual(a.getJSON())
    const stored = fragmentToBlockDoc(server.getXmlFragment(EDITOR_FRAGMENT), base)
    expect((stored.blocks[ids.intro].attrs as any).text).toMatch(/^A Plain/)
    expect((stored.blocks[ids.outro].attrs as any).text).toBe("The end!")
  })
})

describe("y-tiptap deletes nodes a client's schema can't build (hazard, #206)", () => {
  // y-tiptap's createNodeFromYElement catches the error from schema.node() and DELETES
  // the element from the shared doc, so every peer and the next store lose it. Today
  // the editor waits for the theme (#198), but a failed theme load still mounts it,
  // and so does a post holding blocks of a theme that is no longer active. This pins
  // the behaviour so a guard (refuse to bind, or bind read-only, when the doc holds
  // unknown node types) is tested against the real thing.
  it("an editor without the theme extension removes the theme block for everyone", async () => {
    const server = serverSeeded(canonical(richDoc()))
    const client = new Y.Doc()
    connect(server, client)
    makeEditor(client, { theme: false })
    await settle()

    const stored = fragmentToBlockDoc(server.getXmlFragment(EDITOR_FRAGMENT), base)
    expect(stored.blocks[ids.callout]).toBeUndefined()
    expect(stored.blocks_order).not.toContain(ids.callout)
  })
})
