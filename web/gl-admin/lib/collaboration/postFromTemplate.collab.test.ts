import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import * as Y from "yjs"
import { Editor } from "@tiptap/core"
import Collaboration from "@tiptap/extension-collaboration"
import { schemaExtensions } from "./schema"
import { startRelay, waitFor, type Relay } from "./hocuspocusRelay.testkit"
import { installedThemeBlocks } from "../theme-blocks/installed"
import type { BlockDocV1 } from "../blocks-spec"
import vectors from "./duplicatePost.vectors.json"

// A post made from a template (#322) on the real collab server (in process). A template
// is not a post and has no live document: POST /post-templates/:id/posts gives the new
// post the template's block_doc with every block id new (the same Go function as a
// duplicate, #354), and no Yjs state. So the server seeds it through its ordinary load
// path, like any new post created with a body (#283), and people then edit it as usual.
// Two posts from one template are two documents: their own ids, their own epochs.
//
// The docs are the duplicate test's: `source` stands for the template's content and
// `duplicate` for what the API stores for the new post (TestDuplicatePostVectors and
// TestPostTemplatesAPI check the API follows that rule). A second post from the same
// template gets the same content under other new ids.

const template = vectors.source as unknown as BlockDocV1
const fromTemplate = vectors.duplicate as unknown as BlockDocV1
const FIRST_ID = 21
const SECOND_ID = 22

// The same content under ids of its own: a second post from the template.
function withNewIds(doc: BlockDocV1, prefix: string): BlockDocV1 {
  let json = JSON.stringify(doc)
  for (const id of collectIds(doc)) json = json.split(`"${id}"`).join(`"${prefix}-${id}"`)
  return JSON.parse(json)
}

function collectIds(doc: BlockDocV1): string[] {
  const ids = new Set<string>(Object.keys(doc.blocks))
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === "object") {
      for (const [k, value] of Object.entries(v)) {
        if (k === "data-block-id" && typeof value === "string") ids.add(value)
        else walk(value)
      }
    }
  }
  walk(doc.blocks)
  return [...ids]
}

const editors: Editor[] = []

function makeEditor(doc: Y.Doc): Editor {
  const element = document.createElement("div")
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: [
      ...Object.values(schemaExtensions({ collaborating: true })),
      ...installedThemeBlocks.map((block) => block.node),
      Collaboration.configure({ document: doc }),
    ],
  })
  editors.push(editor)
  return editor
}

function blockIds(editor: Editor): string[] {
  const ids: string[] = []
  editor.state.doc.descendants((node) => {
    const id = node.attrs["data-block-id"]
    if (typeof id === "string") ids.push(id)
  })
  return ids
}

const templateIds = collectIds(template)

describe("a post made from a template on the Hocuspocus relay (#322)", () => {
  let relay: Relay
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    // The relay's own post is unrelated; the template never reaches the collab server.
    relay = await startRelay({ blockDoc: template, revision: 1 })
  })
  afterEach(async () => {
    while (editors.length) editors.pop()!.destroy()
    await relay.destroy()
    vi.restoreAllMocks()
  })

  it("seeds from its block_doc and two users collaborate on it normally", async () => {
    relay.api.addPost(String(FIRST_ID), fromTemplate, 1)
    expect(relay.api.posts.get(String(FIRST_ID))!.state).toBeNull()

    const pa = relay.client("1", { postId: FIRST_ID })
    const pb = relay.client("2", { postId: FIRST_ID })
    await Promise.all([pa.whenSynced(), pb.whenSynced()])
    const a = makeEditor(pa.doc)
    const b = makeEditor(pb.doc)
    await waitFor(() => a.getText().includes("The end") && b.getText().includes("The end"), { what: "both to load the post" })

    // The template's content under the post's own ids.
    for (const text of ["Plain and bold", "A heading", "The caption", "First item", "Second item", "The end"]) {
      expect(a.getText()).toContain(text)
    }
    const ids = blockIds(a)
    for (const id of fromTemplate.blocks_order) expect(ids).toContain(id)
    for (const id of templateIds) expect(ids).not.toContain(id)
    expect(blockIds(b)).toEqual(ids)
    expect(typeof pa.doc.getMap("meta").get("epoch")).toBe("string")

    // The seed is stored as state only; then both users edit and the store keeps the ids.
    await waitFor(() => relay.api.puts.some((put) => put.postId === String(FIRST_ID)), { what: "the seed store" })
    expect(relay.api.puts.find((put) => put.postId === String(FIRST_ID))!.body.block_doc).toBeUndefined()

    a.commands.insertContentAt(1, "Hello from A. ")
    b.commands.insertContentAt(b.state.doc.content.size - 1, " And from B.")
    await waitFor(() => a.getText().includes("And from B.") && b.getText().includes("Hello from A."), { what: "each other's edits" })
    await waitFor(() => JSON.stringify(b.state.doc.toJSON()) === JSON.stringify(a.state.doc.toJSON()), { what: "convergence" })

    const stored = () => relay.api.posts.get(String(FIRST_ID))!.block_doc!
    await waitFor(() => JSON.stringify(stored()).includes("Hello from A.") && JSON.stringify(stored()).includes("And from B."), {
      what: "the post's store",
    })
    const doc = stored()
    expect(doc.blocks_order.slice(0, fromTemplate.blocks_order.length)).toEqual(fromTemplate.blocks_order)
    for (const id of templateIds) expect(JSON.stringify(doc)).not.toContain(`"${id}"`)
  })

  it("two posts from one template are separate documents", async () => {
    const second = withNewIds(fromTemplate, "second")
    relay.api.addPost(String(FIRST_ID), fromTemplate, 1)
    relay.api.addPost(String(SECOND_ID), second, 1)

    const p1 = relay.client("1", { postId: FIRST_ID })
    const p2 = relay.client("2", { postId: SECOND_ID })
    await Promise.all([p1.whenSynced(), p2.whenSynced()])
    const one = makeEditor(p1.doc)
    const two = makeEditor(p2.doc)
    await waitFor(() => one.getText().includes("The end") && two.getText().includes("The end"), { what: "both posts to load" })

    expect(p1.doc.getMap("meta").get("epoch")).not.toBe(p2.doc.getMap("meta").get("epoch"))
    const firstIds = blockIds(one)
    for (const id of blockIds(two)) expect(firstIds).not.toContain(id)

    one.commands.insertContentAt(1, "Only in the first. ")
    await waitFor(() => JSON.stringify(relay.api.posts.get(String(FIRST_ID))!.block_doc).includes("Only in the first."), {
      what: "the first post's store",
    })
    expect(two.getText()).not.toContain("Only in the first.")
    expect(JSON.stringify(relay.api.posts.get(String(SECOND_ID))!.block_doc)).not.toContain("Only in the first.")
  })
})
